import { expect, test } from "bun:test";
import { createHandler } from "../src/handler.js";
import { SafeError } from "../src/errors.js";
import { config } from "./helpers.js";

const subscription = "projects/p/subscriptions/mail";
const topic = "projects/p/topics/mail";
const payload = (overrides: object = {}) => ({
  subscription,
  message: { messageId: "pubsub-id", data: Buffer.from(JSON.stringify({
    emailAddress: "owner@example.com", historyId: "90071992547409931", ...overrides,
  })).toString("base64") },
});
const req = (body: unknown, path = "/pubsub") => new Request(`http://localhost${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("decodes real Gmail Pub/Sub envelope and ACKs only after work finishes", async () => {
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const work = new Promise<void>(resolve => { finish = resolve; });
  let settled = false;
  const handler = createHandler(config, {
    async notification(account, id) {
      expect(account.id).toBe("personal");
      expect(id).toBe("90071992547409931");
      started(); await work;
    },
    async renew() { throw new Error("Not a renewal"); },
  }, subscription, topic, () => {});
  const response = handler(req(payload())).then(r => { settled = true; return r; });
  await ready;
  expect(settled).toBe(false);
  finish();
  expect((await response).status).toBe(204);
});

test("wrong subscription and invalid payloads never process", async () => {
  let calls = 0;
  const handler = createHandler(config, {
    async notification() { calls++; }, async renew() { calls++; },
  }, subscription, topic, () => {});
  expect((await handler(req({ ...payload(), subscription: "projects/evil/subscriptions/mail" }))).status).toBe(403);
  expect((await handler(req(payload({ historyId: true })))).status).toBe(400);
  expect((await handler(req(payload({ historyId: -5 })))).status).toBe(400);
  expect((await handler(req({ subscription, message: { messageId: "id", data: "!!!" } }))).status).toBe(400);
  expect((await handler(req("x".repeat(20_000)))).status).toBe(413);
  expect(calls).toBe(0);
});

test("unknown account is deliberately ACKed without exposing email in logs", async () => {
  const logs: unknown[] = [];
  const handler = createHandler(config, {
    async notification() { throw new Error("Must not process"); }, async renew() {},
  }, subscription, topic, (...fields) => { logs.push(fields); });
  expect((await handler(req(payload({ emailAddress: "private@example.com" })))).status).toBe(204);
  expect(JSON.stringify(logs)).not.toContain("private@example.com");
});

test("busy/failing processing returns retryable status and a sanitized log", async () => {
  const logs: unknown[] = [];
  const handler = createHandler(config, {
    async notification() { throw new SafeError("mailbox_busy"); }, async renew() {},
  }, subscription, topic, (...fields) => { logs.push(fields); });
  expect((await handler(req(payload()))).status).toBe(503);
  expect(JSON.stringify(logs)).toContain("mailbox_busy");
});

test("scheduler endpoint only renews; failures are not ACKed as success", async () => {
  let renewals = 0;
  const handler = createHandler(config, {
    async notification() { throw new Error("No processing on scheduler route"); },
    async renew(account, actualTopic) {
      renewals++; expect(account.id).toBe("personal"); expect(actualTopic).toBe(topic);
      throw new SafeError("gmail_http_403");
    },
  }, subscription, topic, () => {});
  expect((await handler(req({}, "/renew"))).status).toBe(503);
  expect(renewals).toBe(1);
});

test("no GET mutations or unadvertised API routes", async () => {
  const handler = createHandler(config, {
    async notification() {}, async renew() {},
  }, subscription, topic, () => {});
  expect((await handler(new Request("http://localhost/renew"))).status).toBe(405);
  expect((await handler(req({}, "/scan"))).status).toBe(404);
  expect((await handler(new Request("http://localhost/healthz"))).status).toBe(200);
});

test("numeric Gmail historyId (real payload shape) is accepted without precision loss", async () => {
  const seen: string[] = [];
  const handler = createHandler(config, {
    async notification(_account, id) { seen.push(id); }, async renew() {},
  }, subscription, topic, () => {});
  const data = Buffer.from('{"emailAddress":"owner@example.com","historyId":90071992547409931}').toString("base64");
  expect((await handler(req({ subscription, message: { messageId: "m", data } }))).status).toBe(204);
  expect(seen).toEqual(["90071992547409931"]);
});
