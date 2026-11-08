import { expect, test } from "bun:test";
import { accountSchema, configSchema } from "../src/config.js";
import { SafeError } from "../src/errors.js";
import type { Fetch } from "../src/http.js";
import { Processor } from "../src/processor.js";
import { createVerificationHandler } from "../src/verification-handler.js";
import { digest, Verification, type SenderRecord, type SenderSnapshot, type SenderStore } from "../src/verification.js";
import { address, mayChallenge, senderOf } from "../src/sender.js";
import { account, decision, verifyDecision, FakeGmail, MemoryState, message } from "./helpers.js";

class MemorySenders implements SenderStore {
  values = new Map<string, SenderSnapshot>();
  async read(account: string, key: string) { return structuredClone(this.values.get(`${account}/${key}`) || null); }
  async write(account: string, key: string, record: SenderRecord, generation: string) {
    const current = await this.read(account, key);
    if ((current?.generation || "0") !== generation) throw new SafeError("sender_busy");
    this.values.set(`${account}/${key}`, { record: structuredClone(record), generation: String(Number(generation) + 1) });
  }
}
const sender = "shop@example.com";
const protectedAccount = accountSchema.parse({ ...account, humanVerification: true, archiveEnabled: false });
const settings = { publicUrl: "https://verify.example.com", siteKey: "synthetic-key" };
const config = configSchema.parse({ provider: { kind: "jev" }, verification: settings, accounts: [protectedAccount] });

function fixture(classify = async () => verifyDecision, bimi = { allows: async (_message: unknown) => false }) {
  const state = new MemoryState(), senders = new MemorySenders(), gmail = new FakeGmail();
  let classified = 0;
  const verification = new Verification({ state, senders, gmail: () => gmail, publicUrl: settings.publicUrl, bimi });
  const processor = new Processor({ state, gmail: () => gmail, verification,
    classify: async () => { classified++; return classify(); }, log: () => {} });
  const record = async () => (await senders.read(account.id, digest(sender)))!.record;
  return { state, senders, gmail, verification, processor, record, classified: () => classified };
}

async function next(f: ReturnType<typeof fixture>, id: string, cursor = "250") {
  f.gmail.messages.set(id, message(id));
  f.gmail.pages = [{ historyId: cursor, history: [{ id: cursor, messagesAdded: [{ message: { id } }] }] }];
  await f.processor.notification(protectedAccount, cursor);
}

test("new sender held before challenge; each new message is classified before being held", async () => {
  const f = fixture();
  const send = f.gmail.sendNotice.bind(f.gmail);
  f.gmail.sendNotice = async (...args) => {
    expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
    expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_held");
    await send(...args);
  };
  await f.processor.notification(protectedAccount, "200");
  expect(f.classified()).toBe(1);
  expect(f.gmail.notices).toHaveLength(1);
  expect(f.gmail.notices[0]!.body).toContain("https://verify.example.com/verify#personal/");
  f.gmail.corresponded = true; // Pending messages themselves must never confer trust.
  await next(f, "a2");
  expect(f.gmail.messages.get("a2")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(1);
  expect((await f.record()).pending).toHaveLength(2);
  expect(f.classified()).toBe(2);
  expect(f.gmail.messages.get("a2")!.labelIds).not.toContain("Label_receipts");
});

test("filed mail skips sender verification entirely", async () => {
  const f = fixture(async () => decision);
  await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
  expect(f.classified()).toBe(1);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_receipts");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
});

test("cold outreach receives only the held label", async () => {
  const f = fixture();
  const send = f.gmail.sendNotice.bind(f.gmail);
  f.gmail.sendNotice = async (...args) => {
    expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_receipts");
    await send(...args);
  };
  await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
  expect(f.gmail.notices).toHaveLength(1);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_held");
});

test("classification failure leaves mail untouched and sends no challenge", async () => {
  const f = fixture(async () => { throw new SafeError("provider_unavailable"); });
  await expect(f.processor.notification(protectedAccount, "200")).rejects.toThrow("provider_unavailable");
  expect(f.gmail.modifications).toHaveLength(0);
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
  expect(f.state.snapshot!.data.historyId).toBe("100");
});

test("failed sender context lookup retries before classification or labeling", async () => {
  const f = fixture();
  f.gmail.hasCorresponded = async () => { throw new SafeError("lookup_failed"); };
  await expect(f.processor.notification(protectedAccount, "200")).rejects.toThrow("lookup_failed");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_receipts");
  expect(f.classified()).toBe(0);
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  f.gmail.hasCorresponded = async () => false;
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.notices).toHaveLength(1);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_held");
});

