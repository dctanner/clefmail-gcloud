import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newRunner, tick } from "./platformer-game.js";

export const gameProof = z.object({
  ticket: z.string().max(180),
  moves: z.array(z.tuple([z.number().int().min(0).max(7), z.number().int().min(1).max(2700)])).min(1).max(220),
}).strict();

interface Link { account: string; sender: string; token: string }

function signature(secret: string, link: Link, course: string) {
  return createHmac("sha256", secret)
    .update(["clefmail-platformer-v1", link.account, link.sender, link.token, course].join("|")).digest();
}

export function startCourse(secret: string, link: Link, now = Date.now()) {
  const blocks = [randomInt(130, 181), randomInt(330, 381)];
  const course = [now, ...blocks, randomBytes(16).toString("hex")].join(".");
  return { blocks, ticket: course + "." + signature(secret, link, course).toString("hex") };
}

export function completedCourse(secret: string, link: Link, proof: z.infer<typeof gameProof>, now = Date.now()) {
  const match = /^(\d{13})\.(\d{3})\.(\d{3})\.[a-f0-9]{32}\.([a-f0-9]{64})$/.exec(proof.ticket);
  if (!match) return false;
  const age = now - Number(match[1]);
  if (age < 0 || age > 600_000) return false;
  const course = proof.ticket.slice(0, -65);
  if (!timingSafeEqual(signature(secret, link, course), Buffer.from(match[4]!, "hex"))) return false;
  const ticks = proof.moves.reduce((total, [, count]) => total + count, 0);
  if (ticks > 2700 || ticks * 1000 / 30 > age + 200) return false;
  const state = newRunner(), blocks = [Number(match[2]), Number(match[3])];
  for (const [keys, count] of proof.moves) {
    for (let i = 0; i < count; i++) tick(state, keys, blocks);
  }
  return state.won && state.cleared === 2;
}
