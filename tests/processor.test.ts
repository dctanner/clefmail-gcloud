import { expect, test } from "bun:test";
import { HttpError, SafeError } from "../src/errors.js";
import { Processor } from "../src/processor.js";
import { MailboxSession } from "../src/state.js";
import { account, decision, verifyDecision, FakeGmail, MemoryState, message } from "./helpers.js";

function fixture(cursor: string | null = "100") {
  const state = new MemoryState(cursor);
  const gmail = new FakeGmail();
  const events: string[] = [];
  let classifications = 0;
  const deps = {
    state, gmail: () => gmail,
    classify: async () => { classifications++; return structuredClone(decision); },
    log: (event: string) => { events.push(event); },
  };
  return { state, gmail, deps, events, processor: new Processor(deps), count: () => classifications };
}

test("notification processes added IDs, labels + archives once, then checkpoints", async () => {
  const f = fixture();
  await f.processor.notification(account, "200");
  expect(f.gmail.historyCalls).toEqual([["100", undefined]]);
  expect(f.gmail.modifications).toEqual([{ id: "a1", add: ["Label_receipts"], remove: ["INBOX"] }]);
  expect(f.state.snapshot!.data.historyId).toBe("200");
  expect(f.state.snapshot!.data.lease).toBeUndefined();
  await f.processor.notification(account, "200");
  await f.processor.notification(account, "150");
  expect(f.count()).toBe(1);
  expect(f.gmail.historyCalls.length).toBe(1);
});

test("pagination uses original cursor and deduplicates repeated message IDs", async () => {
  const f = fixture();
  f.gmail.pages[0].nextPageToken = "1";
  f.gmail.pages.push({ historyId: "250", history: [
    { id: "220", messagesAdded: [{ message: { id: "a1" } }, { message: { id: "a2" } }] },
  ] });
  f.gmail.messages.set("a2", message("a2", ["INBOX", "UNREAD"]));
  await f.processor.notification(account, "250");
  expect(f.gmail.historyCalls).toEqual([["100", undefined], ["100", "1"]]);
  expect(f.count()).toBe(2);
  expect(f.gmail.messages.get("a2")!.labelIds).toContain("UNREAD");
  expect(f.state.snapshot!.data.historyId).toBe("250");
});

test("label-only changes advance cursor without inference or message fetches", async () => {
  const f = fixture();
  f.gmail.pages = [{ historyId: "200", history: [] }];
  await f.processor.notification(account, "200");
  expect(f.count()).toBe(0);
  expect(f.gmail.messageCalls).toEqual([]);
});

test("uses string/BigInt history IDs, never lossy Number conversions", async () => {
  const f = fixture("90071992547409930");
  f.gmail.pages = [{ historyId: "90071992547409932", history: [] }];
  await f.processor.notification(account, "90071992547409931");
  expect(f.state.snapshot!.data.historyId).toBe("90071992547409932");
});

test("rechecks protection before mutation", async () => {
  const f = fixture();
  f.deps.classify = async () => {
    f.gmail.messages.get("a1")!.labelIds!.push("STARRED");
    return decision;
  };
  await f.processor.notification(account, "200");
  expect(f.gmail.modifications).toEqual([]);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
});

test("provider failures do not advance cursor or mark processed", async () => {
  const f = fixture();
  f.deps.classify = async () => { throw new HttpError("classifier", 429); };
  await expect(f.processor.notification(account, "200")).rejects.toThrow("classifier_http_429");
  expect(f.state.snapshot!.data.historyId).toBe("100");
  expect(f.state.snapshot!.data.lease).toBeUndefined();
  expect(f.gmail.modifications).toEqual([]);
});

test("a malformed label response becomes a processed abstention, never an archive", async () => {
  const f = fixture();
  f.deps.classify = async () => { throw new SafeError("invalid_route_answer"); };
  await f.processor.notification(account, "200");
  expect(f.gmail.modifications).toEqual([]);
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
});

test("text removed by final request cleaning skips all Gmail actions", async () => {
  const f = fixture();
  f.deps.classify = async () => { throw new SafeError("unreadable_body"); };
  await f.processor.notification(account, "200");
  expect(f.gmail.modifications).toEqual([]);
  expect(f.gmail.notices).toEqual([]);
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
});

test("unknown mutation outcome retries safely before private completion is recorded", async () => {
  const f = fixture();
  const modify = f.gmail.modify.bind(f.gmail);
  let fail = true;
  f.gmail.modify = async (...args) => {
    await modify(...args);
    if (fail) { fail = false; throw new SafeError("gmail_request_failed"); }
  };
  await expect(f.processor.notification(account, "200")).rejects.toThrow();
  expect(f.state.snapshot!.data.historyId).toBe("100");
  await f.processor.notification(account, "200");
  expect(f.count()).toBe(2);
  expect(f.gmail.modifications.length).toBe(1);
  expect(f.state.snapshot!.data.historyId).toBe("200");
});

