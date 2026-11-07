import { readFile } from "node:fs/promises";
import { Classifier } from "../src/classifier.js";
import { env, loadConfig } from "../src/config.js";
import { errorCode, log } from "../src/errors.js";

// Explicit local preview: sends only the supplied text to the selected provider.
// Never reads or mutates Gmail, never writes the sample or response to disk.
async function main() {
  const [accountId, path] = process.argv.slice(2);
  if (!accountId || !path) throw new Error("Usage: bun run preview <account-id> <plain-text-file>");
  const config = await loadConfig();
  const account = config.accounts.find(a => a.id === accountId);
  if (!account) throw new Error("Unknown account");
  const bytes = await readFile(path);
  if (bytes.length > 262_144) throw new Error("Sample too large");
  const text = bytes.toString("utf8");
  const result = await new Classifier(config.provider, env("CLASSIFIER_API_KEY")).classify(account, {
    from: "", to: "", subject: "", receivedAt: "",
    body: text, truncated: false, bodyUnavailable: !text.trim(), originalBytes: bytes.length,
  });
  console.log(JSON.stringify({ previewOnly: true, ...result }, null, 2));
}
main().catch(error => {
  log("preview_failed", { code: errorCode(error) });
  process.exitCode = 1;
});