test("filtered mail can receive a filing category outside the inbox", async () => {
  const f = fixture(async () => decision);
  f.gmail.messages.set("a1", message("a1", []));
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_receipts");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
});

test("verification restores held messages, adds contact, sends success once and protects future mail", async () => {
  const f = fixture();
  await f.processor.notification(protectedAccount, "200");
  await next(f, "a2");
  const record = await f.record();
  await f.verification.complete(protectedAccount, digest(sender), record.token);
  expect(f.gmail.contacts.has(sender)).toBe(true);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a2")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.messages.get("a2")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(2);
  expect(f.gmail.notices[1]!.to).toBe(sender);
  await f.verification.complete(protectedAccount, digest(sender), record.token);
  expect(f.gmail.notices).toHaveLength(2);
  await next(f, "a3", "300");
  expect(f.gmail.messages.get("a3")!.labelIds).toContain("INBOX");
  expect((await f.record()).status).toBe("verified");
});

test("existing contacts are never AI-archived even when verification is disabled", async () => {
  const f = fixture();
  f.gmail.contacts.add(sender);
  await f.processor.notification(account, "200");
  expect(f.classified()).toBe(1);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(0);
});

test("prior correspondents bypass verification and retain ordinary classifier policy", async () => {
  const f = fixture(async () => decision); f.gmail.corresponded = true;
  await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
  expect(f.classified()).toBe(1);
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  expect(f.senders.values.size).toBe(0);
});

test("contact API failure cannot be interpreted as permission to archive", async () => {
  for (const a of [account, protectedAccount]) {
    const f = fixture(); f.gmail.hasContact = async () => { throw new SafeError("people_unavailable"); };
    await expect(f.processor.notification(a, "200")).rejects.toThrow("people_unavailable");
    expect(f.gmail.modifications).toHaveLength(0);
    expect(f.state.snapshot!.data.historyId).toBe("100");
  }
});

test("failed challenge send retries despite processed marker and preserves pending state", async () => {
  const f = fixture();
  const send = f.gmail.sendNotice.bind(f.gmail);
  f.gmail.sendNotice = async () => { throw new SafeError("send_failed"); };
  await expect(f.processor.notification(protectedAccount, "200")).rejects.toThrow("send_failed");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  expect((await f.record()).challenged).toBe(false);
  f.gmail.sendNotice = send;
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.notices).toHaveLength(1);
  expect((await f.record()).pending).toHaveLength(1);
  expect(f.classified()).toBe(1);
});

test("partial restoration failure resumes without repeating successful restores or success mail", async () => {
  const f = fixture(); await f.processor.notification(protectedAccount, "200"); await next(f, "a2");
  const token = (await f.record()).token;
  const restore = f.gmail.releaseHeld.bind(f.gmail);
  f.gmail.releaseHeld = async (id, held, inbox) => { if (id === "a2") throw new SafeError("restore_failed"); await restore(id, held, inbox); };
  await expect(f.verification.complete(protectedAccount, digest(sender), token)).rejects.toThrow("restore_failed");
  expect((await f.record()).status).toBe("verifying");
  expect((await f.record()).pending.map(p => p.id)).toEqual(["a2"]);
  f.gmail.releaseHeld = restore;
  await f.verification.complete(protectedAccount, digest(sender), token);
  expect(f.gmail.modifications.filter(m => m.id === "a1" && m.add.includes("INBOX"))).toHaveLength(1);
  expect(f.gmail.notices).toHaveLength(2);
});

test("verification never resurrects trash/spam or mail already archived before quarantine", async () => {
  const f = fixture();
  f.gmail.messages.set("a1", message("a1", []));
  await f.processor.notification(protectedAccount, "200");
  await next(f, "a2"); f.gmail.messages.get("a2")!.labelIds = ["TRASH", "Label_done", "Label_held"];
  await f.verification.complete(protectedAccount, digest(sender), (await f.record()).token);
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.messages.get("a2")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.messages.get("a2")!.labelIds).not.toContain("Label_held");
});

test("manually adding pending sender to contacts releases held mail and bypasses verification", async () => {
  const f = fixture(); await f.processor.notification(protectedAccount, "200");
  f.gmail.contacts.add(sender); await next(f, "a2");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a2")!.labelIds).toContain("INBOX");
});

