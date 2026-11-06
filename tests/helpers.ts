import { accountSchema, configSchema } from "../src/config.js";
import type { Decision } from "../src/decision.js";
import { SafeError } from "../src/errors.js";
import type { GmailPort, HistoryPage, LabelMap } from "../src/gmail.js";
import type { Snapshot, State, StateStore } from "../src/state.js";
import type { EmailText, Message } from "../src/text.js";

export const account = accountSchema.parse({
  id: "personal", email: "owner@example.com", refreshTokenEnv: "GMAIL_PERSONAL_REFRESH_TOKEN",
  prompt: "Archive routine receipts only.",
  labels: [{ id: "receipts", name: "Clefmail/Receipts", description: "Routine receipts" }],
});
export const config = configSchema.parse({ provider: { kind: "jev" }, accounts: [account] });
export const email: EmailText = {
  from: "shop@example.com", to: account.email, subject: "Receipt", receivedAt: "",
  body: "Paid. No action needed.", bodyUnavailable: false, truncated: false, originalBytes: 23,
};
export const answer = (p = 0.99, archive: unknown = 0.99) => ({
  model: "jev-test", answers: {
    label: { type: "choice", choice: "receipts", confidence: 0.99, probabilities: { receipts: p, no_match: 1 - p } },
    archive: { type: "noul", noul: archive },
  },
});
export const decision: Decision = {
  label: "receipts", archive: true, archiveProbability: 0.99, archiveError: null,
  reason: null, bodyUnavailable: false, truncated: false,
};
export const message = (id = "a1", labels = ["INBOX"]): Message => ({
  id, labelIds: labels,
  payload: { mimeType: "text/plain", headers: [{ name: "To", value: account.email }],
    body: { data: Buffer.from("Paid. No action needed.").toString("base64url"), size: 23 } },
});

export class MemoryState implements StateStore {
  snapshot: Snapshot | null;
  writes: State[] = [];
  constructor(cursor: string | null = "100") {
    this.snapshot = cursor === null ? null : { generation: "1", data: { historyId: cursor } };
  }
  async read() { return structuredClone(this.snapshot); }
  async write(_id: string, state: State, generation: string) {
    if ((this.snapshot?.generation || "0") !== generation) throw new SafeError("mailbox_busy");
    this.snapshot = { generation: String(Number(generation) + 1), data: structuredClone(state) };
    this.writes.push(structuredClone(state));
  }
}

export class FakeGmail implements GmailPort {
  messages = new Map<string, Message>([["a1", message()]]);
  modifications: { id: string; add: string[]; remove: string[] }[] = [];
  historyCalls: [string, string | undefined][] = [];
  messageCalls: [string, string][] = [];
  watchCalls = 0;
  profileEmail = account.email;
  profileHistory = "300";
  pages: HistoryPage[] = [{ historyId: "200", history: [{ id: "150", messagesAdded: [{ message: { id: "a1" } }] }] }];
  labelMap: LabelMap = { processed: "Label_done", options: { receipts: "Label_receipts" } };
  async profile() { return { emailAddress: this.profileEmail, historyId: this.profileHistory }; }
  async history(cursor: string, token?: string) {
    this.historyCalls.push([cursor, token]);
    return structuredClone(this.pages[token ? Number(token) : 0]);
  }
  async message(id: string, format = "full") {
    this.messageCalls.push([id, format]);
    return structuredClone(this.messages.get(id)!);
  }
  async attachment(): Promise<{ data: string }> { throw new Error("Unexpected attachment fetch"); }
  async labels() { return this.labelMap; }
  async modify(id: string, add: string[], remove: string[]) {
    this.modifications.push({ id, add: [...add], remove: [...remove] });
    const value = this.messages.get(id)!;
    value.labelIds = [...new Set([...(value.labelIds || []).filter(l => !remove.includes(l)), ...add])];
  }
  async watch() { this.watchCalls++; return { historyId: "400", expiration: "9999999999999" }; }
}