test("history expiry resets to current baseline without scans or backfill", async () => {
  const f = fixture();
  f.gmail.history = async () => { throw new HttpError("gmail", 404); };
  await f.processor.notification(account, "200");
  expect(f.state.snapshot!.data.historyId).toBe("300");
  expect(f.events).toContain("history_gap_dropped");
  expect(f.gmail.messageCalls).toEqual([]);
});

test("missing message is a skip, not a history reset", async () => {
  const f = fixture();
  f.gmail.message = async () => { throw new HttpError("gmail", 404); };
  await f.processor.notification(account, "200");
  expect(f.state.snapshot!.data.historyId).toBe("200");
  expect(f.events).toContain("message_missing");
  expect(f.events).not.toContain("history_gap_dropped");
});

test("renewal never replaces an existing cursor or calls history/message APIs", async () => {
  const f = fixture();
  await f.processor.renew(account, "projects/p/topics/t");
  expect(f.state.snapshot!.data.historyId).toBe("100");
  expect(f.state.snapshot!.data.watchExpiration).toBe("9999999999999");
  expect(f.gmail.watchCalls).toBe(1);
  expect(f.gmail.historyCalls).toEqual([]);
  expect(f.gmail.messageCalls).toEqual([]);
});

test("first watch establishes baseline, with no old-mail processing", async () => {
  const f = fixture(null);
  await f.processor.renew(account, "projects/p/topics/t");
  expect(f.state.snapshot!.data.historyId).toBe("400");
  expect(f.count()).toBe(0);
});

test("uninitialized mailbox is retryable until watch setup completes", async () => {
  const f = fixture(null);
  await expect(f.processor.notification(account, "200")).rejects.toThrow("watch_not_initialized");
  expect(f.gmail.historyCalls).toEqual([]);
});

test("disabled account does nothing; wrong token identity cannot process", async () => {
  const f = fixture();
  await f.processor.notification({ ...account, enabled: false }, "200");
  expect(f.state.writes).toEqual([]);
  f.gmail.profileEmail = "other@example.com";
  await expect(f.processor.notification(account, "200")).rejects.toThrow("mailbox_identity_mismatch");
  expect(f.gmail.historyCalls).toEqual([]);
  expect(f.gmail.modifications).toEqual([]);
});

test("concurrent delivery is rejected; stale lease cannot write or release a successor", async () => {
  const state = new MemoryState();
  let now = 1000;
  const a = await MailboxSession.acquire(state, "personal", () => now);
  await expect(MailboxSession.acquire(state, "personal", () => now)).rejects.toThrow("mailbox_busy");
  now += 301_000;
  const b = await MailboxSession.acquire(state, "personal", () => now);
  await expect(a.update({ historyId: "200" })).rejects.toThrow();
  await expect(a.release()).rejects.toThrow("mailbox_busy");
  await b.update({ historyId: "300" });
  await expect(b.update({ historyId: "200" })).rejects.toThrow("cursor_regression");
  await b.release();
  expect(state.snapshot!.data.historyId).toBe("300");
});

test("losing a lease while classifying prevents Gmail mutation", async () => {
  const f = fixture();
  f.deps.classify = async () => {
    f.state.snapshot!.generation = "999";
    f.state.snapshot!.data.lease = { owner: "successor", expiresAt: Date.now() + 300_000 };
    return decision;
  };
  await expect(f.processor.notification(account, "200")).rejects.toThrow("lease_lost");
  expect(f.gmail.modifications).toEqual([]);
  expect(f.state.snapshot!.data.lease!.owner).toBe("successor");
});

test("transient attachment-body failure is retried, never marked processed header-only", async () => {
  const f = fixture();
  f.gmail.messages.get("a1")!.payload!.body = { attachmentId: "body", size: 5 };
  f.gmail.attachment = async () => { throw new HttpError("gmail", 503); };
  await expect(f.processor.notification(account, "200")).rejects.toThrow("gmail_http_503");
  expect(f.gmail.modifications).toEqual([]);
  expect(f.state.snapshot!.data.historyId).toBe("100");
});

test("oversized messages skip all classification and Gmail actions", async () => {
  const f = fixture();
  const original = f.gmail.message.bind(f.gmail);
  f.gmail.message = async (id, format) => {
    if (!format || format === "full") throw new SafeError("gmail_response_limit");
    return original(id, format);
  };
  await f.processor.notification(account, "200");
  expect(f.gmail.modifications).toEqual([]);
  expect(f.count()).toBe(0);
  expect(f.gmail.messageCalls).toEqual([]);
  expect(f.state.snapshot!.data.historyId).toBe("200");
});

