import type { Account, Config } from "./config.js";
import { request, decide, type Decision } from "./decision.js";
import { SafeError } from "./errors.js";
import { jsonRequest, type Fetch } from "./http.js";
import type { EmailText } from "./text.js";

export class Classifier {
  constructor(
    private provider: Config["provider"],
    private apiKey: string,
    private fetcher: Fetch = fetch,
  ) {}

  async classify(account: Account, email: EmailText, signal?: AbortSignal): Promise<Decision> {
    const clef = this.provider.kind === "clef";
    const url = this.provider.kind === "clef"
      ? `https://api.cloudflare.com/client/v4/accounts/${this.provider.accountId}/ai/run/@cf/cloudflare/clef`
      : "https://api.typesafe.ai/v1/systemone";
    const model = this.provider.kind === "clef" ? "clef" : this.provider.model;
    const input = request(account, email, model);
    const raw = await jsonRequest("classifier", url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }, { fetch: this.fetcher, signal, maxBytes: 131_072 });
    if (clef && raw?.success !== true) throw new SafeError("classifier_unsuccessful");
    return decide(clef ? raw.result : raw, account, input.state);
  }
}
