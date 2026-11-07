// Explicit model evaluation using fictional messages; sends no email.
import { loadConfig, env } from "../src/config.js";
import { Classifier } from "../src/classifier.js";
import { readFile } from "node:fs/promises";
const cases: { name: string; expected: boolean; subject: string; body: string }[] = JSON.parse(await readFile(new URL("../tests/fixtures/verification-cases.json", import.meta.url), "utf8"));
const config = await loadConfig();
const model = new Classifier(config.provider, env("CLASSIFIER_API_KEY"));
let failures = 0;
for (const c of cases) {
  const decision = await model.classify(config.accounts[0]!, {
    from: "Example <sender@example.com>", to: "owner@example.net", subject: c.subject,
    receivedAt: "", body: c.body, truncated: false, bodyUnavailable: false, originalBytes: Buffer.byteLength(c.body),
  }, AbortSignal.timeout(60_000));
  const passed = decision.skipHumanVerification === c.expected;
  if (!passed) failures++;
  console.log(JSON.stringify({ name: c.name, expected: c.expected, bypass: decision.skipHumanVerification, probability: decision.verificationSkipProbability, passed }));
}
console.log(JSON.stringify({ cases: cases.length, failures }));
process.exitCode = failures ? 1 : 0;
