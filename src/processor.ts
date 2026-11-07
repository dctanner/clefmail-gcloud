import type { Account } from "./config.js";
import { archiveBlock, type Decision } from "./decision.js";
import { errorCode, HttpError, log, SafeError } from "./errors.js";
import { type GmailPort, type LabelMap, verifyMailbox } from "./gmail.js";
import { MailboxSession, type StateStore } from "./state.js";
import { extract, received, type EmailText } from "./text.js";
import { senderOf } from "./sender.js";
import { isVerificationTest, type Verification } from "./verification.js";

// Deterministic per-message outcomes: retrying cannot succeed, so abstain instead of
// blocking every later message in the mailbox.
const TERMINAL_CLASSIFIER_ERRORS = [
  "invalid_label_answer", "invalid_probability_total", "choice_not_maximum", "ai_request_limit",
];

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
    session: MailboxSession, signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let message, headerOnly = false;
    try {
      message = await gmail.message(id);
    } catch (error) {
      // A very large inline body must not block the mailbox forever. Fall back to
      // headers only: header-only messages can be labeled but never archived.
      if (!(error instanceof SafeError) || error.code !== "gmail_response_limit") throw error;
      message = await gmail.message(id, "metadata");
      headerOnly = true;
    }
    if (!received(message, account.email)) return;
    const verify = account.humanVerification || isVerificationTest(account, message);
    const resume = verify &&
      await this.deps.verification?.needsResume(account, message);
    const processed = message.labelIds?.includes(labels.processed) || await this.deps.state.isProcessed(account.id, id);
    if (processed && !resume) return;
    if (verify && !this.deps.verification) throw new SafeError("verification_not_configured");
    if (resume) {
      if (!this.deps.verification) throw new SafeError("verification_not_configured");
      if (await this.deps.verification.quarantine(account, message, gmail, labels, session)) return;
      if (processed) return;
    }
    const email = await extract(message, attachmentId => gmail.attachment(id, attachmentId));
    if (headerOnly) Object.assign(email, { body: "", bodyUnavailable: true, truncated: true });
    let decision: Decision;
    try {
      decision = await this.deps.classify(account, email, signal);
    } catch (error) {
      // Malformed decisions are safe terminal abstentions, not mailbox-blocking poison jobs.
      // Provider HTTP errors stay retryable: a misconfiguration must not mark all mail.
      if (!(error instanceof SafeError) || error instanceof HttpError ||
          !TERMINAL_CLASSIFIER_ERRORS.includes(error.code))
        throw error;
      const code = error.code;
      decision = {
        label: null, archive: false, archiveProbability: null, archiveError: code,
        skipHumanVerification: false, verificationSkipProbability: null,
        reason: code, bodyUnavailable: email.bodyUnavailable, truncated: email.truncated,
      };
    }
    // Archive gates come from the extracted email itself, never from the classifier path.
    decision = {
      ...decision,
      bodyUnavailable: decision.bodyUnavailable || email.bodyUnavailable,
      truncated: decision.truncated || email.truncated,
    };
    signal.throwIfAborted();
    const current = await gmail.message(id, "minimal");
    if (current.labelIds?.includes(labels.processed)) return;
    if (current.labelIds?.some(l => ["SPAM", "TRASH", "DRAFT"].includes(l))) return;
    const sender = senderOf(message);
    // Lookup errors retry; they never mean "not a contact". This guard also
    // applies when human verification is disabled.
    const protectedSender = !sender || sender === account.email || await gmail.hasContact(sender) ||
      !!(account.humanVerification && await this.deps.verification?.trusted(account, sender));
    const block = protectedSender ? "protected_sender" : archiveBlock(decision, account, current.labelIds || []);
    const modelBypass = decision.skipHumanVerification && !decision.bodyUnavailable && !decision.truncated && !isVerificationTest(account, message);
    const checkSender = verify && !modelBypass && block !== null && !!current.labelIds?.includes("INBOX");
    this.log("message_classified", {
      account: account.id, message: id, label: decision.label, archiveProbability: decision.archiveProbability,
      archiveBlock: block, verificationSkipProbability: decision.verificationSkipProbability,
      verificationPolicy: block === null ? "archived" : modelBypass ? "expected_mail" : checkSender ? "sender_checks" : "not_required",
    });
    const add: string[] = [];
    if (decision.label) {
      const selected = labels.options[decision.label];
      if (!selected) throw new SafeError("unmapped_label");
      add.push(selected);
    }
    await session.assertOwned();
    signal.throwIfAborted();
    // One message-level modification, never a thread update, send, trash, or delete.
    if (add.length || block === null) await gmail.modify(id, add, block === null ? ["INBOX"] : []);
    if (checkSender) {
      if (await this.deps.verification!.quarantine(account, message, gmail, labels, session)) return;

    }
    this.log("message_processed", {
      account: account.id, message: id, label: decision.label,
      archived: block === null, archiveBlock: block, reason: decision.reason,
    });
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
              await this.processMessage(account, id, gmail, labels, session, signal);
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
