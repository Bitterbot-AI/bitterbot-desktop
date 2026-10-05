import crypto from "node:crypto";
import {
  MONITOR_VALUE_MAX_CHARS,
  type MonitorCondition,
  type MonitorExtract,
  type MonitorHealth,
} from "./types.js";

/** Visible text of an HTML page: no scripts, styles or tags, whitespace collapsed. */
export function visibleText(body: string): string {
  return body
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The watched value from a response body. Throws when it cannot be found. */
export function extractValue(body: string, extract: MonitorExtract): string {
  if (extract.kind === "text") {
    return visibleText(body);
  }
  if (extract.kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("the response is not JSON");
    }
    const value = readPath(parsed, extract.path);
    if (value === undefined) {
      throw new Error(`nothing at "${extract.path}" in the response`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(extract.pattern, "i");
  } catch (err) {
    throw new Error(
      `the pattern is not valid: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const match = pattern.exec(body);
  if (!match) {
    throw new Error("the pattern did not match anything in the response");
  }
  return (match[extract.group ?? 0] ?? match[0]).trim();
}

export const hashValue = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

const asNumber = (value: string): number | null => {
  const match = /-?\d[\d,]*(\.\d+)?/.exec(value);
  if (!match) {
    return null;
  }
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function holds(condition: MonitorCondition, value: string): boolean {
  switch (condition.kind) {
    case "contains":
      return value.toLowerCase().includes(condition.text.toLowerCase());
    case "not-contains":
      return !value.toLowerCase().includes(condition.text.toLowerCase());
    case "above": {
      const n = asNumber(value);
      return n !== null && n > condition.value;
    }
    case "below": {
      const n = asNumber(value);
      return n !== null && n < condition.value;
    }
    case "changed":
      return false;
  }
}

export type Evaluation = {
  fired: boolean;
  changed: boolean;
  /** What happened, for the notice. Set when `fired`. */
  summary?: string;
  health: Pick<MonitorHealth, "lastValue" | "lastValueHash" | "conditionMet">;
};

const shorten = (value: string, max = 160) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/**
 * Compare a fresh value with what the monitor saw before.
 *
 * "changed" never fires on the first value: there is nothing to differ from.
 * The other conditions fire when they start to hold (including on the first
 * check, since "is it in stock?" deserves an answer when it already is) and
 * not again until they have stopped holding and started again.
 */
export function evaluate(
  condition: MonitorCondition,
  previous: MonitorHealth,
  value: string,
): Evaluation {
  const hash = hashValue(value);
  const first = previous.lastValueHash === undefined;
  const changed = !first && previous.lastValueHash !== hash;
  const health = {
    lastValue: value.slice(0, MONITOR_VALUE_MAX_CHARS),
    lastValueHash: hash,
  };
  if (condition.kind === "changed") {
    return {
      fired: changed,
      changed,
      summary: changed
        ? `changed from "${shorten(previous.lastValue ?? "")}" to "${shorten(value)}"`
        : undefined,
      health,
    };
  }
  const met = holds(condition, value);
  const fired = met && previous.conditionMet !== true;
  const what =
    condition.kind === "contains"
      ? `now contains "${condition.text}"`
      : condition.kind === "not-contains"
        ? `no longer contains "${condition.text}"`
        : condition.kind === "above"
          ? `is above ${condition.value} (now ${shorten(value, 60)})`
          : `is below ${condition.value} (now ${shorten(value, 60)})`;
  return {
    fired,
    changed,
    summary: fired ? what : undefined,
    health: { ...health, conditionMet: met },
  };
}
