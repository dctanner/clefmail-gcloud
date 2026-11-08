// Explicit model evaluation using fictional messages; sends no email.
import { loadConfig } from "../src/config.js";
import { Classifier } from "../src/classifier.js";
import type { Decision } from "../src/decision.js";
import type { SenderContext } from "../src/sender-context.js";
import { readFile } from "node:fs/promises";
const cases: { name: string; expected: boolean | Decision["action"]; subject: string; body: string; from?: string; senderContext?: Partial<SenderContext> }[] = JSON.parse(await readFile(new URL("../tests/fixtures/verification-cases.json", import.meta.url), "utf8"));
const config = await loadConfig();
const model = new Classifier(config.provider);
let failures = 0;
for (const c of cases) {
  const decision = await model.classify(config.accounts[0]!, {
    from: c.from || "Example <sender@example.com>", to: "owner@example.net", subject: c.subject,
    senderContext: { ownAddress: false, contact: false, previousCorrespondence: false, verified: false, pendingVerification: false, sentToSameCustomDomain: false, bimiDmarc: false, verificationTest: false, ...c.senderContext },
    receivedAt: "", body: c.body, truncated: false, bodyUnavailable: false, originalBytes: Buffer.byteLength(c.body),
  }, AbortSignal.timeout(60_000));
  const passed = typeof c.expected === "boolean"
    ? (decision.action !== "verify") === c.expected
    : decision.action === c.expected;
  if (!passed) failures++;
  console.log(JSON.stringify({ name: c.name, expected: c.expected, action: decision.action, label: decision.label, probability: decision.actionProbability, passed }));
}
console.log(JSON.stringify({ cases: cases.length, failures }));
process.exitCode = failures ? 1 : 0;
