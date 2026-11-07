import { customSenderDomain } from "./sender-context.js";
import { z } from "zod";
import { PROCESSED_LABEL, HELD_LABEL, type Account } from "./config.js";
import { HttpError, SafeError } from "./errors.js";
import { jsonRequest, type Fetch } from "./http.js";
import type { Message } from "./text.js";
import { address, addresses, header, senderOf } from "./sender.js";

export const historyId = z.string().regex(/^[1-9][0-9]{0,39}$/);
const messageId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const historyPageSchema = z.object({
  historyId,
  nextPageToken: z.string().min(1).max(4000).optional(),
  history: z.array(z.object({
    id: historyId,
    messagesAdded: z.array(z.object({
      message: z.object({ id: messageId }),
    })).optional(),
  })).default([]),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export interface LabelMap {
  processed: string;
  held: string;
  options: Record<string, string>;
}
export type MessageFormat = "full" | "minimal" | "metadata";
export interface GmailPort {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  history(cursor: string, pageToken?: string): Promise<HistoryPage>;
  message(id: string, format?: MessageFormat): Promise<Message>;
  attachment(message: string, id: string): Promise<{ data: string; size?: number }>;
  labels(account: Account, create?: boolean): Promise<LabelMap>;
  modify(id: string, add: string[], remove: string[]): Promise<void>;
  watch(topic: string): Promise<{ historyId: string; expiration: string }>;
  hasContact(email: string): Promise<boolean>;
  addContact(email: string): Promise<void>;
  hasCorresponded(email: string, current: Message): Promise<boolean>;
  hasDomainCorresponded(domain: string): Promise<boolean>;
  releaseHeld(id: string, heldLabel: string, restoreInbox: boolean): Promise<void>;
  sendNotice(to: string, subject: string, body: string, key: string, replyTo?: string): Promise<void>;
}

const partSchema: z.ZodType<any> = z.lazy(() => z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  // No count limits here: a schema failure would be a permanent, mailbox-blocking error.
  // The text extractor enforces its own conservative MIME limits.
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({
    size: z.number().nonnegative().optional(),
    data: z.string().optional(),
    attachmentId: z.string().max(4000).optional(),
  }).optional(),
  parts: z.array(partSchema).optional(),
}));
const messageSchema = z.object({
  id: messageId,
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().optional(),
  payload: partSchema.optional(),
});

