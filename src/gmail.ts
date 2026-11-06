import { z } from "zod";
import { PROCESSED_LABEL, type Account } from "./config.js";
import { SafeError } from "./errors.js";
import { jsonRequest, type Fetch } from "./http.js";
import type { Message } from "./text.js";

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
      for (const name of ["From", "To", "Cc", "Subject", "Date", "Delivered-To", "X-Original-To"])
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
      const created = labelSchema.parse(await this.call("labels", {
        name,
        labelListVisibility: hidden ? "labelHide" : "labelShow",
        messageListVisibility: hidden ? "hide" : "show",
      }));
      if (created.type !== "user") throw new SafeError("system_label_not_allowed");
      result.labels.push(created);
      return created.id;
    };
    const processed = await find(PROCESSED_LABEL, true);
    const options: Record<string, string> = {};
    for (const label of account.labels) options[label.id] = await find(label.name);
    return { processed, options };
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
}

export async function verifyMailbox(gmail: GmailPort, account: Account): Promise<void> {
  const profile = await gmail.profile();
  if (profile.emailAddress.toLowerCase() !== account.email)
    throw new SafeError("mailbox_identity_mismatch");
}
