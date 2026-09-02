/**
 * Lenient JSON-object extraction for LLM outputs (maintainer, proposer).
 *
 * Live finding 2026-09-02: the Wiki Maintainer answered with a ```json
 * fence whose pattern CONTENT itself contained markdown code fences. A
 * non-greedy fence regex stopped at the first inner ``` and truncated the
 * payload, so a perfectly good iteration was thrown away as unparseable.
 * Strategy: try progressively wider views of the text and return the
 * first that parses to a plain object.
 */

export function extractJsonObjectLenient(raw: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const text = raw.trim();
  const candidates: string[] = [];
  // 1. Whole text as-is.
  candidates.push(text);
  // 2. Non-greedy fence (fast path for well-formed answers).
  const nonGreedy = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (nonGreedy?.[1]) {
    candidates.push(nonGreedy[1].trim());
  }
  // 3. Greedy fence: first opening fence to the LAST closing fence, so
  //    inner fences inside JSON strings do not truncate the payload.
  const greedy = text.match(/```(?:json)?\s*([\s\S]*)```/);
  if (greedy?.[1]) {
    candidates.push(greedy[1].trim());
  }
  // 4. Outermost braces of the whole text.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  // 5. FIRST balanced top-level object (string-aware): handles replies
  //    that contain several JSON objects or trailing prose after one.
  const first = firstBalancedObject(text);
  if (first) {
    candidates.push(first);
  }
  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/** Slice of `text` covering the first balanced `{...}` at top level, string-aware. */
export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
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
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
