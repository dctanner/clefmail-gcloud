import type { Message } from "./text.js";

export function header(message: Message, name: string): string {
  return message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// Conservative RFC mailbox-list subset. Delimiters inside quoted display names
// are data, never new recipients. Unsupported groups/comments/quoted local parts
// fail closed rather than guessing an identity from a substring.
export function addresses(value: string): string[] | null {
  if (!value.trim() || value.length > 16_384 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  const parts: string[] = [];
  let quoted = false, escaped = false, angle = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { if (angle) return null; quoted = true; }
    else if (c === "<") { if (angle) return null; angle = true; }
    else if (c === ">") { if (!angle) return null; angle = false; }
    else if (/[();:\[\]\\]/.test(c)) return null;
    else if (c === "," && !angle) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted || escaped || angle) return null;
  parts.push(value.slice(start));
  const result: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    const bracketed = /^(.*)<([^<>]+)>$/.exec(text);
    if (bracketed) {
      // Outside quoted strings, a display name cannot itself contain an address
      // or another angle mailbox. The list scanner already checked balancing.
      const unquotedName = bracketed[1]!.replace(/"(?:[^"\\]|\\.)*"/g, "");
      if (/[@<>]/.test(unquotedName)) return null;
    }
    const email = (bracketed?.[2] || text).trim().toLowerCase();
    if (email.length > 254 ||
        !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(email)) return null;
    result.push(email);
  }
  return result;
}

// From must contain exactly one mailbox, not merely one header field.
export function address(value: string): string | null {
  const parsed = addresses(value);
  return parsed?.length === 1 ? parsed[0]! : null;
}

export function senderOf(message: Message): string | null {
  const headers = message.payload?.headers?.filter(h => h.name.toLowerCase() === "from") || [];
  return headers.length === 1 ? address(headers[0]!.value) : null;
}

export function mayChallenge(message: Message, sender: string): boolean {
  const auto = header(message, "Auto-Submitted").trim().toLowerCase();
  return (!auto || auto === "no") && !header(message, "List-Id") &&
    !/\b(bulk|list|junk)\b/i.test(header(message, "Precedence")) &&
    header(message, "Return-Path").trim() !== "<>" &&
    !header(message, "X-Auto-Response-Suppress") &&
    !/^(?:no-?reply|mailer-daemon|postmaster)@/i.test(sender) &&
    !/\bdmarc=fail\b/i.test(header(message, "Authentication-Results"));
}
