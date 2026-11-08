import { setTimeout as delay } from "node:timers/promises";
import { HOLD_LABEL, type Account } from "./config.js";
import type { Decision } from "./decision.js";
import { errorCode, HttpError, log, SafeError } from "./errors.js";
import { type GmailPort, type LabelMap, verifyMailbox } from "./gmail.js";
import { MailboxSession, type StateStore } from "./state.js";
import { extract, received, type EmailText } from "./text.js";
import { senderOf } from "./sender.js";
import { isVerificationTest, type Verification } from "./verification.js";

// Deterministic per-message outcomes: retrying cannot succeed, so abstain instead of
// blocking every later message in the mailbox.
const TERMINAL_CLASSIFIER_ERRORS = [
  "invalid_route_answer", "ai_request_limit", "unreadable_body", "classifier_refused",
];

export type InboxOutcome = "inbox" | "archived" | "hold" | "flagged" | "skipped";

type MessageRun = { mode: "live"; session: MailboxSession } |
  { mode: "inbox"; acquire(): Promise<MailboxSession | InboxOutcome> };

export interface Dependencies {
  state: StateStore;
  gmail(account: Account, signal: AbortSignal): GmailPort;
  classify(account: Account, email: EmailText, signal: AbortSignal): Promise<Decision>;
  log?: typeof log;
  now?: () => number;
  verification?: Verification;
}

export class Processor {
  private log: typeof log;
  constructor(private deps: Dependencies) { this.log = deps.log || log; }