test("bad token, expired link and mailbox contention cannot create contacts or release mail", async () => {
  const f = fixture(); await f.processor.notification(protectedAccount, "200");
  await expect(f.verification.complete(protectedAccount, digest(sender), "x".repeat(43)))
    .rejects.toThrow("invalid_verification_link");
  const stored = (await f.senders.read(account.id, digest(sender)))!;
  stored.record.expiresAt = 0;
  await f.senders.write(account.id, digest(sender), stored.record, stored.generation);
  await expect(f.verification.complete(protectedAccount, digest(sender), stored.record.token))
    .rejects.toThrow("invalid_verification_link");
  f.state.snapshot!.data.lease = { owner: "other", expiresAt: Date.now() + 100000 };
  await expect(f.verification.complete(protectedAccount, digest(sender), stored.record.token))
    .rejects.toThrow("mailbox_busy");
  expect(f.gmail.contacts.size).toBe(0);
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
});

test("automated/list/null-envelope messages are held without challenge loops", async () => {
  for (const [name, value] of [["Auto-Submitted", "auto-replied"], ["List-Id", "list.example"],
    ["Return-Path", "<>"], ["Precedence", "bulk"], ["Authentication-Results", "mx.google.com; dmarc=fail"]]) {
    const f = fixture(); f.gmail.messages.get("a1")!.payload!.headers!.push({ name: name!, value: value! });
    await f.processor.notification(protectedAccount, "200");
    expect(f.gmail.notices).toHaveLength(0);
    expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  }
});

test("ambiguous sender is neither challenged nor AI-archived", async () => {
  const f = fixture(); f.gmail.messages.get("a1")!.payload!.headers!.push({ name: "From", value: "other@example.com" });
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(0);
  expect(address("A <a@example.com>\r\nBcc: other@example.com")).toBeNull();
  expect(senderOf(message())).toBe(sender);
  expect(mayChallenge(message(), "no-reply@example.com")).toBe(false);
});

test("multiple mailboxes in a single From header cannot be challenged or archived", async () => {
  const f = fixture();
  f.gmail.messages.get("a1")!.payload!.headers!.find(h => h.name === "From")!.value =
    "first@example.net, Last <last@example.com>";
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
});

test("verification config requires an HTTPS origin and site key", () => {
  expect(() => configSchema.parse({ provider: { kind: "jev" }, accounts: [protectedAccount] })).toThrow();
  for (const publicUrl of ["http://verify.example.com", "https://user:password@verify.example.com", "https://verify.example.com/path"]) {
    expect(() => configSchema.parse({ ...config, verification: { ...settings, publicUrl } })).toThrow();
  }
});

test("exact test subject challenges self and trusted senders with ordinary verification off", async () => {
  for (const from of [account.email, sender]) {
    const f = fixture();
    const testAccount = accountSchema.parse({ ...account, humanVerification: false, humanVerificationTest: true, archiveEnabled: false });
    f.gmail.contacts.add(from);
    f.gmail.corresponded = true;
    f.gmail.addContact = async () => { throw new Error("A test must not change contacts"); };
    const deliver = async (id: string, cursor: string, subject: string) => {
      const m = message(id, ["INBOX", "UNREAD"]);
      m.payload!.headers = [{ name: "From", value: from }, { name: "To", value: account.email }, { name: "Subject", value: subject }];
      f.gmail.messages.set(id, m);
      f.gmail.pages = [{ historyId: cursor, history: [{ id: cursor, messagesAdded: [{ message: { id } }] }] }];
      await f.processor.notification(testAccount, cursor);
    };
    await deliver("test1", "200", "Human verification test");
    expect(f.gmail.messages.get("test1")!.labelIds).not.toContain("INBOX");
    expect(f.gmail.messages.get("test1")!.labelIds).toContain("Label_held");
    expect(f.gmail.notices).toHaveLength(1);
    expect(f.classified()).toBe(1);
    const key = digest(`test:${from}:test1`);
    const record = (await f.senders.read(account.id, key))!.record;
    expect(record.test).toBe(true);
    await f.verification.complete(testAccount, key, record.token);
    expect(f.gmail.messages.get("test1")!.labelIds).toContain("INBOX");
    expect(f.gmail.messages.get("test1")!.labelIds).toContain("UNREAD");
    expect(f.gmail.messages.get("test1")!.labelIds).not.toContain("Label_held");
    expect(f.gmail.notices).toHaveLength(2);
    expect(f.gmail.notices[1]!.body).toBe(`You are verified for ${account.email}. Your held inbox messages have been released.`);
    expect(await f.senders.read(account.id, digest(from))).toBeNull();
    await f.verification.complete(testAccount, key, record.token);
    expect(f.gmail.notices).toHaveLength(2);
    await deliver("test2", "250", "Human verification test");
    expect(f.gmail.messages.get("test2")!.labelIds).not.toContain("INBOX");
    expect(f.gmail.notices).toHaveLength(3);
    await deliver("normal", "300", "Re: Human verification test");
    expect(f.gmail.messages.get("normal")!.labelIds).toContain("INBOX");
    expect(f.gmail.notices).toHaveLength(3);
  }
});

