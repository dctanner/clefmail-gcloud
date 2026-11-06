import { expect, test } from "bun:test";
import { GcsStateStore } from "../src/state.js";

function fixture() {
  const calls: { path: string; generation?: string }[] = [];
  let saved: any;
  let metadata: any = { generation: "1234567890123456789", size: "19" };
  let downloadError: any;
  let writeError: any;
  const store = new GcsStateStore("test-bucket");
  (store as any).storage = {
    bucket(name: string) {
      expect(name).toBe("test-bucket");
      return {
        file(path: string, options: { generation?: string }) {
          calls.push({ path, generation: options.generation });
          return {
            async getMetadata() {
              if (metadata instanceof Error) throw metadata;
              return [metadata];
            },
            async download() {
              if (downloadError) throw downloadError;
              return [Buffer.from('{"historyId":"100"}')];
            },
            async save(bytes: string, options: unknown) {
              if (writeError) throw writeError;
              saved = { bytes, options };
            },
          };
        },
      };
    },
  };
  return {
    store, calls, saved: () => saved,
    metadata: (v: unknown) => { metadata = v; },
    downloadError: (v: unknown) => { downloadError = v; },
    writeError: (v: unknown) => { writeError = v; },
  };
}

test("GCS reads pin generation and never round large generation IDs", async () => {
  const f = fixture();
  expect(await f.store.read("personal")).toEqual({ data: { historyId: "100" }, generation: "1234567890123456789" });
  expect(f.calls).toEqual([
    { path: "mailboxes/personal.json", generation: undefined },
    { path: "mailboxes/personal.json", generation: "1234567890123456789" },
  ]);
});

test("GCS creates and updates are conditional; precondition failure is busy", async () => {
  const f = fixture();
  await f.store.write("personal", { historyId: "100" }, "0");
  expect(f.saved().options.preconditionOpts).toEqual({ ifGenerationMatch: "0" });
  await f.store.write("personal", { historyId: "200" }, "1234567890123456789");
  expect(f.saved().options.preconditionOpts).toEqual({ ifGenerationMatch: "1234567890123456789" });
  f.writeError(Object.assign(new Error("precondition"), { code: 412 }));
  await expect(f.store.write("personal", { historyId: "300" }, "1")).rejects.toThrow("mailbox_busy");
});

test("missing object differs from a pinned-read overwrite race", async () => {
  const missing = Object.assign(new Error("missing"), { code: 404 });
  const f = fixture();
  f.metadata(missing);
  expect(await f.store.read("personal")).toBeNull();
  f.metadata({ generation: "1", size: "19" });
  f.downloadError(missing);
  await expect(f.store.read("personal")).rejects.toThrow("missing");
});

test("oversized checkpoint and traversal account IDs are rejected", async () => {
  const f = fixture();
  f.metadata({ generation: "1", size: "999999" });
  await expect(f.store.read("personal")).rejects.toThrow("invalid_checkpoint");
  await expect(f.store.read("../other")).rejects.toThrow("invalid_account_id");
});