  private async processMessage(
    account: Account, id: string, gmail: GmailPort, labels: LabelMap,
    run: MessageRun, signal: AbortSignal,
  ): Promise<InboxOutcome | "held"> {
    signal.throwIfAborted();
    let message;
    try {
      message = await gmail.message(id);
    } catch (error) {
      if (!(error instanceof SafeError) || error.code !== "gmail_response_limit") throw error;
      this.log("message_skipped", { account: account.id, message: id, reason: "body_response_limit" });
      return "skipped";
    }
    const inboxRun = run.mode === "inbox";
    const outsideInbox = (ids: string[] = []) => !ids.includes("INBOX") || ids.includes(labels.held);
    if (!received(message, account.email)) return "skipped";
    // A retry after Gmail accepted a manual hold can recover the outcome from its label.
    if (message.labelIds?.includes(labels.hold)) return inboxRun ? "hold" : "skipped";
    if (inboxRun && outsideInbox(message.labelIds)) return "skipped";
    const verify = account.humanVerification || isVerificationTest(account, message);
    const resume = !inboxRun && verify &&
      await this.deps.verification?.needsResume(account, message);
    const processed = !inboxRun && (message.labelIds?.includes(labels.processed) || await this.deps.state.isProcessed(account.id, id));
    if (processed && !resume) return "skipped";
    if (verify && !this.deps.verification) throw new SafeError("verification_not_configured");
    const email = await extract(message, attachmentId => gmail.attachment(id, attachmentId));
    if (email.bodyUnavailable || !email.body.trim()) {
      this.log("message_skipped", { account: account.id, message: id, reason: "unreadable_body" });
      return "skipped";
    }
    if (resume && run.mode === "live") {
      if (!this.deps.verification) throw new SafeError("verification_not_configured");
      if (await this.deps.verification.quarantine(account, message, gmail, labels, run.session)) return "held";
      if (processed) return "skipped";
    }
    email.senderContext = await this.deps.verification?.describeSender(account, message, gmail);
    let decision: Decision;
    try {
      decision = await this.deps.classify(account, email, signal);
    } catch (error) {
      // Malformed decisions are safe terminal abstentions, not mailbox-blocking poison jobs.
      // Provider HTTP errors stay retryable: a misconfiguration must not mark all mail.
      if (!(error instanceof SafeError) || error instanceof HttpError ||
          !TERMINAL_CLASSIFIER_ERRORS.includes(error.code))
        throw error;
      this.log("message_skipped", { account: account.id, message: id, reason: error.code });
      return "skipped";
    }
    signal.throwIfAborted();
    // The bulk run takes the mailbox lease only for the final read and write.
    // Live deliveries can proceed during inference on older messages.
    const session = run.mode === "live" ? run.session : await run.acquire();
    if (typeof session === "string") return session;
    const current = await gmail.message(id, "minimal");
    if (current.labelIds?.some(l => ["SPAM", "TRASH", "DRAFT"].includes(l))) return "skipped";
    const currentLabels = current.labelIds || [];
    if (currentLabels.includes(labels.hold)) return inboxRun ? "hold" : "skipped";
    if (inboxRun ? outsideInbox(currentLabels) : currentLabels.includes(labels.processed)) return "skipped";
    const inInbox = currentLabels.includes("INBOX");
    const test = isVerificationTest(account, message);
    let label = !test && decision.action === "file" ? decision.label : null;
    if (label && inInbox && account.archiveEnabled) {
      const sender = senderOf(message);
      if (currentLabels.includes("STARRED") || !sender || sender === account.email ||
          (email.senderContext?.contact ?? await gmail.hasContact(sender)) ||
          (account.humanVerification && email.senderContext?.verified)) label = null;
    }
    const suspicious = decision.action === "suspicious";
    if (suspicious) label = decision.label;
    const checkSender = verify && inInbox && (decision.choice ?? decision.action) !== "suspicious" && (test || decision.action === "verify");
    const manualHold = inboxRun && checkSender;
    if (manualHold) label = HOLD_LABEL;
    const archive = !!label && account.archiveEnabled && inInbox;
    this.log("message_classified", {
      account: account.id, message: id, source: run.mode, label, action: decision.action, choice: decision.choice ?? null,
      actionProbability: decision.actionProbability, provider: decision.provider ?? null,
      model: decision.model ?? null, bodyTruncated: email.truncated,
      verificationPolicy: manualHold ? "manual_review" : checkSender ? "sender_checks" : "not_required",
    });
    const selected = manualHold ? labels.hold : label ? labels.options[label] : undefined;
    if (label && !selected) throw new SafeError("unmapped_label");
    const add = selected && (archive || !currentLabels.includes(selected)) ? [selected] : [];
    const remove = archive ? ["INBOX"] : [];
    // A delivered message may still carry one of our categories from an older run.
    for (const category of Object.values(labels.options)) {
      if (category !== selected && currentLabels.includes(category)) remove.push(category);
    }
    await session.assertOwned();
    signal.throwIfAborted();
    if (add.length || remove.length) await gmail.modify(id, add, remove, labels.options);
    if (checkSender && !inboxRun) {
      if (await this.deps.verification!.quarantine(account, message, gmail, labels, session, email.senderContext)) return "held";
    }
    this.log("message_processed", {
      account: account.id, message: id, label, archived: archive, reason: decision.reason,
    });
    if (manualHold) return "hold";
    return archive ? "archived" : "inbox";
  }

  // An explicit inbox run applies current rules even to previously processed mail.
  // Its journal is separate from the Gmail watch cursor.
  async processInboxItem(account: Account, id: string, gmail: GmailPort, labels: LabelMap,
    journal: { read(id: string): Promise<InboxOutcome | null>; save(id: string, outcome: InboxOutcome): Promise<void> },
  ): Promise<InboxOutcome> {
    if (!account.enabled) throw new SafeError("mailbox_disabled");
    const previous = await journal.read(id);
    if (previous) return previous;
    let session: MailboxSession | undefined;
    let completed: InboxOutcome | null = null;
    const acquire = async () => {
      if (!session) {
        const deadline = Date.now() + 330_000;
        for (;;) {
          try {
            session = await MailboxSession.acquire(this.deps.state, account.id, this.deps.now);
            break;
          } catch (error) {
            if (errorCode(error) !== "mailbox_busy" || Date.now() >= deadline) throw error;
            await delay(2000 + Math.random() * 2000);
          }
        }
        completed = await journal.read(id);
      }
      return completed ?? session;
    };
    try {
      let result: InboxOutcome | "held";
      try {
        result = await this.processMessage(account, id, gmail, labels, { mode: "inbox", acquire }, AbortSignal.timeout(600_000));
      } catch (error) {
        if (!(error instanceof HttpError) || error.service !== "gmail" || error.status !== 404) throw error;
        result = "skipped";
      }
      if (result === "held") throw new SafeError("unexpected_inbox_hold");
      // Skips can finish before the final Gmail read.
      const lock = await acquire();
      if (typeof lock === "string") return lock;
      await lock.assertOwned();
      if (result !== "skipped") await this.deps.state.markProcessed(account.id, id);
      await journal.save(id, result);
      return result;
    } finally {
      await session?.release();
    }
  }

