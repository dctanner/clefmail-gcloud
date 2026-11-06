import { expect, test } from "bun:test";
import { BimiPolicy } from "../src/bimi.js";
import { message } from "./helpers.js";

const record = [["v=BIMI1; l=https://example.com/logo.svg; ", "a=https://example.com/mark.pem;"]];
function mail(auth = "mx.google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com") {
  const m = message();
  m.payload!.headers = [
    { name: "Received", value: "from mail.example.com by mx.google.com with ESMTPS" },
    { name: "Authentication-Results", value: auth },
    { name: "From", value: "sender@example.com" },
  ];
  return m;
}

test("DMARC pass plus a published HTTPS certificate URL permits verification bypass", async () => {
  const names: string[] = [];
  const policy = new BimiPolicy(async name => { names.push(name); return record; });
  expect(await policy.allows(mail())).toBe(true);
  expect(await policy.allows(mail())).toBe(true);
  expect(names).toEqual(["default._bimi.example.com"]);
});

test("respects selector and authenticated parent fallback", async () => {
  const m = mail();
  m.payload!.headers!.find(h => h.name === "From")!.value = "sender@mail.example.com";
  m.payload!.headers!.push({ name: "BIMI-Selector", value: "v=BIMI1; s=transactional;" });
  const names: string[] = [];
  const policy = new BimiPolicy(async name => { names.push(name); return name.includes("_bimi.mail.") ? [] : record; });
  expect(await policy.allows(m)).toBe(true);
  expect(names).toEqual(["transactional._bimi.mail.example.com", "transactional._bimi.example.com"]);
});

test("failed, unrelated and untrusted authentication never triggers DNS", async () => {
  const policy = new BimiPolicy(async () => { throw new Error("Unexpected lookup"); });
  for (const auth of ["mx.google.com; dmarc=fail header.from=example.com", "mx.google.com; dmarc=pass header.from=other.com", "evil.example; dmarc=pass header.from=example.com", "mx.google.com; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com"]) {
    expect(await policy.allows(mail(auth))).toBe(false);
  }
  const missingHop = mail(); missingHop.payload!.headers!.shift();
  expect(await policy.allows(missingHop)).toBe(false);
  const forged = mail("mx.google.com; dmarc=fail header.from=example.com");
  forged.payload!.headers!.push({ name: "Received", value: "from attacker by sender.example" }, { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" });
  expect(await policy.allows(forged)).toBe(false);
});

test("requires one valid BIMI record with an HTTPS certificate URL", async () => {
  for (const records of [[], [["v=BIMI1; l=https://example.com/logo.svg"]], [["v=BIMI1; a="]], [["v=BIMI1; a=http://example.com/cert"]], [["v=BIMI1; a=https://user:secret@example.com/cert"]], [["v=BIMI1; a=garbage"]], [...record, ...record], [["v=BIMI1; a=https://example.com/a; a=https://example.com/b"]]]) {
    expect(await new BimiPolicy(async () => records).allows(mail())).toBe(false);
  }
  expect(await new BimiPolicy(async () => { throw Object.assign(new Error(), { code: "ETIMEOUT" }); }).allows(mail())).toBe(false);
});

test("ambiguous or invalid selectors are rejected", async () => {
  for (const selectors of [["v=BIMI1; s=../../evil"], ["v=BIMI1; s=one", "v=BIMI1; s=two"], ["v=BIMI1; s=one; s=two"]]) {
    const m = mail();
    m.payload!.headers!.push(...selectors.map(value => ({ name: "BIMI-Selector", value })));
    expect(await new BimiPolicy(async () => record).allows(m)).toBe(false);
  }
});
