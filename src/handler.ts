import { z } from "zod";
import type { Config } from "./config.js";
import { errorCode, log } from "./errors.js";
import { historyId } from "./gmail.js";
import type { Processor } from "./processor.js";

const envelopeSchema = z.object({
  subscription: z.string(),
  message: z.object({
    messageId: z.string().min(1).max(200),
    data: z.string().min(1).max(8192).regex(/^[A-Za-z0-9+/_-]+={0,2}$/),
  }),
});
const notificationSchema = z.object({ emailAddress: z.string().email(), historyId });

export function createHandler(
  config: Config,
  processor: Pick<Processor, "notification" | "renew">,
  subscription: string,
  topic: string,
  logger = log,
) {
  // Authentication belongs to Cloud Run IAM, not to a public application route.
  // The deployment must remain private; see deploy.sh and README.
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") return new Response("ok");
    if (!["/pubsub", "/renew"].includes(path)) return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    try {
      if (path === "/renew") {
        const deadline = Date.now() + 240_000;
        let failed = false;
        for (const account of config.accounts) {
          if (Date.now() > deadline - 65_000) { failed = true; break; }
          try {
            await processor.renew(account, topic);
          } catch (error) {
            failed = true;
            logger("renew_failed", { account: account.id, code: errorCode(error) });
          }
        }
        return new Response(null, { status: failed ? 503 : 204 });
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return new Response("expected JSON", { status: 415 });
      const text = await request.text();
      if (Buffer.byteLength(text) > 16_384) return new Response(null, { status: 413 });
      let envelope: z.infer<typeof envelopeSchema>;
      let notification: z.infer<typeof notificationSchema>;
      try {
        envelope = envelopeSchema.parse(JSON.parse(text));
        // Gmail documents historyId as a string but commonly sends a JSON number.
        // Quote bare digits before parsing so large IDs never lose precision.
        const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8")
          .replace(/("historyId"\s*:\s*)([0-9]+)(?=\s*[,}])/, '$1"$2"');
        notification = notificationSchema.parse(JSON.parse(decoded));
      } catch {
        return new Response("invalid notification", { status: 400 });
      }
      if (envelope.subscription !== subscription) return new Response(null, { status: 403 });
      const account = config.accounts.find(a => a.email === notification.emailAddress.toLowerCase());
      if (!account) {
        logger("unknown_mailbox_notification");
        return new Response(null, { status: 204 });
      }
      await processor.notification(account, notification.historyId);
      // No detached work after ACK. Completion or an intentional skip only.
      return new Response(null, { status: 204 });
    } catch (error) {
      logger("request_failed", { code: errorCode(error) });
      return new Response("retry later", { status: 503 });
    }
  };
}
