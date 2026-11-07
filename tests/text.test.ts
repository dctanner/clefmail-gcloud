import { expect, test } from "bun:test";
import { BODY_MAX_BYTES, BODY_MAX_CHARS, clip, extract, received } from "../src/text.js";
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
  expect(clip("😀".repeat(10_000))).toBe("😀".repeat(BODY_MAX_BYTES / 4));
  const m = message(); m.payload!.body = { data: Buffer.from("Readable email content. ".repeat(3000)).toString("base64url") };
  const text = await extract(m, async () => ({ data: "" }));
  expect(text).toMatchObject({ truncated: true, bodyUnavailable: false });
  expect(text.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
  expect(text.body).toStartWith("Readable email content.");
});

test("malformed bodies are marked unreadable", async () => {
  for (const body of [{ data: "!!!" }, { data: Buffer.from([0xff]).toString("base64url") }]) {
    const m = message(); m.payload!.body = body;
    expect(await extract(m, async () => ({ data: "" }))).toMatchObject({ truncated: true, bodyUnavailable: true });
  }
});

test("large readable bodies retain a bounded prefix, including a cut Unicode character", async () => {
  const m = message();
  const body = "Readable details. ".repeat(40_000).slice(0, 524_285) + "😀 Final details.";
  m.payload!.body = { size: Buffer.byteLength(body), data: Buffer.from(body).toString("base64url") };
  const text = await extract(m, async () => ({ data: "" }));
  expect(text).toMatchObject({ truncated: true, bodyUnavailable: false });
  expect(text.body).toStartWith("Readable details.");
  expect(text.body).not.toContain("�");
  expect(Buffer.byteLength(text.body)).toBeLessThanOrEqual(BODY_MAX_BYTES);
});

test("strips short and line-wrapped data URLs as well as encoded HTML attributes", async () => {
  const m = message();
  m.payload!.body = { data: Buffer.from(
    'data:text/plain;base64,\nSGVsbG8=\nYour message. ' +
    'data:image/png;base64,\nQUJDREVGR0hJSktMTU5P\nUFFSU1RVVldYWVo=\nMore text. ' +
    '<a href="data&#58;text/plain;base64,SGVsbG8=">Download</a>'
  ).toString("base64url") };
  const text = await extract(m, async () => ({ data: "" }));
  expect(text.body).toContain("Your message.");
  expect(text.body).toContain("More text.");
  for (const data of ["data:", "SGVsbG8", "QUJDREVGR0hJSktMTU5P", "UFFSU1RVVldYWVo="])
    expect(text.body).not.toContain(data);
});

test("removes inline data and encoded blobs before spending the text budget", async () => {
  const blob = Buffer.from("encoded attachment bytes ".repeat(2000)).toString("base64");
  for (const mimeType of ["text/html", "text/plain"]) {
    const m = message();
    m.payload = { mimeType, body: { data: Buffer.from(
      `data:image/png;base64,${blob}\n${blob.match(/.{1,76}/g)!.join("\n")}\n` +
      `<img src="data:image/png;base64,${blob}"><svg><text>hidden picture</text></svg>` +
      `<a href="data:text/plain;base64,SGVsbG8=">Document</a><br>Payment received.\n` +
      `cid:image001@example.com <support@example.com> 2 < 3 &amp; 5 > 4`
    ).toString("base64url") } };
    const text = await extract(m, async () => { throw new Error("Unexpected attachment fetch"); });
    expect(text.body).toContain("Payment received.");
    expect(text.body).toContain("<support@example.com> 2 < 3 & 5 > 4");
    for (const unwanted of ["data:", "base64", "cid:", blob.slice(0, 30), "<img", "<svg", "hidden picture", "<br>"])
      expect(text.body).not.toContain(unwanted);
    expect(text.body.length).toBeLessThan(150);
  }
});

test("skips attachment parts even when Gmail provides their bytes inline", async () => {
  const m = message();
  const privateData = { data: Buffer.from("Private attachment contents").toString("base64url") };
  m.payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/plain", body: { data: Buffer.from("Readable body").toString("base64url") } },
    { mimeType: "text/plain", filename: "file.txt", body: privateData },
    { mimeType: "text/html", headers: [{name: "Content-Disposition", value: "attachment"}], body: privateData },
    { mimeType: "text/plain", headers: [{name: "Content-Type", value: 'text/plain; name="file.txt"'}], body: privateData },
    { mimeType: "text/plain", headers: [{name: "Content-Disposition", value: "inline; filename*0*=utf-8''private.txt"}], body: privateData },
    { mimeType: "application/pdf", body: privateData },
    { mimeType: "image/png", body: privateData },
  ] };
  const text = await extract(m, async () => { throw new Error("Unexpected attachment fetch"); });
  expect(text.body).toBe("Readable body");
});

test("strips HTML fragments and entity-escaped markup from plain MIME text", async () => {
  const m = message();
  m.payload!.body = { data: Buffer.from("Hello<br/>Your code is &lt;b&gt;123456&lt;/b&gt;.").toString("base64url") };
  expect((await extract(m, async () => ({data: ""}))).body).toBe("Hello\nYour code is 123456.");
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