test("test subject requires exact case and spacing, with a single Subject header", async () => {
  const { isVerificationTest } = await import("../src/verification.js");
  const a = accountSchema.parse({ ...account, humanVerificationTest: true });
  for (const subject of ["human verification test", "Human verification test ", " Human verification test", "Re: Human verification test"]) {
    const m = message(); m.payload!.headers!.push({ name: "Subject", value: subject });
    expect(isVerificationTest(a, m)).toBe(false);
  }
  const m = message(); m.payload!.headers!.push({ name: "Subject", value: "Human verification test" });
  expect(isVerificationTest(a, m)).toBe(true);
  expect(isVerificationTest(account, m)).toBe(false);
  m.payload!.headers!.push({ name: "Subject", value: "Human verification test" });
  expect(isVerificationTest(a, m)).toBe(false);
  expect(() => configSchema.parse({ provider: { kind: "jev" }, accounts: [a] })).toThrow();
});

function handlerFixture(overrides: object = {}) {
  const token = "x".repeat(43); let completions = 0, challenges = 0;
  const handler = createVerificationHandler(config, { complete: async () => { completions++; } }, "secret",
    (async (_url: URL | RequestInfo, init?: RequestInit) => {
      challenges++;
      expect(new URLSearchParams(init?.body as URLSearchParams).get("secret")).toBe("secret");
      return Response.json({ success: true, hostname: "verify.example.com", action: "verify_sender", cdata: digest(token), ...overrides });
    }) as Fetch, () => {});
  const request = (body: object = {}, origin = settings.publicUrl) => new Request(`${origin}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify({ account: account.id, sender: digest(sender), token, challenge: "turnstile-token", ...body }),
  });
  return { handler, request, completions: () => completions, challenges: () => challenges };
}

test("public page is inert on GET; privileged routes are absent and tokens aren't in HTML", async () => {
  const f = handlerFixture();
  const page = await f.handler(new Request(`${settings.publicUrl}/verify`));
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain("challenges.cloudflare.com/turnstile");
  for (const path of ["/pubsub", "/renew"]) expect((await f.handler(new Request(`${settings.publicUrl}${path}`, { method: "POST" }))).status).toBe(404);
  expect(f.challenges()).toBe(0); expect(f.completions()).toBe(0);
});

test("server verifies Turnstile success, hostname, action and token binding before completion", async () => {
  for (const overrides of [{ success: false }, { hostname: "attacker.example" }, { action: "other" }, { cdata: "wrong" }]) {
    const f = handlerFixture(overrides);
    expect((await f.handler(f.request())).status).toBe(400);
    expect(f.completions()).toBe(0);
  }
  const f = handlerFixture(); expect((await f.handler(f.request())).status).toBe(200); expect(f.completions()).toBe(1);
});

test("invalid origins, missing proof, oversized and invalid account inputs never complete", async () => {
  const f = handlerFixture();
  expect((await f.handler(f.request({}, "https://attacker.example"))).status).toBe(403);
  expect((await f.handler(f.request({ challenge: "" }))).status).toBe(400);
  expect((await f.handler(f.request({ token: "x".repeat(5000) }))).status).toBe(413);
  expect((await f.handler(f.request({ account: "unknown" }))).status).toBe(400);
  expect(f.completions()).toBe(0); expect(f.challenges()).toBe(0);
});


test("production defaults enable archiving and verification with diagnostics off", () => {
  const { humanVerification, archiveEnabled, humanVerificationTest, ...base } = account;
  const defaults = accountSchema.parse(base);
  expect(defaults.archiveEnabled).toBe(true);
  expect(defaults.humanVerification).toBe(true);
  expect(defaults.humanVerificationTest).toBe(false);
  expect(() => configSchema.parse({ provider: { kind: "jev" }, accounts: [base] })).toThrow();
  expect(configSchema.parse({ provider: { kind: "jev" }, verification: settings, accounts: [base] }).accounts[0]!.humanVerification).toBe(true);
});


test("BIMI exemption bypasses verification without creating a contact", async () => {
  const f = fixture(async () => decision, { allows: async () => true });
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("Label_receipts");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_done");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.gmail.contacts.size).toBe(0);
  expect(f.senders.values.size).toBe(0);
});

test("BIMI exemption is per message and can release its own interrupted hold", async () => {
  let allow = false;
  const f = fixture(undefined, { allows: async () => allow });
  await f.processor.notification(protectedAccount, "200");
  allow = true;
  await next(f, "a2");
  expect(f.gmail.messages.get("a2")!.labelIds).toContain("INBOX");
  expect((await f.record()).pending.map(p => p.id)).toEqual(["a1"]);
  allow = false;
  await next(f, "a3", "300");
  expect(f.gmail.messages.get("a3")!.labelIds).toContain("Label_held");
  allow = true;
  f.gmail.pages = [{ historyId: "400", history: [{ id: "400", messagesAdded: [{ message: { id: "a1" } }] }] }];
  await f.processor.notification(protectedAccount, "400");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect((await f.record()).pending.map(p => p.id)).toEqual(["a3"]);
  expect(f.gmail.contacts.size).toBe(0);
  expect(f.gmail.notices).toHaveLength(1);
});

test("expected account mail reaches inbox without a challenge or permanent sender trust", async () => {
  const f = fixture(async () => ({ ...decision, label: null, action: "deliver" as const, actionProbability: 0.99 }));
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.gmail.contacts.size).toBe(0);
  expect(f.senders.values.size).toBe(0);
  expect(await f.state.isProcessed(account.id, "a1")).toBe(true);
});

test("inbox cold outreach requires verification while archived mail never does", async () => {
  for (const archive of [true, false]) {
    const f = fixture(async () => archive ? decision : verifyDecision);
    await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
    expect(f.gmail.messages.get("a1")!.labelIds?.includes("Label_held")).toBe(!archive);
    expect(f.gmail.notices).toHaveLength(archive ? 0 : 1);
  }
});

test("protected useful mail skips verification even when an archive safeguard keeps it in inbox", async () => {
  const f = fixture(async () => ({ ...decision, action: "deliver" as const, actionProbability: 0.99 }));
  f.gmail.messages.get("a1")!.labelIds!.push("IMPORTANT");
  await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(0);
});


test("a filter archiving between classification and quarantine prevents a new hold", async () => {
  const f = fixture();
  const read = f.gmail.message.bind(f.gmail);
  let minimalReads = 0;
  f.gmail.message = async (id, format) => {
    if (format === "minimal" && ++minimalReads === 2) {
      f.gmail.messages.get(id)!.labelIds = [];
    }
    return read(id, format);
  };
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
});


test("one classifier call receives existing sender and custom-domain context", async () => {
  const f=fixture();f.gmail.domainCorresponded=true;
  let calls=0;
  const processor=new Processor({state:f.state,gmail:()=>f.gmail,verification:f.verification,log:()=>{},classify:async(_account,email)=>{
    calls++;
    expect(email.senderContext).toMatchObject({sentToSameCustomDomain:true,contact:false,previousCorrespondence:false});
    return {...decision,action:"deliver",actionProbability:.95};
  }});
  await processor.notification(protectedAccount,"200");
  expect(calls).toBe(1);expect(f.gmail.notices).toHaveLength(0);
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
});

test("a delivery after category abstention skips verification", async () => {
  const f=fixture(async()=>({...decision,action:"deliver" as const,label:null,actionProbability:.8}));
  await f.processor.notification(protectedAccount,"200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.notices).toHaveLength(0);
});

test("trusted company domain bypasses verification even when the model chooses verify", async () => {
  const f = fixture(async () => ({ ...decision, action: "verify" as const }));
  f.gmail.domainCorresponded = true;
  await f.processor.notification(protectedAccount, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(0);
  expect(f.senders.values.size).toBe(0);
});

test("trusted company mail still follows the archive policy", async () => {
  const f = fixture(async () => ({ ...decision, action: "file" as const }));
  f.gmail.domainCorresponded = true;
  await f.processor.notification({ ...protectedAccount, archiveEnabled: true }, "200");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect(f.gmail.notices).toHaveLength(0);
});

test("new company trust releases a resumed hold without sending another email", async () => {
  const f = fixture();
  await f.processor.notification(protectedAccount, "200");
  expect((await f.record()).pending).toHaveLength(1);
  f.gmail.domainCorresponded = true;
  f.gmail.pages = [{ historyId: "250", history: [{ id: "250", messagesAdded: [{ message: { id: "a1" } }] }] }];
  await f.processor.notification(protectedAccount, "250");
  expect(f.gmail.messages.get("a1")!.labelIds).toContain("INBOX");
  expect(f.gmail.messages.get("a1")!.labelIds).not.toContain("Label_held");
  expect((await f.record()).pending).toHaveLength(0);
  expect(f.gmail.notices).toHaveLength(1);
  expect(f.gmail.contacts.size).toBe(0);
});

test("empty, unreadable or data-only bodies cause no classification, hold, or notice", async () => {
  for (const body of [undefined, {data: "!!!"}, {data: Buffer.from(" ").toString("base64url")},
    {data: Buffer.from("x".repeat(41000)).toString("base64url")}]) {
    const f = fixture();
    f.gmail.messages.get("a1")!.payload!.body = body;
    await f.processor.notification(protectedAccount, "200");
    expect(f.classified()).toBe(0);
    expect(f.gmail.modifications).toHaveLength(0);
    expect(f.gmail.notices).toHaveLength(0);
    expect(f.senders.values.size).toBe(0);
    expect(f.state.snapshot!.data.historyId).toBe("200");
  }
});

test("shortened readable bodies follow the model action, with archive before verification", async () => {
  for (const archive of [true, false]) {
    const f = fixture(async () => archive ? decision : verifyDecision);
    f.gmail.messages.get("a1")!.payload!.body = {
      data: Buffer.from("Readable email details. ".repeat(3000)).toString("base64url"),
    };
    await f.processor.notification({...protectedAccount, archiveEnabled: true}, "200");
    expect(f.classified()).toBe(1);
    expect(f.gmail.messages.get("a1")!.labelIds!.includes("Label_receipts")).toBe(archive);
    expect(f.gmail.messages.get("a1")!.labelIds!.includes("Label_held")).toBe(!archive);
    expect(f.gmail.notices.length).toBe(archive ? 0 : 1);
  }
});

test("a resumed verification attempt also requires a readable body", async () => {
  const f = fixture();
  await f.processor.notification(protectedAccount, "200");
  const modifications = f.gmail.modifications.length;
  f.gmail.messages.get("a1")!.payload!.body = undefined;
  f.gmail.pages = [{historyId:"250",history:[{id:"250",messagesAdded:[{message:{id:"a1"}}]}]}];
  await f.processor.notification(protectedAccount,"250");
  expect(f.gmail.modifications).toHaveLength(modifications);
  expect(f.classified()).toBe(1);
  expect(f.gmail.notices).toHaveLength(1);
});

test("verification requires its minimum score while lower scores keep mail in the inbox", async () => {
  for (const score of [.7499,.75]) {
    const f=fixture(async()=>({...decision,label:null,action:score >= .75 ? "verify" as const : "deliver" as const,actionProbability:score}));
    await f.processor.notification(protectedAccount,"200");
    expect(f.gmail.notices.length).toBe(score>=.75?1:0);
    expect(f.gmail.messages.get("a1")!.labelIds!.includes("INBOX")).toBe(score<.75);
  }
});

test("suspicious mail gets its own label, including starred mail from a contact and the verification test subject", async () => {
  for (const archiveEnabled of [true, false]) {
    const f = fixture(async () => ({ ...decision, action: "suspicious", label: "Clefmail/Suspicious" }));
    f.gmail.contacts.add(sender);
    const msg = message("a1", ["INBOX", "STARRED", "UNREAD", "Label_receipts", "Label_personal"]);
    msg.payload!.headers!.push({ name: "Subject", value: "Human verification test" });
    f.gmail.messages.set("a1", msg);
    await f.processor.notification({ ...protectedAccount, humanVerificationTest: true, archiveEnabled }, "200");
    const labels = f.gmail.messages.get("a1")!.labelIds!;
    expect(labels.includes("INBOX")).toBe(!archiveEnabled);
    expect(labels.filter(id => id !== "INBOX").sort()).toEqual(["Label_personal", "Label_suspicious", "STARRED", "UNREAD"]);
    expect(f.gmail.notices).toHaveLength(0);
    expect(f.senders.values.size).toBe(0);
  }
});
