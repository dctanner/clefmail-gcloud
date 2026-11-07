import { describe, expect, test } from "bun:test";
import { archiveBlock, decide, request } from "../src/decision.js";
import { configSchema } from "../src/config.js";
import { account, answer, config, decision, email } from "./helpers.js";

describe("classification and archive policy", () => {
  test("live archiving defaults on, at 0.95", () => {
    expect(account.archiveEnabled).toBe(true);
    expect(account.archiveThreshold).toBe(0.95);
    expect(decide(answer(0.99, 0.95), account, email).archive).toBe(true);
    expect(decide(answer(0.99, 0.949), account, email).archive).toBe(false);
    expect(archiveBlock(decision, account, ["INBOX", "UNREAD"])).toBeNull();
  });
  test.each(["true", null, NaN, Infinity, -1, 1.1])("invalid archive probability %s cannot archive", value => {
    const result = decide(answer(0.99, value), account, email);
    expect(result.label).toBe("receipts");
    expect(result.archive).toBe(false);
    expect(result.archiveError).toBe("invalid_archive_answer");
  });
  test("missing archive answer leaves a valid label intact", () => {
    const raw: any = answer(); delete raw.answers.archive;
    expect(decide(raw, account, email)).toMatchObject({ label: "receipts", archive: false });
  });
  test("low confidence and no_match never permit archiving", () => {
    const low = decide(answer(0.7), account, email);
    expect(low.label).toBeNull();
    expect(archiveBlock(low, account, ["INBOX"])).toBe("label_abstention");
    const raw = answer(0.01); raw.answers.label.choice = "no_match";
    expect(decide(raw, account, email).label).toBeNull();
  });
  test("rejects invented choices, missing probabilities, invalid totals and nonmax choices", () => {
    for (const mutate of [
      (r: any) => { r.answers.label.choice = "invented"; },
      (r: any) => { delete r.answers.label.probabilities.no_match; },
      (r: any) => { r.answers.label.probabilities.no_match = 0.5; },
      (r: any) => { r.answers.label.probabilities = { receipts: 0.1, no_match: 0.9 }; },
    ]) {
      const raw = answer(); mutate(raw);
      expect(() => decide(raw, account, email)).toThrow();
    }
  });
  test.each(["STARRED", "IMPORTANT", "SPAM", "TRASH", "DRAFT"])("protects %s", label => {
    expect(archiveBlock(decision, account, ["INBOX", label])).toBe("protected_message");
  });
  test("body availability, truncation and kill switch gate archive", () => {
    expect(archiveBlock({ ...decision, bodyUnavailable: true }, account, ["INBOX"])).toBe("no_plain_body");
    expect(archiveBlock({ ...decision, truncated: true }, account, ["INBOX"])).toBe("truncated_body");
    expect(archiveBlock(decision, { ...account, archiveEnabled: false }, ["INBOX"])).toBe("archive_disabled");
    expect(archiveBlock(decision, account, [])).toBe("not_inbox");
    expect(decide(answer(0.85), account, { ...email, bodyUnavailable: true }).label).toBeNull();
  });
  test("one request contains label + archive and bounded untrusted state", () => {
    const result = request(account, email, "clef");
    expect(result.questions.label.type).toBe("choice");
    expect(result.questions.archive.type).toBe("noul");
    expect(result.state).toBe(email);
    expect(JSON.stringify(result)).not.toContain("refresh");
    expect(() => request(account, { ...email, body: "x".repeat(70_000) }, "clef")).toThrow("ai_request_limit");
  });
  test("configuration rejects duplicates and unsafe option IDs", () => {
    expect(() => configSchema.parse({ ...config, accounts: [account, account] })).toThrow();
    expect(() => configSchema.parse({ ...config, accounts: [{ ...account, labels: [account.labels[0], account.labels[0]] }] })).toThrow();
    expect(() => configSchema.parse({ ...config, accounts: [{ ...account, labels: [{ ...account.labels[0], id: "no_match" }] }] })).toThrow();
  });
});

test("verification bypass is independent of category and archive answers", () => {
  const raw: any = answer(0.01, 0.1);
  raw.answers.label.choice = "no_match";
  raw.answers.skipHumanVerification = { type: "noul", noul: 0.97 };
  expect(decide(raw, account, email)).toMatchObject({ label: null, archive: false, skipHumanVerification: true });
});

test("verification bypass requires valid confidence and complete body", () => {
  for (const value of [undefined, null, "true", NaN, -1, 1.1, 0.69]) {
    const raw = { ...answer(), answers: { ...answer().answers, skipHumanVerification: { type: "noul", noul: value } } };
    expect(decide(raw, account, email).skipHumanVerification).toBe(false);
  }
  const raw = { ...answer(), answers: { ...answer().answers, skipHumanVerification: { type: "noul", noul: 0.99 } } };
  expect(decide(raw, account, { ...email, truncated: true }).skipHumanVerification).toBe(false);
  expect(decide(raw, account, { ...email, bodyUnavailable: true }).skipHumanVerification).toBe(false);
  expect(decide(raw, account, email).skipHumanVerification).toBe(true);
});
