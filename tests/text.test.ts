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

test("HTML-only body is converted to text without fetching external resources", async () => {
  const m = message(); m.payload!.mimeType = "text/html";
  m.payload!.body = { data: Buffer.from('<p>Your code is <b>123456</b> &amp; expires soon.</p><script>bad()</script><img src="https://example.com/track"><p hidden>hidden</p>').toString('base64url') };
  const text = await extract(m, async () => { throw new Error("Unexpected fetch"); });
  expect(text.bodyUnavailable).toBe(false);
  expect(text.body).toContain("Your code is 123456 & expires soon.");
  expect(text.body).not.toContain("bad");
  expect(text.body).not.toContain("hidden");
  expect(text.body).not.toContain("track");
});

test("legitimate plain body via attachment ID is supported", async () => {
  const m = message(); m.payload!.body = { attachmentId: "body", size: 5 };
  let calls = 0;
  const text = await extract(m, async id => { calls++; expect(id).toBe("body"); return { data: "aGVsbG8", size: 5 }; });
  expect(text.body).toBe("hello");
  expect(calls).toBe(1);
});

test("caps Unicode characters and UTF-8 bytes without splitting code points", async () => {
  expect(clip("😀".repeat(10_000)).length).toBe(20_000); // All 10,000 four-byte code points fit.
  const m = message(); m.payload!.body = { data: Buffer.from("a".repeat(41_000)).toString("base64url") };
  expect(await extract(m, async () => ({ data: "" }))).toMatchObject({ truncated: true, bodyUnavailable: false });
});

test("malformed or oversized bodies are marked unreadable", async () => {
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

test("HTML alternatives provide readable text when the plain alternative is a stub", async () => {
  const m=message();m.payload={mimeType:"multipart/alternative",parts:[
    {mimeType:"text/plain",body:{data:Buffer.from("View this message in a browser").toString("base64url")}},
    {mimeType:"text/html",body:{data:Buffer.from("<html><head><style>body{color:red}</style></head><body><p>Your documents have been received.</p></body></html>").toString("base64url")}},
  ]};
  const text=await extract(m,async()=>{throw new Error("Unexpected fetch");});
  expect(text.body).toBe("Your documents have been received.");
  expect(text.bodyUnavailable).toBe(false);
});

test("HTML documents mislabeled as plain text are converted", async () => {
  const m=message();m.payload!.body={data:Buffer.from("<!DOCTYPE html><html><body><p>Your request is complete.</p></body></html>").toString("base64url")};
  expect((await extract(m,async()=>({data:""}))).body).toBe("Your request is complete.");
});

test("deep HTML conversion is marked truncated", async () => {
  const m=message();m.payload!.mimeType="text/html";
  m.payload!.body={data:Buffer.from("<div>".repeat(250)+"hidden deep content"+"</div>".repeat(250)).toString("base64url")};
  expect((await extract(m,async()=>({data:""}))).truncated).toBe(true);
});


test("formatted HTML fragments in plain MIME parts become text", async () => {
  const m=message();m.payload!.body={data:Buffer.from('Your request is <b>received</b>. Read <a href="https://example.com/help">help</a>.').toString("base64url")};
  const text=await extract(m,async()=>({data:""}));
  expect(text.body).toContain("Your request is received.");
  expect(text.body).not.toContain("<b>");
  expect(text.body).not.toContain("<a");
});
