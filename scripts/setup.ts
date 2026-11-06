import { loadConfig } from "../src/config.js";
import { errorCode, log } from "../src/errors.js";
import { verifyMailbox } from "../src/gmail.js";
import { gmailFor } from "../src/runtime.js";

// Explicit owner-run operation: creates missing category/processing labels only.
// It neither reads message contents nor starts processing.
async function main() {
  const config = await loadConfig();
  for (const account of config.accounts.filter(a => a.enabled)) {
    const gmail = gmailFor(account, AbortSignal.timeout(60_000));
    await verifyMailbox(gmail, account);
    await gmail.labels(account, true);
    log("labels_ready", { account: account.id });
  }
}
main().catch(error => {
  log("setup_failed", { code: errorCode(error) });
  process.exitCode = 1;
});
