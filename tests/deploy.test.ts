import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// No real gcloud/bun commands execute. Validate shell flow for fresh deploy/update.
test.each(["create", "update"])("deployment %s preserves private OIDC invocation and no reconciliation job", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "clefmail-deploy-test-"));
  const trace = join(directory, "calls.jsonl");
  try {
    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).filter(v => !v.startsWith('--project='));
fs.appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'projects' && args[1] === 'describe') { console.log('123456789'); process.exit(0); }
if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') {
 console.log('https://clefmail-test.run.app'); process.exit(0);
}
if (args.includes('describe')) process.exit(process.env.MODE === 'create' ? 1 : 0);
`;
    await writeFile(join(directory, "gcloud"), stub, { mode: 0o755 });
    await writeFile(join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, TRACE: trace, MODE: mode,
      PROJECT: "clefmail-test", STATE_BUCKET: "clefmail-test-state", SERVICE: "clefmail-gcloud",
      SECRET_BINDINGS: "/secrets/config.json=config:1,GOOGLE_CLIENT_ID=client-id:1,GOOGLE_CLIENT_SECRET=client-secret:1,CLASSIFIER_API_KEY=classifier-key:1,GMAIL_PERSONAL_REFRESH_TOKEN=mail-token:1",
    };
    const result = spawnSync("bash", [resolve("scripts/deploy.sh")], { env, encoding: "utf8", timeout: 20_000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    const deploy = calls.find(c => c[0] === "run" && c[1] === "deploy")!;
    expect(deploy).toContain("--no-allow-unauthenticated");
    expect(deploy).toContain("--max-instances=1");
    const sub = calls.find(c => c[0] === "pubsub" && c[1] === "subscriptions" && c[2] === mode && c[3] === "clefmail-gcloud")!;
    expect(sub).toContain("--push-auth-token-audience=https://clefmail-test.run.app");
    expect(sub).toContain("--ack-deadline=300");
    expect(sub.some(arg => arg.startsWith("--topic="))).toBe(mode === "create");
    const schedule = calls.filter(c => c[0] === "scheduler" && c[1] === "jobs" && c[2] === mode);
    expect(schedule.length).toBe(1);
    expect(schedule[0]).toContain("--uri=https://clefmail-test.run.app/renew");
    expect(calls.some(c => c.some(arg => arg.includes("allUsers")))).toBe(false);
    expect(calls.some(c => c.some(arg => arg === ""))).toBe(false);

    // Invalid secret references are refused before making any cloud calls.
    await rm(trace);
    const invalid = spawnSync("bash", [resolve("scripts/deploy.sh")], {
      env: { ...env, SECRET_BINDINGS: "CLASSIFIER_API_KEY=literal-secret-value" }, encoding: "utf8",
    });
    expect(invalid.status).not.toBe(0);
    await expect(readFile(trace)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification deployment is a separate public service with no processor secrets or watches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clefmail-verify-deploy-test-"));
  const trace = join(directory, "calls.jsonl");
  try {
    await writeFile(join(directory, "gcloud"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).filter(v => !v.startsWith('--project='));
fs.appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe')
  console.log('https://clefmail-test-verify.run.app');
`, { mode: 0o755 });
    await writeFile(join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, TRACE: trace,
      PROJECT: "clefmail-test", STATE_BUCKET: "clefmail-test-state", SERVICE: "clefmail-gcloud",
      VERIFICATION_SECRET_BINDINGS: "/secrets/config.json=config:1,GOOGLE_CLIENT_ID=client-id:1,GOOGLE_CLIENT_SECRET=client-secret:1,TURNSTILE_SECRET_KEY=turnstile:1,GMAIL_PERSONAL_REFRESH_TOKEN=mail-token:2",
    };
    const result = spawnSync("bash", [resolve("scripts/deploy-verification.sh")], {
      env, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status).toBe(0);
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    const deploy = calls.find(c => c[0] === "run" && c[1] === "deploy")!;
    expect(deploy[2]).toBe("clefmail-gcloud-verify");
    expect(deploy).toContain("--allow-unauthenticated");
    expect(deploy).toContain("--ingress=all");
    expect(deploy).toContain("--set-env-vars=SERVICE_MODE=verification,CONFIG_PATH=/secrets/config.json,STATE_BUCKET=clefmail-test-state");
    expect(calls.some(c => c[0] === "pubsub" || c[0] === "scheduler")).toBe(false);
    expect(calls.some(c => c.some(arg => arg.includes("CLASSIFIER_API_KEY")))).toBe(false);
    expect(calls.some(c => c[0] === "run" && c.includes("clefmail-gcloud"))).toBe(false);
    for (const invalid of [
      "TURNSTILE_SECRET_KEY=literal-secret",
      `${env.VERIFICATION_SECRET_BINDINGS},NODE_OPTIONS=evil:1`,
      `${env.VERIFICATION_SECRET_BINDINGS},TURNSTILE_SECRET_KEY=duplicate:2`,
    ]) {
      await rm(trace, { force: true });
      const rejected = spawnSync("bash", [resolve("scripts/deploy-verification.sh")], {
        env: { ...env, VERIFICATION_SECRET_BINDINGS: invalid }, encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      await expect(readFile(trace)).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
