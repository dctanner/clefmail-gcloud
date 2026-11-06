import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import { historyId } from "./gmail.js";
import { SafeError } from "./errors.js";

const stateSchema = z.object({
  historyId: historyId.nullable(),
  watchExpiration: z.string().optional(),
  lease: z.object({ owner: z.string(), expiresAt: z.number() }).optional(),
}).strict();
export type State = z.infer<typeof stateSchema>;
export interface Snapshot { data: State; generation: string }
export interface StateStore {
  isProcessed(accountId: string, messageId: string): Promise<boolean>;
  markProcessed(accountId: string, messageId: string): Promise<void>;
  read(accountId: string): Promise<Snapshot | null>;
  write(accountId: string, state: State, generation: string): Promise<void>;
}

export class GcsStateStore implements StateStore {
  private storage = new Storage({
    retryOptions: { maxRetries: 2, totalTimeout: 10, maxRetryDelay: 1 },
  });
  constructor(private bucket: string) {}

  private processedFile(accountId: string, messageId: string) {
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(accountId) || !/^[a-zA-Z0-9_-]{1,200}$/.test(messageId))
      throw new SafeError("invalid_processed_key");
    return this.storage.bucket(this.bucket).file(`processed/${accountId}/${messageId}.json`);
  }

  async isProcessed(accountId: string, messageId: string): Promise<boolean> {
    const [exists] = await this.processedFile(accountId, messageId).exists();
    return exists;
  }

  async markProcessed(accountId: string, messageId: string): Promise<void> {
    try {
      await this.processedFile(accountId, messageId).save("{}", {
        resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: "application/json", cacheControl: "no-store" },
      });
    } catch (error: any) { if (error?.code !== 412) throw error; }
  }

  private file(accountId: string, generation?: string) {
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(accountId)) throw new SafeError("invalid_account_id");
    return this.storage.bucket(this.bucket).file(`mailboxes/${accountId}.json`, { generation });
  }

  async read(accountId: string): Promise<Snapshot | null> {
    let generation: string;
    try {
      const [metadata] = await this.file(accountId).getMetadata();
      if (!metadata.generation || Number(metadata.size) > 16_384)
        throw new SafeError("invalid_checkpoint");
      generation = String(metadata.generation);
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
    // Pin the read to the metadata generation; never pair old metadata with new bytes.
    const [bytes] = await this.file(accountId, generation).download({ validation: "crc32c" });
    if (bytes.length > 16_384) throw new SafeError("invalid_checkpoint");
    return { data: stateSchema.parse(JSON.parse(bytes.toString("utf8"))), generation };
  }

  async write(accountId: string, state: State, generation: string): Promise<void> {
    try {
      await this.file(accountId).save(JSON.stringify(stateSchema.parse(state)), {
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: generation },
        metadata: { contentType: "application/json", cacheControl: "no-store" },
      });
    } catch (error: any) {
      if (error?.code === 412) throw new SafeError("mailbox_busy");
      throw error;
    }
  }
}

// A short lease lives alongside the cursor, not in a separate database.
// It limits duplicate calls during redelivery/rollouts, not exactly-once Gmail effects.
export class MailboxSession {
  private constructor(
    private store: StateStore,
    private accountId: string,
    private snapshot: Snapshot,
    private owner: string,
    private now: () => number,
  ) {}

  static async acquire(store: StateStore, accountId: string, now = Date.now): Promise<MailboxSession> {
    const existing = await store.read(accountId);
    if (existing?.data.lease && existing.data.lease.expiresAt > now())
      throw new SafeError("mailbox_busy");
    const owner = randomUUID();
    const state: State = {
      ...(existing?.data || { historyId: null }),
      lease: { owner, expiresAt: now() + 300_000 },
    };
    await store.write(accountId, state, existing?.generation || "0");
    const snapshot = await store.read(accountId);
    if (!snapshot || snapshot.data.lease?.owner !== owner) throw new SafeError("lease_lost");
    return new MailboxSession(store, accountId, snapshot, owner, now);
  }

  get data(): Readonly<State> { return this.snapshot.data; }

  async assertOwned(): Promise<void> {
    if (!this.snapshot.data.lease || this.snapshot.data.lease.expiresAt <= this.now() + 5000)
      throw new SafeError("lease_expiring");
    const fresh = await this.store.read(this.accountId);
    if (!fresh || fresh.generation !== this.snapshot.generation ||
        fresh.data.lease?.owner !== this.owner || fresh.data.lease.expiresAt <= this.now() + 5000)
      throw new SafeError("lease_lost");
  }

  async update(patch: Partial<Pick<State, "historyId" | "watchExpiration">>): Promise<void> {
    await this.assertOwned();
    if (patch.historyId && this.data.historyId && BigInt(patch.historyId) < BigInt(this.data.historyId))
      throw new SafeError("cursor_regression");
    await this.store.write(this.accountId, { ...this.snapshot.data, ...patch }, this.snapshot.generation);
    const fresh = await this.store.read(this.accountId);
    if (!fresh || fresh.data.lease?.owner !== this.owner) throw new SafeError("lease_lost");
    this.snapshot = fresh;
  }

  async release(): Promise<void> {
    const { lease: _lease, ...state } = this.snapshot.data;
    // A stale owner can never release a successor's lease: generation is conditional.
    await this.store.write(this.accountId, state, this.snapshot.generation);
  }
}
