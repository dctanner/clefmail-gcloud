import { openaiPrompt } from "../src/openai-decisions.js";
import { expect, test } from "bun:test";
import { decide, request } from "../src/decision.js";
import { accountSchema, configSchema } from "../src/config.js";
import { account, answer, config, email } from "./helpers.js";

test("one model request chooses exactly one destination", () => {
  const input=request(account,email,"clef");
  expect(Object.keys(input.questions)).toEqual(["route"]);
  expect(Object.keys(input.questions.route.criteria)).toEqual(["file_receipts","suspicious","deliver","verify"]);
  expect(JSON.stringify(input)).not.toContain("refreshToken");
  const shortened = request(account,{...email,body:"Useful content. ".repeat(7000)},"clef");
  expect(shortened.state.truncated).toBe(true);
  expect(shortened.state.body.length).toBeLessThanOrEqual(12_000);
  expect(Buffer.byteLength(JSON.stringify(shortened))).toBeLessThanOrEqual(65_536);
});

test("filing uses the category threshold, with verification scored separately", () => {
  expect(decide(answer(.75), {...account, probability: .75}, email)).toMatchObject({action:"file", label:"receipts"});
  expect(decide(answer(.749), {...account, probability: .75}, email)).toMatchObject({action:"deliver", label:null});
  for (const score of [.749, .75]) {
    const raw = answer();
    raw.answers.route = {type:"choice", choice:"verify", confidence:score, probabilities:{suspicious:0,file_receipts:0,deliver:1-score,verify:score}};
    expect(decide(raw,account,email)).toMatchObject({action:score >= .75 ? "verify" : "deliver", label:null});
  }
});

test("invalid destinations and malformed probability distributions are rejected", () => {
  for (const change of [
    (r:any)=>delete r.answers.route, (r:any)=>r.answers.route.choice="archive",
    (r:any)=>delete r.answers.route.probabilities.deliver, (r:any)=>r.answers.route.probabilities.verify=.9,
    (r:any)=>r.answers.route.probabilities={file_receipts:.2,deliver:.8,verify:0},
    (r:any)=>r.answers.route.probabilities.verify="zero",
  ]) { const raw=answer(); change(raw); expect(()=>decide(raw,account,email)).toThrow("invalid_route_answer"); }
});
test("configuration rejects duplicate accounts and unsafe category IDs", () => {
  expect(()=>configSchema.parse({...config,accounts:[account,account]})).toThrow();
  expect(()=>configSchema.parse({...config,accounts:[{...account,labels:[account.labels[0],account.labels[0]]}]})).toThrow();
  expect(()=>configSchema.parse({...config,accounts:[{...account,labels:[{...account.labels[0],id:"no_match"}]}]})).toThrow();
});

test("trusted sender facts remove verification from the model's allowed actions", () => {
  const facts = { ownAddress: false, contact: false, verified: false, previousCorrespondence: false,
    pendingVerification: false, sentToSameCustomDomain: false, bimiDmarc: false, verificationTest: false };
  for (const key of ["ownAddress", "contact", "verified", "previousCorrespondence", "sentToSameCustomDomain", "bimiDmarc"]) {
    const trustedEmail = { ...email, senderContext: { ...facts, [key]: true } };
    expect(Object.keys(request(account, trustedEmail, "clef").questions.route.criteria)).toEqual(["file_receipts", "suspicious", "deliver"]);
    const raw = answer();
    raw.answers.route = { type: "choice", choice: "deliver", confidence: .99, probabilities: { suspicious: 0, file_receipts: .01, deliver: .99 } } as any;
    expect(decide(raw, account, trustedEmail).action).toBe("deliver");
    expect(() => decide(answer(), account, trustedEmail)).toThrow("invalid_route_answer");
  }
  expect(Object.keys(request(account, { ...email, senderContext: { ...facts, sentToSameCustomDomain: true, verificationTest: true } }, "clef").questions.route.criteria)).toContain("verify");
});


test("model requests require readable text after cleaning", () => {
  for (const patch of [{body: ""}, {body: "   "}, {bodyUnavailable: true}, {body: '<img src="data:image/png;base64,SGVsbG8=">'}])
    expect(() => request(account, {...email,...patch}, "clef")).toThrow("unreadable_body");
  expect(request(account, {...email, truncated: true}, "clef").state.body).toBe(email.body);
});

test("every model request strips markup and embedded resources, including local previews", () => {
  const input = request(account, {...email, body: '<p>Code <b>123456</b></p><br>data:text/plain;base64,SGVsbG8='}, "clef");
  expect(input.state.body).toBe("Code 123456");
});

test("body truncation respects JSON escaping and remaining request space", () => {
  const configured = {...account, prompt: "例".repeat(4000), labels: Array.from({length:20}, (_,i) => ({
    id: `category${i}`, name: `Category ${i}`, description: "例".repeat(450),
  }))};
  for (const text of ['"\\'.repeat(20_000), "😀".repeat(20_000), "汉字".repeat(20_000)]) {
    const input = request(configured, {...email, body:text}, "clef");
    expect(input.state.body.length).toBeGreaterThan(0);
    expect(input.state.body).not.toContain("�");
    expect(input.state.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(input.state.body)).toBeLessThanOrEqual(16_384);
    const native = openaiPrompt(request(configured, {...email, body:text}, "gpt-6-luna", openaiPrompt));
    expect(native.input[0]!.content[0]!.data.body.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(native))).toBeLessThanOrEqual(65_536);
  }
});

test("phishing has a separate threshold and stays available to trusted senders", () => {
  const configured = { ...account, probability: .5 };
  for (const score of [.749, .75]) {
    const raw = answer();
    raw.answers.route = { type: "choice", choice: "suspicious", confidence: score,
      probabilities: { suspicious: score, file_receipts: 0, deliver: 1 - score, verify: 0 } };
    const decision = decide(raw, configured, email);
    expect(decision.choice).toBe("suspicious");
    expect(decision.action).toBe(score >= .75 ? "suspicious" : "deliver");
  }
  const custom = { ...configured, labels: [{ id: "custom", name: "Clefmail/Suspicious", description: "Existing Gmail label" }] };
  expect(Object.keys(request(custom, email, "clef").questions.route.criteria)).toEqual(["suspicious", "deliver", "verify"]);
});

test("a winning filing category uses combined filing probability and leaves a winning delivery alone", () => {
  const configured = { ...account, labels: [...account.labels, { id: "updates", name: "Updates", description: "Routine updates" }] };
  expect(configured.probability).toBe(.70);
  function classify(choice: string, receipts: number, updates: number, deliver: number) {
    const probabilities = { file_receipts: receipts, file_updates: updates, deliver, verify: 0, suspicious: 0 };
    return decide({ model: "test", answers: { route: { type: "choice", choice, confidence: .9, probabilities } } }, configured, email);
  }
  expect(classify("file_receipts", .46, .24, .30)).toMatchObject({ action: "file", label: "receipts", actionProbability: .70 });
  expect(classify("file_receipts", .46, .23, .31)).toMatchObject({ action: "deliver", reason: "low_probability" });
  expect(classify("deliver", .30, .31, .39)).toMatchObject({ action: "deliver", reason: null });
});


test("older configs cannot recreate the retired Hold category", () => {
  const legacy = { id: "manual", name: "Clefmail/Hold", description: "Review" };
  const mailbox = accountSchema.parse({ ...account, labels: [...account.labels, legacy] });
  expect(mailbox.labels).toEqual(account.labels);
});
