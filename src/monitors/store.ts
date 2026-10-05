import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { assertNotRealStateUnderTest } from "../infra/test-state-guard.js";
import {
  MONITOR_DEFAULT_INTERVAL_MS,
  MONITOR_MIN_INTERVAL_MS,
  type Monitor,
  type MonitorCondition,
  type MonitorExtract,
} from "./types.js";

export function defaultMonitorsPath(): string {
  return path.join(resolveStateDir(), "monitors", "monitors.json");
}

export async function loadMonitors(filePath: string): Promise<Monitor[]> {
  assertNotRealStateUnderTest(filePath);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { monitors?: unknown };
    return Array.isArray(parsed.monitors) ? (parsed.monitors as Monitor[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function saveMonitors(filePath: string, monitors: Monitor[]): Promise<void> {
  assertNotRealStateUnderTest(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: 1, monitors }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tmp, filePath);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function readUrl(value: unknown): string {
  const raw = str(value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a full http(s) address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("url must be http or https");
  }
  return url.toString();
}

function readExtract(value: unknown): MonitorExtract {
  if (!isRecord(value)) {
    return { kind: "text" };
  }
  const kind = str(value.kind) || "text";
  if (kind === "text") {
    return { kind: "text" };
  }
  if (kind === "json") {
    const p = str(value.path);
    if (!p) {
      throw new Error('extract.path is required for kind "json"');
    }
    return { kind: "json", path: p };
  }
  if (kind === "regex") {
    const pattern = str(value.pattern);
    if (!pattern) {
      throw new Error('extract.pattern is required for kind "regex"');
    }
    try {
      void new RegExp(pattern);
    } catch {
      throw new Error("extract.pattern is not a valid regular expression");
    }
    const group =
      typeof value.group === "number" && value.group >= 0 ? Math.floor(value.group) : undefined;
    return { kind: "regex", pattern, ...(group !== undefined ? { group } : {}) };
  }
  throw new Error('extract.kind must be "text", "json" or "regex"');
}

function readCondition(value: unknown): MonitorCondition {
  if (!isRecord(value)) {
    return { kind: "changed" };
  }
  const kind = str(value.kind) || "changed";
  if (kind === "changed") {
    return { kind: "changed" };
  }
  if (kind === "contains" || kind === "not-contains") {
    const text = str(value.text);
    if (!text) {
      throw new Error(`condition.text is required for kind "${kind}"`);
    }
    return { kind, text };
  }
  if (kind === "above" || kind === "below") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      throw new Error(`condition.value must be a number for kind "${kind}"`);
    }
    return { kind, value: value.value };
  }
  throw new Error(
    'condition.kind must be "changed", "contains", "not-contains", "above" or "below"',
  );
}

function readInterval(params: Record<string, unknown>, fallback: number): number {
  const ms =
    typeof params.intervalMs === "number"
      ? params.intervalMs
      : typeof params.intervalMinutes === "number"
        ? params.intervalMinutes * 60_000
        : fallback;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("the interval must be a positive number");
  }
  // A shorter interval is raised, not refused: the floor protects the sites
  // being watched and this gateway.
  return Math.max(MONITOR_MIN_INTERVAL_MS, Math.floor(ms));
}

export function buildMonitor(params: Record<string, unknown>, now = Date.now()): Monitor {
  const url = readUrl(params.url);
  return {
    id: `mon_${crypto.randomBytes(5).toString("hex")}`,
    name: str(params.name).slice(0, 120) || new URL(url).host,
    url,
    extract: readExtract(params.extract),
    condition: readCondition(params.condition),
    intervalMs: readInterval(params, MONITOR_DEFAULT_INTERVAL_MS),
    enabled: params.enabled !== false,
    ...(str(params.note) ? { note: str(params.note).slice(0, 500) } : {}),
    createdAt: now,
    updatedAt: now,
    health: { consecutiveErrors: 0 },
  };
}

export function patchMonitor(
  existing: Monitor,
  patch: Record<string, unknown>,
  now = Date.now(),
): Monitor {
  const next: Monitor = { ...existing, health: { ...existing.health }, updatedAt: now };
  // Watching something else: what was seen before no longer applies.
  let reset = false;
  if ("url" in patch) {
    next.url = readUrl(patch.url);
    reset = true;
  }
  if ("extract" in patch) {
    next.extract = readExtract(patch.extract);
    reset = true;
  }
  if ("condition" in patch) {
    next.condition = readCondition(patch.condition);
    next.health.conditionMet = undefined;
  }
  if ("name" in patch && str(patch.name)) {
    next.name = str(patch.name).slice(0, 120);
  }
  if ("note" in patch) {
    next.note = str(patch.note).slice(0, 500) || undefined;
  }
  if ("intervalMs" in patch || "intervalMinutes" in patch) {
    next.intervalMs = readInterval(patch, existing.intervalMs);
  }
  if ("enabled" in patch) {
    next.enabled = patch.enabled !== false;
    if (next.enabled && !existing.enabled) {
      next.health.consecutiveErrors = 0;
      next.health.lastError = undefined;
    }
  }
  if (reset) {
    next.health = { consecutiveErrors: 0 };
  }
  return next;
}
