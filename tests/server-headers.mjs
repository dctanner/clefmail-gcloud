import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("the public Node server sends one content type per response", { timeout: 15_000 }, async t => {
  const server = spawn(process.execPath, ["dist/src/server.js"], {
    env: {
      PORT: "0", SERVICE_MODE: "verification", CONFIG_PATH: "config.example.json",
      STATE_BUCKET: "example-bucket", GOOGLE_CLIENT_ID: "example", GOOGLE_CLIENT_SECRET: "example",
      GMAIL_PERSONAL_REFRESH_TOKEN: "example", TURNSTILE_SECRET_KEY: "example",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill());
  const lines = createInterface({ input: server.stdout });
  const { value } = await lines[Symbol.asyncIterator]().next();
  assert.ok(value, "expected a startup message");
  const { event, port } = JSON.parse(value);
  assert.equal(event, "listening");
  for (const [path, type] of [["/play", "text/html"], ["/verify", "text/html"], ["/healthz", "text/plain"]]) {
    const response = await new Promise((resolve, reject) =>
      get(`http://127.0.0.1:${port}${path}`, resolve).on("error", reject));
    response.resume();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.headersDistinct["content-type"], [type + "; charset=utf-8"]);
    assert.deepEqual(response.headersDistinct["cache-control"], ["no-store"]);
  }
});
