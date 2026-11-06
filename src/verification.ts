import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import type { Account, Config } from "./config.js";
import { HttpError, SafeError } from "./errors.js";
import type { GmailPort, LabelMap } from "./gmail.js";
import { verifyMailbox } from "./gmail.js";
import { header, mayChallenge, senderOf } from "./sender.js";
import { MailboxSession, type StateStore } from "./state.js";
import { BimiPolicy } from "./bimi.js";
import type { Message } from "./text.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const VERIFICATION_TEST_SUBJECT = "Human verification test";
export function isVerificationTest(account: Account, message: Message): boolean {
  const subjects = message.payload?.headers?.filter(h => h.name.toLowerCase() === "subject") || [];
  return account.humanVerificationTest && subjects.length === 1 && subjects[0]!.value === VERIFICATION_TEST_SUBJECT;
}
function senderKey(account: Account, message: Message, sender: string): string {
  return digest(isVerificationTest(account, message) ? `test:${sender}:${message.id}` : sender);
}
const pendingSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), restore: z.boolean() });
const senderSchema = z.object({
  email: z.string().email(),
  status: z.enum(["pending", "verifying", "verified"]),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  expiresAt: z.number(),
  challenged: z.boolean(),
  successSent: z.boolean(),
  pending: z.array(pendingSchema).max(5000),
  test: z.boolean().default(false),
}).strict();
export type SenderRecord = z.infer<typeof senderSchema>;
export interface SenderSnapshot { record: SenderRecord; generation: string }
export interface SenderStore {
  read(account: string, key: string): Promise<SenderSnapshot | null>;
  write(account: string, key: string, record: SenderRecord, generation: string): Promise<void>;
}

export class GcsSenderStore implements SenderStore {
  private storage = new Storage({ retryOptions: { maxRetries: 2, totalTimeout: 10, maxRetryDelay: 1 } });
  constructor(private bucket: string) {}
  private file(account: string, key: string, generation?: string) {
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(account) || !/^[a-f0-9]{64}$/.test(key))
      throw new SafeError("invalid_sender_key");
    return this.storage.bucket(this.bucket).file(`senders/${account}/${key}.json`, { generation });
  }
  async read(account: string, key: string): Promise<SenderSnapshot | null> {
    let generation: string;
    try {
      const [metadata] = await this.file(account, key).getMetadata();
      if (!metadata.generation || Number(metadata.size) > 2_000_000) throw new SafeError("invalid_sender_state");
      generation = String(metadata.generation);
    } catch (error: any) { if (error?.code === 404) return null; throw error; }
    const [bytes] = await this.file(account, key, generation).download({ validation: "crc32c" });
    if (bytes.length > 2_000_000) throw new SafeError("invalid_sender_state");
    return { record: senderSchema.parse(JSON.parse(bytes.toString("utf8"))), generation };
  }
  async write(account: string, key: string, record: SenderRecord, generation: string): Promise<void> {
    try {
      await this.file(account, key).save(JSON.stringify(senderSchema.parse(record)), {
        resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: generation },
        metadata: { contentType: "application/json", cacheControl: "no-store" },
      });
    } catch (error: any) { if (error?.code === 412) throw new SafeError("sender_busy"); throw error; }
  }
}

export interface VerificationDependencies {
  senders: SenderStore;
  state: StateStore;
  gmail(account: Account, signal: AbortSignal): GmailPort;
  publicUrl: string;
  bimi?: Pick<BimiPolicy, "allows">;
  now?: () => number;
}

// Both processing and verification hold the SAME mailbox lease. Pending state is
// authoritative before history checks, so quarantined repeats never confer trust.
export class Verification {
  private now: () => number;
  private bimi: Pick<BimiPolicy, "allows">;
  constructor(private deps: VerificationDependencies) {
    this.now = deps.now || Date.now;
    this.bimi = deps.bimi || new BimiPolicy();
  }

  private async context(account: Account, key: string, session: MailboxSession) {
    let snapshot = await this.deps.senders.read(account.id, key);
    return {
      record: snapshot?.record,
      save: async (record: SenderRecord) => {
        await session.assertOwned();
        await this.deps.senders.write(account.id, key, record, snapshot?.generation || "0");
        snapshot = await this.deps.senders.read(account.id, key);
        if (!snapshot) throw new SafeError("sender_state_missing");
      },
    };
  }

