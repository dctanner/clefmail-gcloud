import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import { env, loadConfig } from "../src/config.js";
import { errorCode, log, SafeError } from "../src/errors.js";
import { verifyMailbox } from "../src/gmail.js";
import { createProcessor, gmailFor } from "../src/runtime.js";
import type { InboxOutcome } from "../src/processor.js";

const outcomes = z.enum(["archived", "inbox", "flagged", "skipped"]);
const snapshotSchema = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/));

async function main() {
  const [accountId, runName] = process.argv.slice(2);
  if (!runName || !/^[a-zA-Z0-9_-]{1,100}$/.test(runName)) throw new SafeError("invalid_inbox_run");
  const config = await loadConfig();
  const account = config.accounts.find(a => a.id === accountId && a.enabled);
  if (!account) throw new SafeError("unknown_or_disabled_mailbox");
  const gmail = gmailFor(account);
  await verifyMailbox(gmail, account);
  const labels = await gmail.labels(account);
  const processor = createProcessor(config);
  const bucket = new Storage().bucket(env("STATE_BUCKET"));
  const prefix = `inbox-runs/${account.id}/${runName}/`;
  async function read(name: string) {
    try {
      const [bytes] = await bucket.file(prefix + name).download();
      return JSON.parse(bytes.toString("utf8"));
    } catch (error: any) {
      if (error.code === 404) return null;
      throw error;
    }
  }
  async function create(name: string, value: unknown) {
    await bucket.file(prefix + name).save(JSON.stringify(value), {
      resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  }
  // Finish pagination before the first archive changes Gmail's result pages.
  let snapshot = await read("messages.json");
  if (snapshot === null) {
    const ids = await gmail.inboxSnapshot();
    try { await create("messages.json", ids); }
    catch (error: any) { if (error.code !== 412) throw error; }
    snapshot = await read("messages.json");
  }
  const ids = snapshotSchema.parse(snapshot);
  const journal = {
    async read(id: string) {
      const value = await read(`results/${id}.json`);
      return value === null ? null : outcomes.parse(value);
    },
    save: (id: string, outcome: InboxOutcome) => create(`results/${id}.json`, outcome),
  };
  const counts = { archived: 0, inbox: 0, flagged: 0, skipped: 0 };
  log("inbox_run_started", { account: account.id, run: runName, total: ids.length, provider: config.provider.kind });
  for (const id of ids) {
    const outcome = await processor.processInboxItem(account, id, gmail, labels, journal);
    counts[outcome]++;
    if (outcome === "flagged") log("inbox_pitch_flagged", { account: account.id, run: runName, message: id });
  }
  log("inbox_run_finished", { account: account.id, run: runName, total: ids.length, ...counts });
}
main().catch(error => {
  log("inbox_run_failed", { code: errorCode(error) });
  process.exitCode = 1;
});
