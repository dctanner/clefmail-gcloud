import { expect, test } from "bun:test";
import { clip, extract, received } from "../src/text.js";
import { message } from "./helpers.js";

test("extracts body text, not HTML, snippets, attachments, or attached messages", async () => {
  const m = message();
  m.payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
    { mimeType: "text/html", body: { data: Buffer.from("<script>bad</script>").toString("base64url") } },
    { mimeType: "text/plain", filename: "private.txt", body: { attachmentId: "private" } },
    { mimeType: "message/rfc822", parts: [{ mimeType: "text/plain", body: { data: "c2VjcmV0" } }] },
  ] };
  const text = await extract(m, async () => { throw new Error("Must not download attachment"); });
  expect(text.body).toBe("body");
  expect(text.bodyUnavailable).toBe(false);
});

test("HTML only is header-only, never an archive-eligible fallback", async () => {
  const m = message(); m.payload!.mimeType = "text/html";
  const text = await extract(m, async () => ({ data: "" }));
  expect(text.bodyUnavailable).toBe(true);
  expect(text.body).toBe("");
});

test("legitimate plain body via attachment ID is supported", async () => {
  const m = message(); m.payload!.body = { attachmentId: "body", size: 5 };
  let calls = 0;
  const text = await extract(m, async id => { calls++; expect(id).toBe("body"); return { data: "aGVsbG8", size: 5 }; });
  expect(text.body).toBe("hello");
  expect(calls).toBe(1);
});

test("caps Unicode characters and UTF-8 bytes without splitting code points", async () => {
  expect(clip("😀".repeat(10_000)).length).toBe(12_288); // 6144 four-byte code points
  const m = message(); m.payload!.body = { data: Buffer.from("a".repeat(13_000)).toString("base64url") };
  expect(await extract(m, async () => ({ data: "" }))).toMatchObject({ truncated: true, bodyUnavailable: false });
});

test("malformed/oversized body is conservative header-only", async () => {
  for (const body of [{ data: "!!!" }, { size: 300_000, data: "aGVsbG8" }]) {
    const m = message(); m.payload!.body = body;
    expect(await extract(m, async () => ({ data: "" }))).toMatchObject({ truncated: true, bodyUnavailable: true });
  }
});

test("received mail includes read/archived and self-send, excludes sent-only/spam", () => {
  expect(received(message("a", []), "owner@example.com")).toBe(true);
  expect(received(message("a", ["SPAM"]), "owner@example.com")).toBe(false);
  expect(received(message("a", ["SENT"]), "owner@example.com")).toBe(true);
  expect(received(message("a", ["SENT"]), "someone-else@example.com")).toBe(false);
});
