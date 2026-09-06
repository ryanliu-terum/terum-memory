/**
 * Deterministic pre-distill secret scrubber.
 *
 * Runs on the RAW text fed to the distill LLM, BEFORE the call, so a transient
 * secret — a 2FA/OTP code, a password, an API key, a Bearer token — never
 * reaches the model and can never be echoed into the note, the embedding, or
 * storage. Every distill path funnels through one call site.
 *
 * DESIGN: conservative and FORMAT-ANCHORED, never entropy-blanket. Each
 * pattern matches a *structured* secret shape (a labeled code, a known key
 * prefix, a Luhn-valid card number). It deliberately does NOT touch bare
 * high-entropy strings — git SHAs, UUIDs, version numbers, ports, years, file
 * paths — because coding sessions are full of those and over-redaction
 * silently destroys the exact knowledge this tool captures. When in doubt it
 * leaves text ALONE. Regex is acceptable here precisely because secret
 * formats are mechanical, not semantic.
 */
export const REDACTED = "[REDACTED]";

const NON_SECRET_VALUES = new Set([
  "true", "false", "null", "none", "nil", "undefined", "yes", "no", "n/a", "na", REDACTED.toLowerCase(),
]);

function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const KEY_FORMATS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, // PEM private keys
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,          // OpenAI secret keys
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe keys
  /\bAKIA[0-9A-Z]{16}\b/g,                          // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,               // GitHub PAT / OAuth / refresh / server tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,             // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                    // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,             // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs (three base64url segments)
];

const LABELED: Array<{ re: RegExp; group: number }> = [
  {
    re: /\b(?:one[-\s]?time (?:pass)?code|verification code|security code|auth(?:entication)?[-\s]?code|access code|login code|confirmation code|passcode|OTP|2FA(?:\s*code)?)\b(?:\s*(?:is|:|=|-))?\s*(\d(?:[\d\s-]{2,8})\d)/gi,
    group: 1,
  },
  { re: /\b(?:password|passwd|pwd)\b\s*(?:is|:|=)\s*(\S+)/gi, group: 1 },
  { re: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
  {
    re: /\b(?:api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token)\b\s*(?:is|:|=)\s*["'`]?([A-Za-z0-9._~+/=-]{8,})["'`]?/gi,
    group: 1,
  },
];

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function redactGroup(match: string, value: string, group: number): string {
  if (!value || NON_SECRET_VALUES.has(value.toLowerCase())) return match;
  const idx = match.lastIndexOf(value);
  if (idx === -1) return match;
  return match.slice(0, idx) + REDACTED + match.slice(idx + value.length);
}

export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of KEY_FORMATS) out = out.replace(re, REDACTED);
  for (const { re, group } of LABELED) {
    out = out.replace(re, (match, ...groups) => redactGroup(match, groups[group - 1], group));
  }
  out = out.replace(SSN, REDACTED);
  out = out.replace(CARD_CANDIDATE, (match) => (passesLuhn(match.replace(/[ -]/g, "")) ? REDACTED : match));
  return out;
}
