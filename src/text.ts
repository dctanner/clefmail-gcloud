// Bounded plain-text extractor adapted from the sibling clefmail implementation.
import { compile } from "html-to-text";
import { SafeError } from "./errors.js";
export interface Message {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
}
export interface EmailText {
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  body: string;
  truncated: boolean;
  bodyUnavailable: boolean;
  originalBytes: number;
}
const HTML_LIMIT = "[CLEFMAIL_HTML_LIMIT]";
const htmlText = compile({
  wordwrap: false,
  limits: { maxInputLength: 524288, maxDepth: 60, maxChildNodes: 10000, ellipsis: HTML_LIMIT },
  selectors: ["script", "style", "head", "img", "iframe", "object", "form", "[hidden]", '[aria-hidden="true"]'].map(selector => ({ selector, format: "skip" })),
});
const encoder = new TextEncoder();
const CONTENT_ERRORS = new Set([
  "mime_limit", "body_limit", "body_fetch_limit", "body_encoding", "decoded_limit", "body_charset",
  "gmail_response_limit", "body_html",
]);
const header = (part: Part | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value || "";
const clean = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
export function clip(s: string, chars = 12000, bytes = 24576) {
  let result = "",
    n = 0,
    b = 0;
  for (const ch of s) {
    const size = encoder.encode(ch).length;
    if (n >= chars || b + size > bytes) break;
    result += ch;
    n++;
    b += size;
  }
  return result;
}
export function received(m: Message, email: string) {
  const labels = m.labelIds || [];
  if (labels.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l))) return false;
  if (!labels.includes("SENT")) return true;
  const delivered =
    header(m.payload, "Delivered-To") || header(m.payload, "X-Original-To");
  if (delivered.trim()) return true;
  const recipients =
    `${header(m.payload, "To")} ${header(m.payload, "Cc")}`.toLowerCase();
  return Array.from(
    recipients.match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+/g) || [],
  ).includes(email.toLowerCase());
}
export async function extract(
  m: Message,
  attachment: (id: string) => Promise<{ data: string; size?: number }>,
): Promise<EmailText> {
  const result: EmailText = {
    from: clip(clean(header(m.payload, "From")), 500, 1500),
    to: clip(clean(header(m.payload, "To")), 500, 1500),
    subject: clip(clean(header(m.payload, "Subject")), 500, 1500),
    receivedAt: clip(
      clean(header(m.payload, "Date") || m.internalDate || ""),
      100,
      300,
    ),
    body: "",
    truncated: false,
    bodyUnavailable: true,
    originalBytes: 0,
  };
  let parts = 0,
    decoded = 0,
    fetches = 0;
  const start = Date.now();
  async function walk(p: Part, depth: number, wanted: "text/plain" | "text/html"): Promise<string> {
    if (++parts > 100 || depth > 12 || Date.now() - start > 10000)
      throw new SafeError("mime_limit");
    if (
      p.filename?.trim() ||
      /\battachment\b/i.test(header(p, "Content-Disposition")) ||
      p.mimeType?.toLowerCase() === "message/rfc822"
    )
      return "";
    const mime = p.mimeType?.toLowerCase();
    if (mime?.startsWith("multipart/")) {
      let texts: string[] = [];
      for (const part of p.parts || []) {
        const t = await walk(part, depth + 1, wanted);
        if (t) texts.push(t);
        if (mime === "multipart/alternative" && t) break;
      }
      return texts.join("\n");
    }
    if (mime !== wanted) return "";
    if ((p.body?.size || 0) > 262144) throw new SafeError("body_limit");
    let data = p.body?.data;
    if (!data && p.body?.attachmentId) {
      if (++fetches > 4) throw new SafeError("body_fetch_limit");
      const body = await attachment(p.body.attachmentId);
      if ((body.size || 0) > 262144) throw new SafeError("body_limit");
      data = body.data;
    }
    if (!data) return "";
    if (data.length > 350000 || !/^[A-Za-z0-9_\-]*={0,2}$/.test(data))
      throw new SafeError("body_encoding");
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(
        atob(data.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
    } catch {
      throw new SafeError("body_encoding");
    }
    decoded += raw.length;
    result.originalBytes += p.body?.size || raw.length;
    if (decoded > 524288) throw new SafeError("decoded_limit");
    const charset =
      /charset\s*=\s*["']?([^\s;"']+)/i.exec(header(p, "Content-Type"))?.[1] ||
      "utf-8";
    try {
      const text = new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(raw);
      return clean(wanted === "text/html" ? htmlText(text) : text);
    } catch {
      throw new SafeError("body_charset");
    }
  }
  try {
    let full = m.payload ? await walk(m.payload, 0, "text/plain") : "";
    if (!full.trim() && m.payload) full = await walk(m.payload, 0, "text/html");
    result.body = clip(full);
    result.truncated = result.body !== full || full.includes(HTML_LIMIT);
    result.bodyUnavailable = !result.body.trim();
  } catch (e) {
    // Only content limits degrade to header-only. Transient Gmail/network failures
    // (HttpError, *_request_failed, aborts) must be retried, not permanently marked.
    if (!(e instanceof SafeError) || !CONTENT_ERRORS.has(e.code)) throw e;
    result.body = "";
    result.bodyUnavailable = true;
    result.truncated = true;
  }
  return result;
}
