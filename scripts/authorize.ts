import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { env, loadConfig } from "../src/config.js";
import { errorCode, log, SafeError } from "../src/errors.js";
import { jsonRequest } from "../src/http.js";

async function main() {
  const accountId = process.argv[2];
  const config = await loadConfig();
  const account = config.accounts.find(a => a.id === accountId);
  if (!account) throw new SafeError("usage_authorize_account_id");
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let redirect = "";
  let consumed = false;
  const completion = new Promise<void>((done, fail) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || req.method !== "GET") { res.writeHead(404).end(); return; }
      const submitted = url.searchParams.get("state") || "";
      if (consumed || !/^[A-Za-z0-9_-]{43}$/.test(submitted) ||
          !timingSafeEqual(Buffer.from(submitted), Buffer.from(state))) {
        res.writeHead(400).end("Invalid OAuth state.");
        return;
      }
      consumed = true;
      try {
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.has("error")) throw new SafeError("oauth_denied");
        const token = z.object({
          access_token: z.string().min(1), refresh_token: z.string().min(1), scope: z.string(),
        }).parse(await jsonRequest("google_oauth", "https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier,
          }),
        }, { maxBytes: 16_384 }));
        for (const scope of ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/contacts"])
          if (!token.scope.split(" ").includes(scope)) throw new SafeError("google_scope_missing");
        const profile = z.object({ emailAddress: z.string().email() }).parse(await jsonRequest(
          "gmail", "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { Authorization: `Bearer ${token.access_token}` } },
          { maxBytes: 16_384 },
        ));
        if (profile.emailAddress.toLowerCase() !== account.email) throw new SafeError("mailbox_identity_mismatch");
        const directory = resolve(".secrets");
        await mkdir(directory, { mode: 0o700, recursive: true });
        await chmod(directory, 0o700); // Tighten a pre-existing directory too.
        const path = resolve(directory, `${account.id}.token`);
        // Exclusive creation refuses symlinks and accidental credential overwrites.
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(token.refresh_token); } finally { await file.close(); }
        res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Authorization saved locally. You can close this tab.");
        log("authorization_saved", { account: account.id, path });
        done();
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Authorization failed. See the terminal for a sanitized error code.");
        fail(error);
      } finally {
        clearTimeout(timer);
        server.close();
      }
    });
    const timer = setTimeout(() => {
      server.closeAllConnections();
      server.close();
      fail(new SafeError("oauth_timeout"));
    }, 300_000);
    server.once("error", error => { clearTimeout(timer); fail(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return;
      redirect = `http://127.0.0.1:${address.port}/callback`;
      const query = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: "code",
        scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts",
        access_type: "offline", prompt: "consent", state,
        code_challenge: challenge, code_challenge_method: "S256",
      });
      // Run on the same machine as the browser. URL contains no access/refresh token.
      console.log(`Open this URL in your local browser:\nhttps://accounts.google.com/o/oauth2/v2/auth?${query}`);
    });
  });
  await completion;
}
main().catch(error => {
  log("authorization_failed", { code: errorCode(error) });
  process.exitCode = 1;
});