  async quarantine(account: Account, message: Message, gmail: GmailPort, labels: LabelMap,
    session: MailboxSession): Promise<boolean> {
    const sender = senderOf(message);
    const test = isVerificationTest(account, message);
    if (!sender || (!test && sender === account.email)) return false;
    const key = senderKey(account, message, sender);
    const context = await this.context(account, key, session);
    let record = context.record;
    // Contact additions outside Clefmail also override quarantine immediately.
    const contact = !test && await gmail.hasContact(sender);
    if (record && (contact || record.status !== "pending")) {
      if (record.status !== "verified" || record.pending.length || !record.successSent)
        await this.finish(account, key, record, gmail, session, context.save);
      return false;
    }
    if (contact) return false;
    if (!test && await this.bimi.allows(message)) {
      // Exemption belongs to this authenticated message, never the whole sender.
      const held = record?.pending.find(item => item.id === message.id);
      if (held) {
        const current = await gmail.message(message.id!, "minimal");
        await session.assertOwned();
        await gmail.releaseHeld(message.id!, labels.held, held.restore &&
          !current.labelIds?.some(l => ["SPAM", "TRASH", "DRAFT", "INBOX"].includes(l)));
        record!.pending = record!.pending.filter(item => item.id !== message.id);
        await context.save(record!);
      }
      return false;
    }
    if (!test && !record && await gmail.hasCorresponded(sender, message)) return false;
    if (!record) {
      record = { email: sender, status: "pending", token: randomBytes(32).toString("base64url"),
        expiresAt: this.now() + 30 * 86400_000, challenged: false, successSent: false, pending: [], test };
    }
    const current = await gmail.message(message.id!, "minimal");
    if (current.labelIds?.some(l => ["SPAM", "TRASH", "DRAFT"].includes(l))) return true;
    if (!record.pending.some(item => item.id === message.id)) {
      if (record.pending.length >= 5000) throw new SafeError("sender_pending_limit");
      record.pending.push({ id: message.id!, restore: !!current.labelIds?.includes("INBOX") });
    }
    if (record.expiresAt <= this.now()) {
      record.token = randomBytes(32).toString("base64url");
      record.expiresAt = this.now() + 30 * 86400_000;
      record.challenged = false;
    }
    // Journal before Gmail effects. needsResume bypasses the processed marker
    // on retry until challenge delivery and verification effects finish.
    await context.save(record);
    if (!test && await gmail.hasContact(sender)) {
      await this.finish(account, key, record, gmail, session, context.save);
      return false;
    }
    await session.assertOwned();
    await gmail.modify(message.id!, [labels.processed, labels.held], ["INBOX"]);
    if (!record.challenged && mayChallenge(message, sender)) {
      const link = `${this.deps.publicUrl.replace(/\/$/, "")}/verify#${account.id}/${key}/${record.token}`;
      await session.assertOwned();
      await gmail.sendNotice(sender, "Please verify you are human", [
        `Your email to ${account.email} has been held outside the inbox.`,
        test ? "Please confirm you are human to release this test email:" :
          "Please confirm you are human to deliver your email and allow future messages:", link,
        "This link expires after 30 days. If you did not send this email, ignore this message.",
      ].join("\n\n"), digest(`challenge:${account.id}:${key}:${record.token}`), header(message, "Message-ID"));
      record.challenged = true;
      await context.save(record);
    }
    return true;
  }

  // Called BEFORE the processed-marker shortcut so interrupted challenge delivery
  // is retried even when the message was already archived/marked.
  async needsResume(account: Account, message: Message): Promise<boolean> {
    const sender = senderOf(message);
    if (!sender) return false;
    const record = (await this.deps.senders.read(account.id, senderKey(account, message, sender)))?.record;
    return !!record && (record.pending.some(item => item.id === message.id) ||
      record.status === "verifying" || (record.status === "verified" && !record.successSent));
  }

  async trusted(account: Account, sender: string): Promise<boolean> {
    const record = (await this.deps.senders.read(account.id, digest(sender)))?.record;
    return !!record && record.status !== "pending";
  }

  async complete(account: Account, key: string, token: string): Promise<void> {
    const session = await MailboxSession.acquire(this.deps.state, account.id, this.now);
    try {
      const context = await this.context(account, key, session);
      const record = context.record;
      if (!record || !(record.test ? account.humanVerificationTest : account.humanVerification) || token.length !== record.token.length ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(record.token)) ||
          (record.status === "pending" && record.expiresAt <= this.now()))
        throw new SafeError("invalid_verification_link");
      const gmail = this.deps.gmail(account, AbortSignal.timeout(240_000));
      await verifyMailbox(gmail, account);
      await this.finish(account, key, record, gmail, session, context.save);
    } finally { await session.release(); }
  }

  private async finish(account: Account, key: string, record: SenderRecord, gmail: GmailPort,
    session: MailboxSession, save: (record: SenderRecord) => Promise<void>): Promise<void> {
    if (record.status === "pending") { record.status = "verifying"; await save(record); }
    await session.assertOwned();
    if (!record.test) await gmail.addContact(record.email); // Test records never change sender trust.
    // Bounded state; each successful restore is checkpointed independently. A
    // deleted/spam/trashed message is never resurrected. Archived-by-filter mail
    // that was never in INBOX is deliberately not restored.
    const labels = record.pending.length ? await gmail.labels(account) : undefined;
    while (record.pending.length) {
      const item = record.pending[0]!;
      try {
        const message = await gmail.message(item.id, "minimal");
        const restoreInbox = item.restore && !message.labelIds?.some(l => ["SPAM", "TRASH", "DRAFT", "INBOX"].includes(l));
        if (restoreInbox || message.labelIds?.includes(labels!.held)) {
          await session.assertOwned();
          await gmail.releaseHeld(item.id, labels!.held, restoreInbox);
        }
      } catch (error) {
        if (!(error instanceof HttpError) || error.service !== "gmail" || error.status !== 404) throw error;
      }
      record.pending.shift();
      await save(record);
    }
    if (!record.successSent) {
      await session.assertOwned();
      await gmail.sendNotice(record.email, "Email verification successful", [
        `You are verified for ${account.email}. Your held inbox messages have been released.`,
      ].join("\n\n"), digest(`success:${account.id}:${key}`));
      record.successSent = true;
    }
    record.status = "verified";
    await save(record);
  }
}

export function verificationAccount(config: Config, id: string): Account | undefined {
  return config.accounts.find(a => a.id === id && a.enabled && (a.humanVerification || a.humanVerificationTest));
}
