import { openaiPrompt } from "../src/openai-decisions.js";
import { expect, test } from "bun:test";
import { archiveBlock, decide, request } from "../src/decision.js";
import { configSchema } from "../src/config.js";
import { account, answer, config, decision, email } from "./helpers.js";

test("one model request chooses a category and exactly one action", () => {
  const input=request(account,email,"clef");
  expect(Object.keys(input.questions)).toEqual(["label","action"]);
  expect(Object.keys(input.questions.action.criteria)).toEqual(["archive","deliver","verify"]);
  expect(JSON.stringify(input)).not.toContain("refreshToken");
  const shortened = request(account,{...email,body:"Useful content. ".repeat(7000)},"clef");
  expect(shortened.state.truncated).toBe(true);
  expect(shortened.state.body.length).toBeLessThanOrEqual(12_000);
  expect(Buffer.byteLength(JSON.stringify(shortened))).toBeLessThanOrEqual(65_536);
});

test("archive intent and confidence are separate from Gmail safeguards", () => {
  expect(decide(answer(.99,.95),account,email)).toMatchObject({action:"archive",archive:true});
  expect(decide(answer(.99,.94),account,email)).toMatchObject({action:"archive",archive:false});
  expect(archiveBlock(decision,account,["INBOX"])).toBeNull();
  for(const label of ["STARRED","IMPORTANT","SPAM","TRASH","DRAFT"])
    expect(archiveBlock(decision,account,["INBOX",label])).toBe("protected_message");
  expect(archiveBlock({...decision,bodyUnavailable:true},account,["INBOX"])).toBe("no_plain_body");
  expect(archiveBlock({...decision,truncated:true},account,["INBOX"])).toBeNull();
  expect(archiveBlock(decision,{...account,archiveEnabled:false},["INBOX"])).toBe("archive_disabled");
  expect(archiveBlock(decision,account,[])).toBe("not_inbox");
});

test("useful messages can be delivered even without a category match", () => {
  const raw=answer(.01);raw.answers.label.choice="no_match";
  raw.answers.action={type:"choice",choice:"deliver",confidence:.99,probabilities:{archive:0,deliver:.99,verify:.01}};
  expect(decide(raw,account,email)).toMatchObject({label:null,action:"deliver",archive:false});
});

test("invalid or absent actions are rejected rather than guessed", () => {
  for(const mutate of [
    (r:any)=>delete r.answers.action,
    (r:any)=>r.answers.action.choice="unknown",
    (r:any)=>r.answers.action.probabilities.archive="true",
    (r:any)=>r.answers.action.probabilities.deliver=.5,
    (r:any)=>r.answers.action.probabilities={archive:.1,deliver:.8,verify:.1},
  ]) { const raw=answer();mutate(raw);expect(()=>decide(raw,account,email)).toThrow("invalid_action_answer"); }
});

test("category validation rejects invented choices and invalid probabilities", () => {
  for(const mutate of [
    (r:any)=>r.answers.label.choice="invented",
    (r:any)=>delete r.answers.label.probabilities.no_match,
    (r:any)=>r.answers.label.probabilities.no_match=.5,
    (r:any)=>r.answers.label.probabilities={receipts:.1,no_match:.9},
  ]) {const raw=answer();mutate(raw);expect(()=>decide(raw,account,email)).toThrow();}
  expect(decide(answer(.7),account,email).label).toBeNull();
  expect(decide(answer(.85),account,email).label).toBe("receipts");
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
    expect(Object.keys(request(account, trustedEmail, "clef").questions.action.criteria)).toEqual(["archive", "deliver"]);
    const raw = answer();
    raw.answers.action = { type: "choice", choice: "deliver", confidence: .99, probabilities: { archive: .01, deliver: .99 } } as any;
    expect(decide(raw, account, trustedEmail).action).toBe("deliver");
    expect(() => decide(answer(), account, trustedEmail)).toThrow("invalid_action_answer");
  }
  expect(Object.keys(request(account, { ...email, senderContext: { ...facts, sentToSameCustomDomain: true, verificationTest: true } }, "clef").questions.action.criteria)).toContain("verify");
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
