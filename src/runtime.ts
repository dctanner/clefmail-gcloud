import { Classifier } from "./classifier.js";
import { env, type Account, type Config } from "./config.js";
import { Gmail } from "./gmail.js";
import { Processor } from "./processor.js";
import { GcsStateStore } from "./state.js";

export function gmailFor(account: Account, signal?: AbortSignal): Gmail {
  return new Gmail({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env(account.refreshTokenEnv),
  }, signal);
}

export function createProcessor(config: Config): Processor {
  const classifier = new Classifier(config.provider, env("CLASSIFIER_API_KEY"));
  return new Processor({
    state: new GcsStateStore(env("STATE_BUCKET")),
    gmail: gmailFor,
    classify: (account, email, signal) => classifier.classify(account, email, signal),
  });
}
