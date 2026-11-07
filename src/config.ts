import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SafeError } from "./errors.js";

export const PROCESSED_LABEL = "Clefmail/Processed";
export const HELD_LABEL = "Clefmail/Held";
const optionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/)
    .refine(v => !["no_match", "constructor", "prototype", "__proto__"].includes(v)),
  name: z.string().trim().min(1).max(100).refine(v => ![PROCESSED_LABEL, HELD_LABEL].includes(v)),
  description: z.string().trim().min(1).max(500),
}).strict();

export const accountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  email: z.string().email().transform(v => v.toLowerCase()),
  refreshTokenEnv: z.string().regex(/^GMAIL_[A-Z0-9_]+_REFRESH_TOKEN$/),
  prompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean().default(true),
  archiveEnabled: z.boolean().default(true),
  humanVerification: z.boolean().default(true),
  humanVerificationTest: z.boolean().default(false),
  probability: z.number().min(0.5).max(1).default(0.75),
  margin: z.number().min(0).max(1).default(0.15),
  verificationSkipThreshold: z.number().min(0.5).max(1).default(0.7),
  archiveThreshold: z.number().min(0.5).max(1).default(0.95),
  labels: z.array(optionSchema).min(1).max(20),
}).strict().superRefine((v, ctx) => {
  for (const key of ["id", "name"] as const) {
    if (new Set(v.labels.map(l => l[key])).size !== v.labels.length)
      ctx.addIssue({ code: "custom", message: `Duplicate label ${key}` });
  }
});

export const configSchema = z.object({
  verification: z.object({
    publicUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash;
    }, "Use an HTTPS origin without a path"),
    siteKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  }).strict().optional(),
  provider: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("clef"),
      accountId: z.string().regex(/^[a-f0-9]{32}$/),
    }).strict(),
    z.object({
      kind: z.literal("jev"),
      model: z.string().regex(/^jev-[a-zA-Z0-9._-]{1,80}$/).default("jev-latest"),
    }).strict(),
  ]),
  accounts: z.array(accountSchema).min(1).max(10),
}).strict().superRefine((v, ctx) => {
  if (v.accounts.some(a => a.humanVerification || a.humanVerificationTest) && !v.verification)
    ctx.addIssue({ code: "custom", message: "Human verification requires verification settings" });
  for (const key of ["id", "email", "refreshTokenEnv"] as const) {
    if (new Set(v.accounts.map(a => a[key])).size !== v.accounts.length)
      ctx.addIssue({ code: "custom", message: `Duplicate account ${key}` });
  }
});

export type Config = z.infer<typeof configSchema>;
export type Account = z.infer<typeof accountSchema>;

export async function loadConfig(): Promise<Config> {
  let text: string;
  try {
    text = await readFile(process.env.CONFIG_PATH || "config.json", "utf8");
  } catch {
    throw new SafeError("config_file_unreadable");
  }
  try {
    return configSchema.parse(JSON.parse(text));
  } catch {
    throw new SafeError("invalid_configuration");
  }
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new SafeError(`missing_env_${name}`);
  return value;
}