export class Gmail implements GmailPort {
  private token?: { value: string; expiresAt: number };
  constructor(
    private credentials: { clientId: string; clientSecret: string; refreshToken: string },
    private signal?: AbortSignal,
    private fetcher: Fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const raw = await jsonRequest("google_oauth", "https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
      }),
    }, { fetch: this.fetcher, signal: this.signal, maxBytes: 16_384 });
    const token = z.object({
      access_token: z.string().min(1),
      expires_in: z.number().positive().max(86400),
    }).safeParse(raw);
    if (!token.success) throw new SafeError("invalid_oauth_response");
    this.token = { value: token.data.access_token, expiresAt: Date.now() + token.data.expires_in * 1000 };
    return this.token.value;
  }

  private async call(path: string, body?: unknown): Promise<any> {
    return jsonRequest("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { fetch: this.fetcher, signal: this.signal });
  }

  async profile() {
    return z.object({ emailAddress: z.string().email(), historyId }).parse(await this.call("profile"));
  }

  async history(cursor: string, pageToken?: string): Promise<HistoryPage> {
    const query = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: "messageAdded",
      maxResults: "50",
      fields: "history(id,messagesAdded(message(id))),historyId,nextPageToken",
    });
    if (pageToken) query.set("pageToken", pageToken);
    return historyPageSchema.parse(await this.call(`history?${query}`));
  }

  async message(id: string, format: MessageFormat = "full"): Promise<Message> {
    messageId.parse(id);
    const query = new URLSearchParams({
      format,
      fields: format === "minimal" ? "id,labelIds" : "id,labelIds,internalDate,payload",
    });
    if (format === "metadata")
      for (const name of ["From", "To", "Cc", "Bcc", "Subject", "Date", "Delivered-To", "X-Original-To",
        "Message-ID", "In-Reply-To", "References", "Received", "BIMI-Selector", "Auto-Submitted", "List-Id", "Precedence", "Return-Path",
        "X-Auto-Response-Suppress", "Authentication-Results"])
        query.append("metadataHeaders", name);
    const result = messageSchema.parse(await this.call(`messages/${encodeURIComponent(id)}?${query}`));
    if (result.id !== id) throw new SafeError("gmail_message_mismatch");
    return result;
  }

  async attachment(message: string, id: string) {
    messageId.parse(message);
    if (!/^[a-zA-Z0-9_-]{1,4000}$/.test(id)) throw new SafeError("invalid_attachment_id");
    return z.object({ data: z.string(), size: z.number().nonnegative().optional() }).parse(
      await this.call(`messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(id)}`),
    );
  }

  async labels(account: Account, create = false): Promise<LabelMap> {
    const labelSchema = z.object({ id: z.string().min(1), name: z.string(), type: z.string() });
    const result = z.object({ labels: z.array(labelSchema) }).parse(await this.call("labels"));
    const find = async (name: string, hidden = false): Promise<string> => {
      const existing = result.labels.find(l => l.name === name);
      if (existing) {
        if (existing.type !== "user") throw new SafeError("system_label_not_allowed");
        return existing.id;
      }
      if (!create) throw new SafeError("gmail_label_missing_run_setup");
      const response = labelSchema.omit({ type: true }).extend({ type: z.string().optional() }).parse(await this.call("labels", {
        name,
        labelListVisibility: hidden ? "labelHide" : "labelShow",
        messageListVisibility: hidden ? "hide" : "show",
      }));
      // Gmail can omit type from its creation response. Read it back before use.
      const created = labelSchema.parse(response.type === undefined
        ? await this.call(`labels/${encodeURIComponent(response.id)}`)
        : response);
      if (created.id !== response.id || created.name !== name) throw new SafeError("gmail_label_mismatch");
      if (created.type !== "user") throw new SafeError("system_label_not_allowed");
      result.labels.push(created);
      return created.id;
    };
    // Recognize the old marker during migration, but never create it.
    const legacy = result.labels.find(l => l.name === PROCESSED_LABEL);
    if (legacy && legacy.type !== "user") throw new SafeError("system_label_not_allowed");
    const processed = legacy?.id || "";
    const options: Record<string, string> = {};
    for (const label of account.labels) options[label.id] = await find(label.name);
    const held = await find(HELD_LABEL);
    return { processed, held, options };
  }

  async modify(id: string, add: string[], remove: string[]): Promise<void> {
    messageId.parse(id);
    // Defense in depth: no caller may mutate system labels other than removing INBOX.
    if (!add.length || add.some(l => !/^Label_[a-zA-Z0-9_-]+$/.test(l)) ||
        remove.some(l => l !== "INBOX"))
      throw new SafeError("unsafe_label_mutation");
    await this.call(`messages/${encodeURIComponent(id)}/modify`, {
      addLabelIds: [...new Set(add)],
      removeLabelIds: [...new Set(remove)],
    });
  }

  async watch(topic: string) {
    // No INBOX filter: incoming mail archived by Gmail filters is still eligible.
    return z.object({ historyId, expiration: z.string().regex(/^[0-9]+$/) }).parse(
      await this.call("watch", { topicName: topic }),
    );
  }

  private async people(path: string, body?: unknown): Promise<any> {
    return jsonRequest("people", `https://people.googleapis.com/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { fetch: this.fetcher, signal: this.signal });
  }

  async hasContact(email: string): Promise<boolean> {
    let token: string | undefined;
    // Do not use searchContacts: its prefix search/cache can miss newly added contacts.
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        personFields: "emailAddresses", pageSize: "1000", sources: "READ_SOURCE_TYPE_CONTACT",
      });
      if (token) query.set("pageToken", token);
      const result = z.object({
        connections: z.array(z.object({
          emailAddresses: z.array(z.object({ value: z.string() })).optional(),
        })).default([]),
        nextPageToken: z.string().optional(),
      }).parse(await this.people(`people/me/connections?${query}`));
      if (result.connections.some(p => p.emailAddresses?.some(e => e.value.trim().toLowerCase() === email)))
        return true;
      if (!result.nextPageToken) return false;
      token = result.nextPageToken;
    }
    throw new SafeError("contacts_page_limit");
  }

  async addContact(email: string): Promise<void> {
    if (address(email) !== email) throw new SafeError("invalid_contact_email");
    if (await this.hasContact(email)) return;
    await this.people("people:createContact", { emailAddresses: [{ value: email }] });
  }

  async hasCorresponded(email: string, current: Message): Promise<boolean> {
    if (address(email) !== email || !current.id || !/^\d+$/.test(current.internalDate || ""))
      throw new SafeError("invalid_correspondence_input");
    // Include archived mail. Spam/trash are included for the user's "ever" rule.
    // Sent mail at any time counts (including a reply sent before processing).
    // Incoming mail must predate this message. Only matching metadata is fetched.
    const query = new URLSearchParams({
      q: `in:anywhere {from:"${email}" to:"${email}" cc:"${email}" bcc:"${email}"}`,
      maxResults: "100", includeSpamTrash: "true",
    });
    for (let page = 0; page < 100; page++) {
      const result = z.object({
        messages: z.array(z.object({ id: messageId })).default([]),
        nextPageToken: z.string().optional(),
      }).parse(await this.call(`messages?${query}`));
      for (const candidate of result.messages) {
        if (candidate.id === current.id) continue;
        let message: Message;
        try { message = await this.message(candidate.id, "metadata"); }
        catch (error) {
          if (error instanceof HttpError && error.service === "gmail" && error.status === 404) continue;
          throw error;
        }
        if (message.labelIds?.includes("SENT") && ["To", "Cc", "Bcc"].some(name =>
          addresses(header(message, name))?.includes(email))) return true;
        if (!message.internalDate || Number(message.internalDate) > Number(current.internalDate)) continue;
        // Stable tie-break for equal millisecond timestamps: simultaneous unknown
        // messages must not each count the other as an earlier correspondent.
        if (message.internalDate === current.internalDate && candidate.id >= current.id) continue;
        if (senderOf(message) === email && !message.labelIds?.includes("DRAFT")) return true;
      }
      if (!result.nextPageToken) return this.hasSentReplyAlias(email, current);
      query.set("pageToken", result.nextPageToken);
    }
    throw new SafeError("correspondence_page_limit");
  }

  async hasDomainCorresponded(domain: string): Promise<boolean> {
    if (!customSenderDomain(domain)) return false;
    const query = new URLSearchParams({ q: `in:sent {to:${domain} cc:${domain} bcc:${domain}}`, maxResults: "50" });
    for (let page = 0; page < 5; page++) {
      const result = z.object({ messages: z.array(z.object({ id: messageId })).default([]), nextPageToken: z.string().optional() })
        .parse(await this.call(`messages?${query}`));
      for (const candidate of result.messages) {
        let sent: Message;
        try { sent = await this.message(candidate.id, "metadata"); }
        catch (error) { if (error instanceof HttpError && error.status === 404) continue; throw error; }
        if (!sent.labelIds?.includes("SENT") || sent.labelIds.includes("DRAFT") ||
            /auto-/i.test(header(sent, "Auto-Submitted")) || header(sent, "Message-ID").includes("@clefmail.invalid")) continue;
        if (["To", "Cc", "Bcc"].some(name => addresses(header(sent, name))?.some(email => email.split("@")[1] === domain))) return true;
      }
      if (!result.nextPageToken) return false;
      query.set("pageToken", result.nextPageToken);
    }
    throw new SafeError("company_correspondence_page_limit");
  }

  private async hasSentReplyAlias(email: string, current: Message): Promise<boolean> {
    // A plus-tagged auto-reply can refer to mail sent to the base address.
    // Require the actual sent message and matching recipient, not a domain match.
    const [local, domain] = email.split("@");
    if (!local!.includes("+")) return false;
    const base = `${local!.split("+")[0]}@${domain}`;
    const references = `${header(current, "In-Reply-To")} ${header(current, "References")}`;
    const ids = [...new Set(references.match(/<[^<>\s]{1,998}>/g) || [])].slice(-20);
    for (const id of ids) {
      if (!/^<[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~@-]+>$/.test(id)) continue;
      const query = new URLSearchParams({ q: `in:sent rfc822msgid:${id.slice(1, -1)}`, maxResults: "100" });
      const result = z.object({ messages: z.array(z.object({ id: messageId })).default([]) })
        .parse(await this.call(`messages?${query}`));
      for (const candidate of result.messages) {
        const sent = await this.message(candidate.id, "metadata");
        if (!sent.labelIds?.includes("SENT") || header(sent, "Message-ID") !== id) continue;
        if (header(sent, "Auto-Submitted").toLowerCase() === "auto-replied") continue;
        if (["To", "Cc", "Bcc"].some(name => addresses(header(sent, name))?.includes(base))) return true;
      }
    }
    return false;
  }

  async releaseHeld(id: string, heldLabel: string, restoreInbox: boolean): Promise<void> {
    messageId.parse(id);
    if (!/^Label_[a-zA-Z0-9_-]+$/.test(heldLabel)) throw new SafeError("unsafe_label_mutation");
    await this.call(`messages/${encodeURIComponent(id)}/modify`, {
      addLabelIds: restoreInbox ? ["INBOX"] : [], removeLabelIds: [heldLabel],
    });
  }

  async sendNotice(to: string, subject: string, body: string, key: string, replyTo?: string): Promise<void> {
    if (address(to) !== to || /[\r\n]/.test(subject) || !/^[a-f0-9]{64}$/.test(key))
      throw new SafeError("invalid_notice");
    const id = `${key}@clefmail.invalid`;
    const query = new URLSearchParams({ q: `in:sent rfc822msgid:${id}`, maxResults: "1" });
    const existing = z.object({ messages: z.array(z.object({ id: messageId })).default([]) })
      .parse(await this.call(`messages?${query}`));
    if (existing.messages.length) return;
    const headers = [
      `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}>`,
      "Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All",
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
    ];
    if (replyTo && /^<[^<>\s\r\n]{1,200}@[^<>\s\r\n]{1,200}>$/.test(replyTo))
      headers.push(`In-Reply-To: ${replyTo}`, `References: ${replyTo}`);
    const encoded = Buffer.from(body).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
    await this.call("messages/send", { raw: Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encoded}`).toString("base64url") });
  }
}

export async function verifyMailbox(gmail: GmailPort, account: Account): Promise<void> {
  const profile = await gmail.profile();
  if (profile.emailAddress.toLowerCase() !== account.email)
    throw new SafeError("mailbox_identity_mismatch");
}
