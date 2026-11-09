import { expect, test } from "bun:test";
import { newRunner, tick } from "../src/platformer-game.js";
import { configSchema } from "../src/config.js";
import { createVerificationHandler } from "../src/verification-handler.js";
import { completedCourse, startCourse } from "../src/platformer-proof.js";
import { account } from "./helpers.js";

const origin = "https://verify.example.com";
const config = configSchema.parse({ provider: { kind: "openai" }, accounts: [{ ...account, humanVerification: true }],
  verification: { publicUrl: origin, captcha: "platformer" } });
const secret = "test-only-signing-key".repeat(2);
const link = { account: account.id, sender: "a".repeat(64), token: "x".repeat(43) };
const post = (path: string, data: unknown) => new Request(origin + path, { method: "POST",
  headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

test("platformer serves its own page and requires a completed run before releasing mail", async () => {
  let completions = 0;
  const handler = createVerificationHandler(config, { complete: async () => { completions++; } }, secret,
    Object.assign(async () => { throw Error("Unexpected external request"); }, { preconnect: fetch.preconnect }));
  const page = await handler(new Request(origin + "/verify"));
  expect(await page.text()).toContain('id="game"');
  expect(page.headers.get("Content-Security-Policy")).not.toContain("cloudflare");
  const response = await handler(post("/verify/game", link));
  expect(response.status).toBe(200);
  const course = await response.json();
  expect(course.blocks).toHaveLength(2);
  for (const challenge of [true, "won", { ticket: course.ticket, moves: [[2, 160]] }])
    expect((await handler(post("/verify", { ...link, challenge }))).status).toBe(400);
  expect(completions).toBe(0);
  expect(() => createVerificationHandler(config, { complete: async () => {} }, "short")).toThrow();
  expect(() => configSchema.parse({ ...config, verification: { publicUrl: origin } })).toThrow();
});

test("the courier can retreat and needs a separate jump to clear each parcel", () => {
  for (const blocks of [[130, 330], [180, 380]]) {
    const runner = newRunner();
    const play = (keys: number, ticks: number) => {
      for (let i = 0; i < ticks; i++) tick(runner, keys, blocks);
    };
    play(2, 65);
    const firstStop = runner.x;
    expect(firstStop).toBeLessThan(blocks[0]!);
    play(1, 4);
    expect(runner.x).toBeLessThan(firstStop);
    play(2, 6);
    play(6, 100);
    expect(runner.cleared).toBe(1);
    expect(runner.x).toBeLessThan(blocks[1]!);
    expect(runner.won).toBe(false);
    play(2, 1);
    play(6, 100);
    expect(runner.cleared).toBe(2);
    expect(runner.won).toBe(true);
  }
});

test("a finished course is valid only for its original link and time window", () => {
  const now = 1_800_000_000_000;
  const { ticket } = startCourse(secret, link, now);
  const moves: [number, number][] = [[2, 65], [6, 100], [2, 1], [6, 100]];
  const proof = { ticket, moves };
  expect(completedCourse(secret, link, proof, now + 10_000)).toBe(true);
  expect(completedCourse(secret, link, proof, now + 610_000)).toBe(false);
  expect(completedCourse(secret, link, proof, now + 10)).toBe(false);
  expect(completedCourse(secret, { ...link, token: "y".repeat(43) }, proof, now + 10_000)).toBe(false);
});