test("oversized classifier request is a terminal abstention, not a mailbox-blocking retry", async () => {
  const f = fixture();
  f.deps.classify = async () => { throw new SafeError("ai_request_limit"); };
  await f.processor.notification(account, "200");
  expect(f.gmail.modifications).toEqual([]);
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
});

test("private completion survives history replay without a visible processing label", async () => {
  const f = fixture();
  await f.processor.notification(account, "200");
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  f.gmail.pages = [{ historyId: "250", history: [{ id: "220", messagesAdded: [{ message: { id: "a1" } }] }] }];
  await f.processor.notification(account, "250");
  expect(f.count()).toBe(1);
});

test("legacy processed labels migrate into private completion without inference", async () => {
  const f = fixture();
  f.gmail.messages.get("a1")!.labelIds!.push("Label_done");
  await f.processor.notification(account, "200");
  expect(f.count()).toBe(0);
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
});

test("private marker failures preserve the history cursor for retry", async () => {
  const f = fixture();
  const mark = f.state.markProcessed.bind(f.state);
  f.state.markProcessed = async () => { throw new SafeError("storage_unavailable"); };
  await expect(f.processor.notification(account, "200")).rejects.toThrow("storage_unavailable");
  expect(f.state.snapshot!.data.historyId).toBe("100");
  f.state.markProcessed = mark;
  await f.processor.notification(account, "200");
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
  expect(f.state.snapshot!.data.historyId).toBe("200");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
});

function inboxJournal() {
  const results = new Map<string, import("../src/processor.js").InboxOutcome>();
  return {
    read: async (id: string) => results.get(id) ?? null,
    save: async (id: string, value: import("../src/processor.js").InboxOutcome) => { results.set(id, value); },
  };
}

test("inbox run reclassifies old markers, replaces only configured categories and resumes by ID", async () => {
  const f = fixture();
  const j = inboxJournal();
  f.gmail.labelMap.options.news = "Label_news";
  f.gmail.messages.set("a1", message("a1", ["INBOX", "UNREAD", "Label_news", "Label_personal", "Label_done"]));
  await f.state.markProcessed(account.id, "a1");
  const run = () => f.processor.processInboxItem(account, "a1", f.gmail, f.gmail.labelMap, j);
  expect(await run()).toBe("archived");
  expect(await run()).toBe("archived");
  expect(f.count()).toBe(1);
  expect(f.state.snapshot!.data.historyId).toBe("100");
  expect(f.gmail.messages.get("a1")!.labelIds).toEqual(["UNREAD", "Label_personal", "Label_done", "Label_receipts"]);
});

test("old pitches are reported in the inbox without a hold or a notice", async () => {
  const f = fixture();
  const verification = {
    describeSender: async () => undefined,
    needsResume: async () => { throw Error("unexpected resume"); },
    quarantine: async () => { throw Error("unexpected hold"); },
  } as unknown as import("../src/verification.js").Verification;
  const processor = new Processor({ ...f.deps, verification, classify: async () => verifyDecision });
  const result = await processor.processInboxItem({ ...account, humanVerification: true }, "a1", f.gmail, f.gmail.labelMap, inboxJournal());
  expect(result).toBe("flagged");
  expect(f.gmail.messages.get("a1")!.labelIds).toEqual(["INBOX"]);
  expect(f.gmail.notices).toEqual([]);
});

test("inbox run skips unreadable bodies and rechecks inbox membership after inference", async () => {
  const f = fixture();
  const m = message();
  m.payload!.body = {};
  f.gmail.messages.set("a1", m);
  expect(await f.processor.processInboxItem(account, "a1", f.gmail, f.gmail.labelMap, inboxJournal())).toBe("skipped");
  expect(f.count()).toBe(0);
  f.gmail.messages.set("a1", message());
  const processor = new Processor({ ...f.deps, classify: async () => {
    expect(f.state.snapshot?.data.lease).toBeUndefined();
    f.gmail.messages.get("a1")!.labelIds = ["Label_personal"];
    return decision;
  } });
  expect(await processor.processInboxItem(account, "a1", f.gmail, f.gmail.labelMap, inboxJournal())).toBe("skipped");
  expect(f.gmail.modifications).toEqual([]);
});

test("filing archives an Important message even when it already carries the category", async () => {
  const f = fixture();
  f.gmail.messages.set("a1", message("a1", ["INBOX", "IMPORTANT", "UNREAD", "Label_receipts"]));
  await f.processor.notification(account, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toEqual(["IMPORTANT", "UNREAD", "Label_receipts"]);
});

test("delivery clears old filing categories while keeping user labels", async () => {
  const f = fixture();
  f.gmail.messages.set("a1", message("a1", ["INBOX", "UNREAD", "Label_receipts", "Label_mine"]));
  f.deps.classify = async () => ({ ...decision, action: "deliver", label: null });
  await f.processor.notification(account, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toEqual(["INBOX", "UNREAD", "Label_mine"]);
});
