/**
 * Keeping payment card data out of everything the agent keeps (PLAN-53 C2).
 *
 * A card number or security code that reaches a tool result is otherwise
 * copied into the session transcript, the event journal, memory indexing and
 * dream input, and shown to the model. None of those should ever hold one.
 * The scrub is unconditional: unlike secret redaction it has no "off" mode.
 *
 * A card number is any 13 to 19 digit run (spaces or dashes allowed between
 * groups) that passes the Luhn check. The last four digits are kept, which is
 * what receipts show. A security code is three or four digits next to a word
 * that says what it is (CVV, CVC, CSC, "security code"). Expiry dates on
 * their own are not scrubbed: without the number they identify nothing.
 */

const CARD_RUN = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const SECURITY_CODE =
  /\b(cvv2?|cvc2?|csc|cid|security\s*code|card\s*code|verification\s*(?:code|value))\b([\s"']*(?:is\s+|[:=#])?[\s"']*)(\d{3,4})(?!\d)/gi;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replace card numbers and security codes in a string. */
export function scrubCardData(text: string): string {
  if (!text || !/\d{3}/.test(text)) {
    return text;
  }
  let out = text.replace(CARD_RUN, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) {
      return match;
    }
    // Long all-same or sequential runs are test data, not cards; still scrub.
    return `[card ending ${digits.slice(-4)}]`;
  });
  out = out.replace(SECURITY_CODE, (_m, label: string, sep: string) => `${label}${sep}[removed]`);
  return out;
}

/** True if the text has something the scrubber would remove. */
export function containsCardData(text: string): boolean {
  return scrubCardData(text) !== text;
}

const MAX_DEPTH = 8;

/** Scrub every string inside a value: tool results, event payloads, params. */
export function scrubCardDataDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") {
    return scrubCardData(value) as unknown as T;
  }
  if (!value || typeof value !== "object" || depth >= MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const scrubbed = scrubCardDataDeep(item, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return (changed ? next : value) as unknown as T;
  }
  if (value instanceof Uint8Array || value instanceof Date) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const scrubbed = scrubCardDataDeep(item, depth + 1);
    if (scrubbed !== item) changed = true;
    next[key] = scrubbed;
  }
  return (changed ? next : value) as unknown as T;
}
