import fs from "node:fs";
import path from "node:path";
import { assertNotRealStateUnderTest } from "./test-state-guard.js";

// Lightweight queue for human-readable system events that should be prefixed
// to the next prompt. Events are session-scoped and require an explicit key.
//
// The queue lives in memory. The gateway also saves it to disk (PLAN-53 E7),
// because what waits here is often something the owner was promised: a
// reminder, the outcome of an approval, a finished task. A restart used to
// drop all of it. Saved events older than a day are not brought back, so a
// long outage does not replay stale news. Nothing is saved unless
// `enableSystemEventPersistence` is called, so tests and the CLI stay
// in-memory.

export type SystemEvent = { text: string; ts: number; contextKey?: string | null };

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
};

const queues = new Map<string, SessionQueue>();

/** Events saved longer ago than this are dropped on load. */
export const SYSTEM_EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;

let persistPath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): Record<string, SystemEvent[]> {
  const out: Record<string, SystemEvent[]> = {};
  for (const [key, entry] of queues) {
    if (entry.queue.length > 0) {
      out[key] = entry.queue;
    }
  }
  return out;
}

function writeNow(): void {
  if (!persistPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: snapshot() }), { mode: 0o600 });
    fs.renameSync(tmp, persistPath);
  } catch {
    // Persistence is a safety net; the in-memory queue still works without it.
  }
}

function schedulePersist(): void {
  if (!persistPath || persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/**
 * Save the queue to `filePath` from now on, after bringing back whatever a
 * previous process left there. Returns how many events were restored.
 */
export function enableSystemEventPersistence(filePath: string, nowMs = Date.now()): number {
  // A test run must never read or rewrite the real node's queue.
  assertNotRealStateUnderTest(filePath);
  persistPath = filePath;
  let restored = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      sessions?: Record<string, unknown>;
    };
    for (const [key, list] of Object.entries(parsed.sessions ?? {})) {
      if (!Array.isArray(list) || queues.has(key)) {
        continue;
      }
      const fresh = list.filter(
        (e): e is SystemEvent =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as SystemEvent).text === "string" &&
          typeof (e as SystemEvent).ts === "number" &&
          nowMs - (e as SystemEvent).ts < SYSTEM_EVENT_MAX_AGE_MS,
      );
      if (fresh.length === 0) {
        continue;
      }
      const queue = fresh.slice(-MAX_EVENTS);
      const last = queue[queue.length - 1];
      queues.set(key, {
        queue,
        lastText: last.text,
        lastContextKey: last.contextKey ?? null,
      });
      restored += queue.length;
    }
  } catch {
    // No file yet, or one that cannot be read: start empty.
  }
  // Rewrite without what was too old to keep.
  writeNow();
  return restored;
}

/** Write any pending change to disk now. Call on shutdown. */
export function flushSystemEventPersistence(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeNow();
}

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry =
    queues.get(key) ??
    (() => {
      const created: SessionQueue = {
        queue: [],
        lastText: null,
        lastContextKey: null,
      };
      queues.set(key, created);
      return created;
    })();
  const cleaned = text.trim();
  if (!cleaned) {
    return;
  }
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  entry.lastContextKey = normalizedContextKey;
  if (entry.lastText === cleaned) {
    return;
  } // skip consecutive duplicates
  entry.lastText = cleaned;
  entry.queue.push({
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  schedulePersist();
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  queues.delete(key);
  schedulePersist();
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((event) => ({ ...event })) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistPath = null;
}
