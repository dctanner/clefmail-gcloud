import { expect, test } from "bun:test";
import { Classifier } from "../src/classifier.js";
import { Gmail } from "../src/gmail.js";
import { jsonRequest, type Fetch } from "../src/http.js";
import { account, answer, email } from "./helpers.js";

const stub = (fn: (url: string, init: RequestInit) => Promise<Response> | Response): Fetch =>
  ((url: any, init: RequestInit) => fn(String(url), init)) as Fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("Clef REST unwraps result; Jev uses direct answers; no fallback requests", async () => {
  for (const kind of ["clef", "jev"] as const) {
    const calls: string[] = [];
    const client = new Classifier(kind === "clef" ? { kind, accountId: "a".repeat(32) } : { kind, model: "jev-latest" },
      "synthetic-key", stub((url, init) => {
        calls.push(url);
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-key");
        const input = JSON.parse(String(init.body));
        expect(input.model).toBe(kind === "clef" ? "clef" : "jev-latest");
        expect(input.questions.archive.type).toBe("noul");
        expect(input.state.body).toBe(email.body);
        return json(kind === "clef" ? { success: true, result: answer() } : answer());
      }));
    expect(await client.classify(account, email)).toMatchObject({ label: "receipts", archive: true });
    expect(calls).toEqual([kind === "clef"
      ? `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/@cf/cloudflare/clef`
      : "https://api.typesafe.ai/v1/systemone"]);
  }
});

test("HTTP failures never expose provider response bodies or invoke fallback", async () => {
  let calls = 0;
  const client = new Classifier({ kind: "jev", model: "jev-latest" }, "secret", stub(() => {
    calls++; return json({ error: "PRIVATE EMAIL BODY AND TOKEN" }, 429);
  }));
  await expect(client.classify(account, email)).rejects.toThrow("classifier_http_429");
  expect(calls).toBe(1);
});

test("rejects Cloudflare error envelopes even when HTTP status is 200", async () => {
  const client = new Classifier({ kind: "clef", accountId: "a".repeat(32) }, "key",
    stub(() => json({ success: false, result: answer() })));
  await expect(client.classify(account, email)).rejects.toThrow("classifier_unsuccessful");
});

test("bounded JSON reader refuses large and invalid responses", async () => {
  await expect(jsonRequest("test", "https://example.com", {}, {
    fetch: stub(() => new Response("x".repeat(100))), maxBytes: 10,
  })).rejects.toThrow("test_response_limit");
  await expect(jsonRequest("test", "https://example.com", {}, {
    fetch: stub(() => new Response("not JSON")),
  })).rejects.toThrow("test_request_failed");
});

test("Gmail adapter uses messageAdded history and message-specific modify, never a mailbox search", async () => {
  const urls: string[] = [];
  const client = new Gmail({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" }, undefined,
    stub((url, init) => {
      urls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        expect(new URLSearchParams(init.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
        return json({ access_token: "access", expires_in: 3600 });
      }
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/history")) {
        expect(parsed.searchParams.get("historyTypes")).toBe("messageAdded");
        expect(parsed.searchParams.get("startHistoryId")).toBe("90071992547409931");
        expect(parsed.searchParams.has("q")).toBe(false);
        return json({ historyId: "90071992547409932", history: [] });
      }
      if (parsed.pathname.endsWith("/messages/ab/modify")) {
        expect(JSON.parse(String(init.body))).toEqual({
          addLabelIds: ["Label_done", "Label_receipts"], removeLabelIds: ["INBOX"],
        });
        return json({ id: "ab" });
      }
      if (parsed.pathname.endsWith("/watch")) {
        expect(JSON.parse(String(init.body))).toEqual({ topicName: "projects/p/topics/t" });
        return json({ historyId: "300", expiration: "9999999999999" });
      }
      throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    }));
  await client.history("90071992547409931");
  await client.modify("ab", ["Label_done", "Label_receipts"], ["INBOX"]);
  await client.watch("projects/p/topics/t");
  expect(urls.filter(url => url.includes("oauth2"))).toHaveLength(1);
  expect(urls.some(url => /\/messages\?/.test(url))).toBe(false);
  await expect(client.modify("ab", ["TRASH"], [])).rejects.toThrow("unsafe_label_mutation");
  await expect(client.modify("ab", ["Label_done"], ["STARRED"])).rejects.toThrow("unsafe_label_mutation");
});

test("runtime label lookup never creates missing labels; explicit setup does", async () => {
  let created = 0;
  const client = new Gmail({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" }, undefined,
    stub((url, init) => {
      if (url.includes("oauth2")) return json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/labels") && init.method === "GET") return json({ labels: [] });
      if (url.endsWith("/labels") && init.method === "POST") {
        const body = JSON.parse(String(init.body)); created++;
        return json({ id: `Label_${created}`, name: body.name, type: "user" });
      }
      throw new Error("Unexpected request");
    }));
  await expect(client.labels(account)).rejects.toThrow("gmail_label_missing_run_setup");
  expect(created).toBe(0);
  expect(await client.labels(account, true)).toEqual({ processed: "Label_1", options: { receipts: "Label_2" } });
  expect(created).toBe(2);
});