  async notification(account: Account, notificationHistoryId: string): Promise<void> {
    if (!account.enabled) return;
    const session = await MailboxSession.acquire(this.deps.state, account.id, this.deps.now);
    const signal = AbortSignal.timeout(240_000);
    try {
      if (!session.data.historyId) throw new SafeError("watch_not_initialized");
      if (BigInt(notificationHistoryId) <= BigInt(session.data.historyId)) return;
      const gmail = this.deps.gmail(account, signal);
      await verifyMailbox(gmail, account);
      const labels = await gmail.labels(account);
      // All pages of a response use the same start cursor. Checkpoints advance only
      // after every added message in a history record has been processed or skipped.
      const start = session.data.historyId;
      let pageToken: string | undefined;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        signal.throwIfAborted();
        let page;
        try {
          page = await gmail.history(start, pageToken);
        } catch (error) {
          if (!(error instanceof HttpError) || error.service !== "gmail" || error.status !== 404) throw error;
          const profile = await gmail.profile();
          await session.update({ historyId: profile.historyId });
          this.log("history_gap_dropped", { account: account.id });
          return; // Explicitly no full sync, listing, backfill, or recovery scan.
        }
        for (const record of page.history) {
          if (BigInt(record.id) <= BigInt(session.data.historyId!)) continue;
          for (const id of new Set((record.messagesAdded || []).map(m => m.message.id))) {
            try {
              await this.processMessage(account, id, gmail, labels, { mode: "live", session }, signal);
              await session.assertOwned();
              await this.deps.state.markProcessed(account.id, id);
            } catch (error) {
              if (!(error instanceof HttpError) || error.service !== "gmail" || error.status !== 404)
                throw error;
              this.log("message_missing", { account: account.id, message: id });
            }
          }
          await session.update({ historyId: record.id });
        }
        if (!page.nextPageToken) {
          await session.update({ historyId: page.historyId });
          return;
        }
        pageToken = page.nextPageToken;
      }
      // Pub/Sub retry continues from the committed record, not from the inbox.
      throw new SafeError("history_batch_limit");
    } finally {
      await session.release().catch(error => this.log("lease_release_failed", {
        account: account.id, code: errorCode(error),
      }));
    }
  }

  async renew(account: Account, topic: string): Promise<void> {
    if (!account.enabled) return;
    const session = await MailboxSession.acquire(this.deps.state, account.id, this.deps.now);
    try {
      const gmail = this.deps.gmail(account, AbortSignal.timeout(60_000));
      await verifyMailbox(gmail, account);
      await gmail.labels(account); // Validate setup; do not create labels implicitly.
      await session.assertOwned();
      const watch = await gmail.watch(topic);
      await session.update({
        watchExpiration: watch.expiration,
        // Renewal must NOT skip changes by replacing an existing cursor.
        ...(session.data.historyId === null ? { historyId: watch.historyId } : {}),
      });
      this.log("watch_renewed", { account: account.id });
    } finally {
      await session.release().catch(error => this.log("lease_release_failed", {
        account: account.id, code: errorCode(error),
      }));
    }
  }
}
