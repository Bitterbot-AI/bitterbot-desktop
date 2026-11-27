/**
 * The first JSON object in a model response.
 *
 * The cheap models on the correction lane are asked for "ONLY a JSON
 * object" and often answer with a fenced object followed by an explanation,
 * sometimes one that takes the answer back ("Wait, let me reconsider ...").
 * Stripping a fence at the very start and end and parsing the rest loses
 * every such answer. One helper for every parser on that lane: find the
 * first complete top-level object (fences or not, prose before or after,
 * braces inside strings handled), and hand back the text after it so a
 * caller that must fail closed can look for a retraction.
 */

export type ModelJsonObject = {
  value: Record<string, unknown>;
  /** The text after the object, closing fence dropped, trimmed. */
  rest: string;
};

/** The end index (inclusive) of the balanced object opening at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Opening braces tried before giving up (prose with stray braces before the object). */
const MAX_OBJECT_STARTS = 8;

/**
 * Extract the first complete top-level JSON object from a model response.
 * Null when there is none that parses to a plain object. Never throws.
 */
export function extractFirstJsonObject(raw: string): ModelJsonObject | null {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  let from = 0;
  for (let attempt = 0; attempt < MAX_OBJECT_STARTS; attempt++) {
    const start = raw.indexOf("{", from);
    if (start < 0) {
      return null;
    }
    const end = balancedEnd(raw, start);
    if (end < 0) {
      // Never closed from here; a later brace may open a complete object.
      from = start + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return {
          value: parsed as Record<string, unknown>,
          rest: raw
            .slice(end + 1)
            .replace(/^\s*```/, "")
            .trim(),
        };
      }
    } catch {
      // Not JSON (prose in braces): try the next opening brace.
    }
    from = start + 1;
  }
  return null;
}

const RETRACTION_RX =
  /\b(?:wait|actually|let me (?:reconsider|rethink|re-?read|think again)|on (?:reflection|second thought)|reconsider(?:ing)?|i was wrong|correction:|scratch that)\b/i;

/**
 * Does the text after the object take the answer back? Used to fail closed:
 * a positive answer followed by "Wait, let me reconsider" is not an answer.
 */
export function hasRetraction(rest: string): boolean {
  return RETRACTION_RX.test(rest);
}
