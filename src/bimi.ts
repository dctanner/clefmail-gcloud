import { Resolver } from "node:dns/promises";
import type { Message } from "./text.js";
import { senderOf } from "./sender.js";

type Lookup = (name: string) => Promise<string[][]>;

// Read the result in Google's receiving-hop header block. Ignore downstream
// Authentication-Results fields that could have arrived with the message.
function dmarcDomain(message: Message): string | null {
  const headers = message.payload?.headers || [];
  const hop = headers.findIndex(h => h.name.toLowerCase() === "received" && /\bby\s+mx\.google\.com\b/i.test(h.value));
  if (hop < 0) return null;
  const block = headers.slice(hop + 1);
  const next = block.findIndex(h => h.name.toLowerCase() === "received");
  const results = (next < 0 ? block : block.slice(0, next))
    .filter(h => h.name.toLowerCase() === "authentication-results");
  if (results.length !== 1 || !/^\s*mx\.google\.com\s*;/i.test(results[0]!.value)) return null;
  const clauses = results[0]!.value.replace(/\([^()]*\)/g, "").split(";")
    .filter(v => /^\s*dmarc\s*=/i.test(v));
  if (clauses.length !== 1) return null;
  const match = /^\s*dmarc\s*=\s*pass\s+header\.from\s*=\s*([a-z0-9.-]+)\s*$/i.exec(clauses[0]!);
  return match?.[1]?.toLowerCase() || null;
}

function tags(value: string): Map<string, string> | null {
  const parsed = new Map<string, string>();
  for (const part of value.split(";").map(s => s.trim()).filter(Boolean)) {
    const match = /^([a-z]+)\s*=\s*(.*)$/i.exec(part);
    if (!match || parsed.has(match[1]!.toLowerCase())) return null;
    parsed.set(match[1]!.toLowerCase(), match[2]!);
  }
  return parsed;
}

function certificatePublished(records: string[][]): boolean {
  const bimi = records.map(r => r.join("")).filter(r => /^v=BIMI1\s*;/i.test(r));
  if (bimi.length !== 1) return false;
  const record = tags(bimi[0]!);
  if (record?.get("v") !== "BIMI1" || !record.get("a")) return false;
  try {
    const url = new URL(record.get("a")!);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

export class BimiPolicy {
  private cache = new Map<string, { expires: number; records: string[][] }>();
  private lookup: Lookup;
  constructor(lookup?: Lookup) {
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    this.lookup = lookup || (name => resolver.resolveTxt(name));
  }
  private async records(name: string): Promise<string[][]> {
    const cached = this.cache.get(name);
    if (cached && cached.expires > Date.now()) return cached.records;
    let records: string[][];
    try { records = await this.lookup(name); }
    catch (error: any) {
      if (!["ENODATA", "ENOTFOUND"].includes(error.code)) throw error;
      records = [];
    }
    if (this.cache.size >= 500) this.cache.clear();
    this.cache.set(name, { records, expires: Date.now() + 300_000 });
    return records;
  }
  async allows(message: Message): Promise<boolean> {
    const domain = senderOf(message)?.split("@")[1];
    const authenticated = dmarcDomain(message);
    if (!domain || !authenticated || !(domain === authenticated || domain.endsWith(`.${authenticated}`))) return false;
    const selectors = message.payload?.headers?.filter(h => h.name.toLowerCase() === "bimi-selector") || [];
    if (selectors.length > 1) return false;
    const selected = selectors.length ? tags(selectors[0]!.value) : null;
    if (selectors.length && selected?.get("v") !== "BIMI1") return false;
    const selector = selectors.length ? selected?.get("s") : "default";
    if (!selector || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(selector)) return false;
    try {
      const records = await this.records(`${selector}._bimi.${domain}`);
      if (records.length) return certificatePublished(records);
      // Google's authenticated organizational domain is the only fallback.
      return domain !== authenticated && certificatePublished(await this.records(`${selector}._bimi.${authenticated}`));
    } catch { return false; } // DNS failures leave normal verification in place.
  }
}
