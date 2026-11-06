import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { errorCode, log, SafeError } from "./errors.js";
import { jsonRequest, type Fetch } from "./http.js";
import { digest, verificationAccount, type Verification } from "./verification.js";

const inputSchema = z.object({
  account: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  sender: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  challenge: z.string().min(1).max(2048),
}).strict();

export function createVerificationHandler(config: Config, verification: Pick<Verification, "complete">,
  secret: string, fetcher: Fetch = fetch, logger = log) {
  if (!config.verification || !secret) throw new SafeError("verification_not_configured");
  const settings = config.verification;
  const origin = new URL(settings.publicUrl).origin;
  return async (request: Request): Promise<Response> => {
    const headers = {
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Type": "text/plain; charset=utf-8",
    };
    const reply = (text: string, status = 200) => new Response(text, { status, headers });
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return reply("ok");
    // Public mode cannot reach either privileged mail-processing endpoint.
    if (url.pathname !== "/verify") return reply("not found", 404);
    if (request.method === "GET") {
      const nonce = randomBytes(18).toString("base64");
      return new Response(page(settings.siteKey, nonce), { headers: {
        ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      } });
    }
    if (request.method !== "POST") return reply("method not allowed", 405);
    if (request.headers.get("origin") !== origin) return reply("invalid origin", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return reply("expected JSON", 415);
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) > 4096) return reply("request too large", 413);
      let input: z.infer<typeof inputSchema>;
      try { input = inputSchema.parse(JSON.parse(text)); }
      catch { return reply("Invalid verification request.", 400); }
      const account = verificationAccount(config, input.account);
      if (!account) return reply("Invalid or expired verification link.", 400);
      const result = z.object({
        success: z.boolean(), hostname: z.string().optional(), action: z.string().optional(),
        cdata: z.string().optional(),
      }).parse(await jsonRequest("turnstile", "https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", body: new URLSearchParams({ secret, response: input.challenge }),
      }, { fetch: fetcher, signal: AbortSignal.timeout(15_000), maxBytes: 16_384 }));
      if (!result.success || result.hostname !== new URL(origin).hostname ||
          result.action !== "verify_sender" || result.cdata !== digest(input.token))
        return reply("Human verification failed. Please try again.", 400);
      await verification.complete(account, input.sender, input.token);
      return reply("Verified! Your held inbox messages have been released. You can close this page.");
    } catch (error) {
      const code = errorCode(error);
      if (code === "invalid_verification_link") return reply("Invalid or expired verification link.", 400);
      logger("verification_failed", { code }); // Never log URLs, tokens, or addresses.
      return reply("Unable to finish yet. Please verify again to retry safely.", 503);
    }
  };
}

function page(siteKey: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify your email · Clefmail</title><style nonce="${nonce}">
body{font:17px/1.6 system-ui,sans-serif;background:#f5f7fb;color:#18233a;margin:0;padding:5vh 20px}
main{max-width:540px;margin:5vh auto;padding:32px;background:white;border:1px solid #dae0eb;border-radius:16px}
h1{line-height:1.2}button{font:inherit;background:#204ad5;color:white;border:0;border-radius:8px;padding:10px 20px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
</style></head><body><main><h1>Let your email through</h1>
<p>Confirm you are human to release your held email.</p>
<div id="challenge"></div><button id="submit" disabled>Verify and deliver</button>
<p id="status" role="status" aria-live="polite">Loading verification…</p>
</main>
<script nonce="${nonce}">
const parts = location.hash.slice(1).split('/');
history.replaceState(null, '', '/verify');
const status = document.getElementById('status'), button = document.getElementById('submit');
let challenge = '', widget;
const valid = parts.length === 3 && /^[a-z][a-z0-9_-]{0,49}$/.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[1]) && /^[a-zA-Z0-9_-]{43}$/.test(parts[2]);
window.ready = async () => {
  if (!valid) { status.textContent = 'Open the complete verification link from your email.'; return; }
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts[2]));
    const cData = Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
    widget = turnstile.render('#challenge', { sitekey: '${siteKey}', action: 'verify_sender', cData,
      callback: token => { challenge = token; button.disabled = false; status.textContent = 'Ready to verify.'; },
      'expired-callback': () => { challenge = ''; button.disabled = true; },
      'error-callback': () => { challenge = ''; button.disabled = true; status.textContent = 'Check could not load. Please reopen the email link to retry.'; }
    });
  } catch { status.textContent = 'Verification could not load. Please reopen the email link.'; }
};
button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = 'Verifying and delivering your messages…';
  try {
    const response = await fetch('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: parts[0], sender: parts[1], token: parts[2], challenge }) });
    status.textContent = await response.text();
    if (response.ok) { document.getElementById('challenge').replaceChildren(); button.hidden = true; return; }
  } catch { status.textContent = 'Connection interrupted. Please verify again to retry.'; }
  challenge = ''; turnstile.reset(widget);
});
</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&amp;render=explicit" async defer></script>
</body></html>`;
}
