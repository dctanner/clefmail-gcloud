// Bounded plain-text extractor adapted from the sibling clefmail implementation.
import type { SenderContext } from "./sender-context.js";
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
  senderContext?: SenderContext;
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
export const BODY_MAX_CHARS = 12_000;
export const BODY_MAX_BYTES = 16_384;
const SOURCE_MAX_BYTES = 524_288;
const htmlText = compile({
  wordwrap: false,
  preserveNewlines: true,
  limits: { maxInputLength: 524288, maxDepth: 200, maxChildNodes: 10000, ellipsis: HTML_LIMIT },
  selectors: ["script", "style", "head", "img", "svg", "canvas", "picture", "audio", "video", "source", "iframe", "embed", "object", "form", "[hidden]", '[aria-hidden="true"]'].map(selector => ({ selector, format: "skip" })),
});
const encoder = new TextEncoder();
const CONTENT_ERRORS = new Set([
  "mime_limit", "body_fetch_limit", "body_encoding", "body_charset",
  "gmail_response_limit", "body_html",
]);
const header = (part: Part | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value || "";
const clean = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
export function clip(s: string, chars = BODY_MAX_CHARS, bytes = BODY_MAX_BYTES, jsonBytes = Infinity) {
  let result = "",
    n = 0,
    b = 0,
    j = 0;
  for (const ch of s) {
    const size = encoder.encode(ch).length;
    const jsonSize = Number.isFinite(jsonBytes) ? Buffer.byteLength(JSON.stringify(ch)) - 2 : 0;
    if (n >= chars || b + size > bytes || j + jsonSize > jsonBytes) break;
    result += ch;
    n++;
    b += size;
    j += jsonSize;
  }
  return result;
}

function stripEmbeddedData(text: string): string {
  return text
    // Inline resources can appear in visible text, attributes or plain MIME parts.
    .replace(/\bdata:[^\s,<>"']*;base64,\s*[A-Za-z0-9+/_=-]*(?:\n[ \t]*[A-Za-z0-9+/_=-]{16,})*/gi, "")
    .replace(/\bdata:[^\s,<>"']*,\s*[^\s<>"')\]]*/gi, "")
    .replace(/\bcid:[^\s<>"')\]]+/gi, "")
    // Keep the destination visible even when a private reset token fills its path.
    .replace(/\bhttps?:\/\/[^\s<>"'\[\]]+/gi, link => {
      try { return new URL(link).origin; }
      catch { return "[unreadable link]"; }
    })
    // Remove wrapped base64 blocks before HTML conversion collapses whitespace.
    .replace(/^[ \t]*(?:[A-Za-z0-9+/_-]{20,}={0,2}[ \t]*(?:\n|$)){2,}/gm, "")
    .replace(/[A-Za-z0-9+/_-]{64,}={0,2}/g, "")
    .replace(/\b[A-Za-z0-9+/_-]{16,}={1,2}(?=$|[\s<>"')\]])/g, "");
}

export function plainText(text: string): { text: string; truncated: boolean } {
  const source = stripEmbeddedData(clean(text))
    // Angle-bracket email addresses are text, even in a plain MIME part.
    .replace(/<([^<>\s]+@[^<>\s]+|https?:\/\/[^<>\s]+)>/gi, "&lt;$1&gt;");
  const converted = htmlText(source);
  return {
    text: stripEmbeddedData(clean(converted))
      .replaceAll(HTML_LIMIT, "")
      // Escaped markup can become visible text when HTML entities are decoded.
      .replace(/<\/?[a-z][\w:-]*(?:\s[^<>]*)?\s*\/?>/gi, "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    truncated: source.length > 524288 || converted.includes(HTML_LIMIT),
  };
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
      /\b(?:filename|name)(?:\*\d+)?\*?\s*=/i.test(`${header(p, "Content-Disposition")};${header(p, "Content-Type")}`) ||
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
    let data = p.body?.data;
    if (!data && p.body?.attachmentId) {
      if (++fetches > 4) throw new SafeError("body_fetch_limit");
      const body = await attachment(p.body.attachmentId);
      data = body.data;
    }
    if (!data) return "";
    if (!/^[A-Za-z0-9_\-]*={0,2}$/.test(data))
      throw new SafeError("body_encoding");
    const encoded = data.slice(0, Math.floor((SOURCE_MAX_BYTES - decoded) / 3) * 4);
    const shortened = encoded.length < data.length;
    result.truncated ||= shortened;
    if (!encoded) return "";
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(
        atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
    } catch {
      throw new SafeError("body_encoding");
    }
    decoded += raw.length;
    result.originalBytes += p.body?.size || raw.length;
    const charset =
      /charset\s*=\s*["']?([^\s;"']+)/i.exec(header(p, "Content-Type"))?.[1] ||
      "utf-8";
    try {
      // Streaming decode leaves a cut UTF-8 character out of the retained prefix.
      const text = new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(raw, { stream: shortened });
      const converted = plainText(text);
      result.truncated ||= converted.truncated;
      return converted.text;
    } catch {
      throw new SafeError("body_charset");
    }
  }
  try {
    // HTML alternatives often contain the actual message while plain alternatives
    // contain browser-view stubs, CSS, or raw markup. Convert the HTML to text.
    let full = m.payload ? await walk(m.payload, 0, "text/html") : "";
    if (!full.trim() && m.payload) full = await walk(m.payload, 0, "text/plain");
    result.body = clip(full).trimEnd();
    result.truncated ||= result.body !== full;
    result.bodyUnavailable = !result.body.trim();
  } catch (e) {
    // Content failures make the message ineligible for processing. Transient
    // Gmail/network failures retry before any Gmail action.
    if (!(e instanceof SafeError) || !CONTENT_ERRORS.has(e.code)) throw e;
    result.body = "";
    result.bodyUnavailable = true;
    result.truncated = true;
  }
  return result;
}
