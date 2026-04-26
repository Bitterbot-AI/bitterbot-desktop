/**
 * Append-only log of heartbeat-cycle "considerations" — what the agent
 * thought about, including options it ultimately rejected. Complements
 * the existing `system-events` queue (which records what happened) by
 * answering "why did or didn't the agent do X?" after the fact.
 *
 * Storage: per-day NDJSON file at
 *   ~/.bitterbot/heartbeat/considerations-YYYY-MM-DD.ndjson
 * One JSON object per line. Writes are coalesced into batches with a
 * short flush interval, so an emit() at heartbeat-tick rate doesn't
 * stall the event loop. An in-memory ring buffer of the last RING_MAX
 * entries gives the CLI/UI a fast read path that doesn't have to
 * touch disk.
 *
 * Retention: rotate daily; prune any file whose date is more than
 * RETENTION_DAYS old at flush time. Pruning is async and best-effort.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

const RETENTION_DAYS = 30;
const RING_MAX = 1000;
const FLUSH_INTERVAL_MS = 2000;
const DIR_NAME = "heartbeat";
const FILE_PREFIX = "considerations-";
const FILE_SUFFIX = ".ndjson";

export type ConsiderationCategory =
  | "trigger"
  | "skill-eligibility"
  | "channel-route"
  | "bounty-match"
  | "dream-target"
  | "skill-crystallize"
  | "compaction"
  | "spawn"
  | "other";

export type ConsiderationDecision = "acted" | "skipped" | "deferred" | "blocked";

export type Consideration = {
  ts: number;
  sessionKey?: string;
  cycleId?: string;
  category: ConsiderationCategory;
  subject: string;
  decision: ConsiderationDecision;
  reason: string;
  /** Free-form structured payload; serialized as-is. Keep it small. */
  payload?: Record<string, unknown>;
};

const ring: Consideration[] = [];
let ringHead = 0;
let pendingBatch: Consideration[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let lastRetentionPruneDay: string | null = null;

function todayKey(now = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fileForDay(dayKey: string): string {
  return path.join(CONFIG_DIR, DIR_NAME, `${FILE_PREFIX}${dayKey}${FILE_SUFFIX}`);
}

function pushRing(entry: Consideration): void {
  if (ring.length < RING_MAX) {
    ring.push(entry);
  } else {
    ring[ringHead] = entry;
  }
  ringHead = (ringHead + 1) % RING_MAX;
}

/**
 * Record a single consideration. Non-blocking: appends to the in-memory
 * ring immediately and queues a disk write for the next batch flush.
 */
export function recordConsideration(entry: Omit<Consideration, "ts">, now = Date.now()): void {
  const full: Consideration = { ...entry, ts: now };
  pushRing(full);
  pendingBatch.push(full);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushConsiderationsNow().catch(() => {
      // Errors are swallowed: a failed write loses the latest batch but
      // must not propagate into heartbeat code.
    });
  }, FLUSH_INTERVAL_MS);
  // Allow the process to exit cleanly even with a pending flush.
  flushTimer.unref?.();
}

/**
 * Flush the pending batch to disk now. Safe to call from outside;
 * tests use this to read deterministically without waiting.
 */
export async function flushConsiderationsNow(now = new Date()): Promise<void> {
  const batch = pendingBatch;
  pendingBatch = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (batch.length === 0) return;

  const day = todayKey(now);
  const filePath = fileForDay(day);
  const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, lines, "utf-8");
  } catch {
    // Best-effort: if the disk is full or permissions broken, drop the
    // batch and keep going. The ring buffer still has it.
  }

  // Best-effort retention pruning, at most once per day.
  if (lastRetentionPruneDay !== day) {
    lastRetentionPruneDay = day;
    void pruneOldFiles(now).catch(() => {});
  }
}

async function pruneOldFiles(now: Date): Promise<void> {
  const dir = path.join(CONFIG_DIR, DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffKey = todayKey(cutoff);
  for (const entry of entries) {
    if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) continue;
    const dayKey = entry.slice(FILE_PREFIX.length, entry.length - FILE_SUFFIX.length);
    if (dayKey < cutoffKey) {
      try {
        await fs.unlink(path.join(dir, entry));
      } catch {
        // ignore
      }
    }
  }
}

// ── Read APIs ──

export type WhyQuery = {
  sessionKey?: string;
  category?: ConsiderationCategory;
  decision?: ConsiderationDecision;
  /** Newest first; default 50, max 500. */
  limit?: number;
};

/**
 * Return entries from the in-memory ring matching the query, newest first.
 * Fast (no disk). Use `loadDayFile` for older entries.
 */
export function recentConsiderations(query: WhyQuery = {}): Consideration[] {
  const limit = Math.min(Math.max(1, query.limit ?? 50), 500);
  // Reconstruct in chronological order from the ring then reverse.
  const ordered: Consideration[] =
    ring.length < RING_MAX ? [...ring] : [...ring.slice(ringHead), ...ring.slice(0, ringHead)];
  const out: Consideration[] = [];
  for (let i = ordered.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ordered[i]!;
    if (query.sessionKey && e.sessionKey !== query.sessionKey) continue;
    if (query.category && e.category !== query.category) continue;
    if (query.decision && e.decision !== query.decision) continue;
    out.push(e);
  }
  return out;
}

/**
 * Read a specific day's file from disk and return matching entries
 * newest-first. Returns [] if the file doesn't exist or is unreadable.
 */
export async function loadDayConsiderations(
  dayKey: string,
  query: WhyQuery = {},
): Promise<Consideration[]> {
  const filePath = fileForDay(dayKey);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const limit = Math.min(Math.max(1, query.limit ?? 50), 500);
  const out: Consideration[] = [];
  // Iterate lines back-to-front for newest-first.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: Consideration;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (query.sessionKey && parsed.sessionKey !== query.sessionKey) continue;
    if (query.category && parsed.category !== query.category) continue;
    if (query.decision && parsed.decision !== query.decision) continue;
    out.push(parsed);
  }
  return out;
}

// ── Test helpers ──

/** @internal */
export function __resetConsiderationsForTest(): void {
  ring.length = 0;
  ringHead = 0;
  pendingBatch = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastRetentionPruneDay = null;
}

/** @internal */
export const __considerationsConsts = Object.freeze({
  RETENTION_DAYS,
  RING_MAX,
  FLUSH_INTERVAL_MS,
  DIR_NAME,
  FILE_PREFIX,
  FILE_SUFFIX,
});

/** @internal */
export function __considerationsTodayKey(now?: Date): string {
  return todayKey(now);
}
