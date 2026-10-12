/**
 * PLAN-55 Phase 1 review (item 5): a value that looks like a credential is
 * never a canonical fact. "My GitHub token is ghp_..." would otherwise be
 * pinned at the owner tier, echoed in the confirmation line and injected
 * into every prompt. Checked in the correction parser and again in the
 * ledger's pin() (defence in depth), for every source.
 *
 * Shapes: the logging redaction patterns (env-style assignments, JSON
 * fields, bearer tokens, PEM blocks, vendor token prefixes), AWS access
 * keys, JWTs, and long hex/base64 runs. Keys whose name says secret are
 * refused whatever the value.
 */

import { DEFAULT_REDACT_PATTERNS } from "../logging/redact.js";
import { scrubCardData } from "../security/card-data.js";

const EXTRA_SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/,
  // JWT: three base64url segments, the first starting with "eyJ".
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Long hex (api keys, hashes used as tokens).
  /\b[0-9a-f]{32,}\b/i,
  // Long base64-ish run with no spaces (session tokens, secrets): mixed case
  // AND digits, so a long plain word or a repeated letter is not one.
  /(^|[^A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{40,}={0,2}(?=$|[^A-Za-z0-9+/=])/,
  // Stripe / OpenAI / Anthropic style prefixes not in the redaction list.
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/,
];

const REDACT_RX: RegExp[] = DEFAULT_REDACT_PATTERNS.map((p) => new RegExp(p, "i"));

/** Key names that name a credential, whatever the value. */
export const SECRET_KEY_NAME_RX =
  /(^|[._-])(token|secret|password|passwd|pass|api[._-]?key|apikey|private[._-]?key|credential|auth|bearer|ssn|credit[._-]?card)s?([._-]|$)/i;

/** True when the value has the shape of a credential. */
export function looksLikeSecretValue(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  return EXTRA_SECRET_PATTERNS.some((rx) => rx.test(text)) || REDACT_RX.some((rx) => rx.test(text));
}

/** True when the key names a credential. */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_NAME_RX.test(key);
}

/** The reason a (key, value) pair is refused as a secret, or null. Never includes the value. */
export function secretRejectionReason(key: string, value: string): string | null {
  if (looksLikeSecretKey(key)) {
    return `"${key}" names a credential; secrets are never stored as facts`;
  }
  if (looksLikeSecretValue(value)) {
    return `the value for "${key}" has the shape of a credential; secrets are never stored as facts`;
  }
  return null;
}

// PLAN-55 Phase 3: the export redacts credential-shaped text instead of
// refusing it. Same shapes as looksLikeSecretValue, as global patterns; the
// base64-run pattern uses lookbehind so the character before the token is
// kept.
const REDACT_GLOBAL_RX: RegExp[] = [
  ...DEFAULT_REDACT_PATTERNS.map((p) => new RegExp(p, "gi")),
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[0-9a-f]{32,}\b/gi,
  /(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
];

export const SECRET_REDACTION = "[redacted]";

/**
 * Replace every credential-shaped run in `text` with `[redacted]` (and card
 * numbers with the card scrubber's mask). Where a pattern captures the
 * secret part of a larger match (`API_KEY=...`, `"token": "..."`), only
 * that part is replaced, so the reader still sees what was there.
 */
export function redactSecretShapes(text: string): { text: string; redactions: number } {
  if (!text) {
    return { text, redactions: 0 };
  }
  let redactions = 0;
  let next = scrubCardData(text);
  if (next !== text) {
    redactions += 1;
  }
  for (const rx of REDACT_GLOBAL_RX) {
    rx.lastIndex = 0;
    next = next.replace(rx, (...args: unknown[]) => {
      const match = String(args[0]);
      if (match.includes(SECRET_REDACTION)) {
        return match;
      }
      redactions += 1;
      // replace() passes (match, ...groups, offset, input[, named]): the
      // capture groups are what sits before the numeric offset.
      const offsetAt = args.findIndex((a, i) => i > 0 && typeof a === "number");
      const groups = args
        .slice(1, offsetAt > 0 ? offsetAt : 1)
        .filter((g): g is string => typeof g === "string" && g.length > 2);
      const token = groups.at(-1);
      return token && token !== match ? match.replace(token, SECRET_REDACTION) : SECRET_REDACTION;
    });
  }
  return { text: next, redactions };
}
