/**
 * Monitors (PLAN-53 E5): watch a page or an API and wake the agent only when
 * something changes. The check is a plain fetch and a comparison, with no
 * model call, so watching costs nothing until there is something to say.
 */

/** What part of the response is the value being watched. */
export type MonitorExtract =
  /** The page's visible text (markup and scripts removed, whitespace collapsed). */
  | { kind: "text" }
  /** A field of a JSON body, e.g. "data.price" or "items[0].status". */
  | { kind: "json"; path: string }
  /** The first match of a pattern in the raw body; `group` picks a capture. */
  | { kind: "regex"; pattern: string; group?: number };

/** When the monitor fires. */
export type MonitorCondition =
  /** The value is different from the last check. Never fires on the first. */
  | { kind: "changed" }
  /** The value starts to contain / stops containing this text. */
  | { kind: "contains"; text: string }
  | { kind: "not-contains"; text: string }
  /** The value, read as a number, crosses the threshold. */
  | { kind: "above"; value: number }
  | { kind: "below"; value: number };

export type MonitorHealth = {
  lastCheckAt?: number;
  /** The last check that got a value. */
  lastOkAt?: number;
  lastChangeAt?: number;
  lastFiredAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  /** The watched value at the last good check, shortened. */
  lastValue?: string;
  lastValueHash?: string;
  /** For threshold and contains conditions: whether it held at the last check. */
  conditionMet?: boolean;
};

export type Monitor = {
  id: string;
  name: string;
  url: string;
  extract: MonitorExtract;
  condition: MonitorCondition;
  intervalMs: number;
  enabled: boolean;
  /** What the agent should do when it fires, in the owner's words. */
  note?: string;
  createdAt: number;
  updatedAt: number;
  health: MonitorHealth;
};

export const MONITOR_MIN_INTERVAL_MS = 60_000;
export const MONITOR_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const MONITOR_MAX_COUNT = 50;
/** A watched value is kept and shown up to this length. */
export const MONITOR_VALUE_MAX_CHARS = 2_000;
