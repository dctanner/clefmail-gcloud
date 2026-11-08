import { Classifier } from "./classifier.js";
import { env, type Account, type Config } from "./config.js";
import { Gmail } from "./gmail.js";
import { Processor } from "./processor.js";
import { GcsStateStore } from "./state.js";
import { GcsSenderStore, Verification } from "./verification.js";

export function gmailFor(account: Account, signal?: AbortSignal): Gmail {
  return new Gmail({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env(account.refreshTokenEnv),
  }, signal);
}

export function createProcessor(config: Config): Processor {
  const classifier = new Classifier(config.provider);
  return new Processor({
    state: new GcsStateStore(env("STATE_BUCKET")),
    gmail: gmailFor,
    classify: (account, email, signal) => classifier.classify(account, email, signal),
    verification: config.verification ? createVerification(config) : undefined,
  });
}

export function createVerification(config: Config): Verification {
  if (!config.verification) throw new Error("Verification settings required");
  return new Verification({
    state: new GcsStateStore(env("STATE_BUCKET")),
    senders: new GcsSenderStore(env("STATE_BUCKET")),
    gmail: gmailFor,
    publicUrl: config.verification.publicUrl,
  });
}
