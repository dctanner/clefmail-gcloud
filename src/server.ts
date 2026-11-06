import { createServer } from "node:http";
import { loadConfig, env } from "./config.js";
import { errorCode, log } from "./errors.js";
import { createHandler } from "./handler.js";
import { createProcessor } from "./runtime.js";

async function main() {
  const config = await loadConfig();
  const subscription = env("PUBSUB_SUBSCRIPTION");
  const topic = env("GMAIL_TOPIC");
  if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(subscription) ||
      !/^projects\/[^/]+\/topics\/[^/]+$/.test(topic))
    throw new Error("Invalid Pub/Sub resource names");
  for (const account of config.accounts.filter(a => a.enabled)) env(account.refreshTokenEnv);
  env("GOOGLE_CLIENT_ID");
  env("GOOGLE_CLIENT_SECRET");
  const handler = createHandler(config, createProcessor(config), subscription, topic);
  const server = createServer(async (req, res) => {
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) {
          res.writeHead(413).end();
          req.resume();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const method = req.method || "GET";
      const request = new Request(new URL(req.url || "/", "http://localhost"), {
        method,
        headers: { "content-type": req.headers["content-type"] || "" },
        body: ["GET", "HEAD"].includes(method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      res.writeHead(response.status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end(await response.text());
    } catch (error) {
      log("http_failed", { code: errorCode(error) });
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  });
  server.requestTimeout = 15_000; // Receipt of request body, not processing time.
  server.headersTimeout = 10_000;
  // Cloud Run's container contract requires 0.0.0.0. Local development stays loopback-only.
  server.listen(Number(process.env.PORT || 8080), process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1", () => {
    const address = server.address();
    log("listening", { port: typeof address === "object" && address ? address.port : 0 });
  });
}

main().catch(error => {
  log("startup_failed", { code: errorCode(error) });
  process.exitCode = 1;
});
