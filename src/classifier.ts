import { openaiPrompt, openaiAnswers } from "./openai-decisions.js";
import { env, type Account, type Config } from "./config.js";
import { request, decide, type Decision } from "./decision.js";
import { SafeError } from "./errors.js";
import { jsonRequest, type Fetch } from "./http.js";
import type { EmailText } from "./text.js";

export class Classifier {
  constructor(
    private provider: Config["provider"],
    private apiKey: string = env(provider.kind === "openai" ? "OPENAI_API_KEY" : "CLASSIFIER_API_KEY"),
    private fetcher: Fetch = fetch,
  ) {}

  async classify(account: Account, email: EmailText, signal?: AbortSignal): Promise<Decision> {
    const clef = this.provider.kind === "clef";
    const openai = this.provider.kind === "openai";
    const url = this.provider.kind === "clef"
      ? `https://api.cloudflare.com/client/v4/accounts/${this.provider.accountId}/ai/run/@cf/cloudflare/clef`
      : openai ? "https://api.openai.com/v1/decisions" : "https://api.typesafe.ai/v1/systemone";
    const model = this.provider.kind === "clef" ? "clef" : this.provider.model;
    const input = request(account, email, model, openai ? openaiPrompt : undefined);
    const raw = await jsonRequest("classifier", url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(openai ? openaiPrompt(input) : input),
    }, { fetch: this.fetcher, signal, maxBytes: 131_072 });
    if (clef && raw?.success !== true) throw new SafeError("classifier_unsuccessful");
    const answers = openai ? openaiAnswers(raw) : clef ? raw.result : raw;
    return decide(answers, account, input.state);
  }
}
