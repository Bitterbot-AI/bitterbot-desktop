/**
 * Prompt cache observability for Anthropic-style prompt caching.
 *
 * What this measures:
 *   - Per-session hit ratio (lifetime + last-N).
 *   - "Cache bust" events: turns where we wrote to the cache despite a
 *     previous turn having read from it, indicating that something in the
 *     stable prefix changed mid-session.
 *
 * What this does NOT do:
 *   - It does not hash the actual prompt prefix. That would require
 *     touching pi-coding-agent's internals (where the prompt is built).
 *     The detection here is heuristic on usage tokens, which is the
 *     observable signal we already have at the post-response boundary.
 *
 * Cache hits require byte-identical prefixes per Anthropic's docs, so the
 * usual culprits behind a bust are: skill-list mutation, hormonal-state
 * injection, model swap, verbose-level change, or any other stable-prefix
 * mutation. The monitor logs the bust event so callers (doctor, telemetry)
 * can correlate against config changes.
 */

const RING_SIZE = 50;

export type CacheTurn = {
  ts: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export type CacheSession = {
  totalInput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalOutput: number;
  turns: number;
  busts: number;
  ring: CacheTurn[];
  /** Index of next write into the ring (for amortized O(1) ringbuffer). */
  ringHead: number;
};

const sessions = new Map<string, CacheSession>();

function newSession(): CacheSession {
  return {
    totalInput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalOutput: 0,
    turns: 0,
    busts: 0,
    ring: [],
    ringHead: 0,
  };
}

function getOrCreate(sessionKey: string): CacheSession {
  let s = sessions.get(sessionKey);
  if (!s) {
    s = newSession();
    sessions.set(sessionKey, s);
  }
  return s;
}

function ringPush(s: CacheSession, turn: CacheTurn): void {
  if (s.ring.length < RING_SIZE) {
    s.ring.push(turn);
  } else {
    s.ring[s.ringHead] = turn;
  }
  s.ringHead = (s.ringHead + 1) % RING_SIZE;
}

function ringInOrder(s: CacheSession): CacheTurn[] {
  if (s.ring.length < RING_SIZE) return s.ring.slice();
  // Reorder so the oldest entry is first.
  return [...s.ring.slice(s.ringHead), ...s.ring.slice(0, s.ringHead)];
}

export type RecordResult = {
  /** Set when this turn looks like a cache bust (the rule mirrors the
   *  Anthropic docs: a write where we expected a read). */
  bust: boolean;
};

/**
 * Record one observed turn for a session. Returns whether this turn looks
 * like a cache bust so the caller can emit a telemetry event.
 *
 * Bust heuristic: this turn wrote to the cache (cacheWrite > 0), AND the
 * previous turn had a positive read with comparable input size. A pure
 * "first turn of the session" naturally writes the cache; we only flag
 * busts after at least one prior cached turn.
 */
export function recordCacheTurn(
  sessionKey: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  now = Date.now(),
): RecordResult {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const output = usage.output ?? 0;

  // Skip turns with no observable cache traffic. Some providers don't emit
  // cache fields at all; recording zeros would dilute the metric.
  if (input === 0 && cacheRead === 0 && cacheWrite === 0) {
    return { bust: false };
  }

  const s = getOrCreate(sessionKey);
  const prev = s.ring.length > 0 ? s.ring[(s.ringHead - 1 + RING_SIZE) % RING_SIZE] : undefined;

  const turn: CacheTurn = { ts: now, input, cacheRead, cacheWrite, output };

  // Bust if: previous turn had a meaningful cacheRead, this turn has
  // cacheWrite without compensating cacheRead, and the input shapes are
  // similar (within 30%) — "similar input but the cache no longer worked".
  let bust = false;
  if (prev && prev.cacheRead > 0 && cacheWrite > 0 && cacheRead === 0) {
    const inputDelta = Math.abs(input - prev.input);
    const inputBase = Math.max(1, prev.input);
    if (inputDelta / inputBase < 0.3) {
      bust = true;
      s.busts += 1;
    }
  }

  s.totalInput += input;
  s.totalCacheRead += cacheRead;
  s.totalCacheWrite += cacheWrite;
  s.totalOutput += output;
  s.turns += 1;
  ringPush(s, turn);

  return { bust };
}

export type CacheMetrics = {
  sessionKey: string;
  turns: number;
  busts: number;
  /** lifetime hit ratio: cacheRead / (cacheRead + cacheWrite + input) */
  hitRatio: number;
  /** ratio over the most recent ring window (up to RING_SIZE turns). */
  recentHitRatio: number;
  /** Total cached input bytes (read or write). */
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
};

/** Snapshot for a single session. Returns null if the session has no
 *  recorded turns yet (so callers can skip "no data" entries). */
export function getCacheMetrics(sessionKey: string): CacheMetrics | null {
  const s = sessions.get(sessionKey);
  if (!s || s.turns === 0) return null;
  const denom = s.totalCacheRead + s.totalCacheWrite + s.totalInput;
  const hitRatio = denom > 0 ? s.totalCacheRead / denom : 0;
  const recent = ringInOrder(s);
  let rRead = 0;
  let rDenom = 0;
  for (const t of recent) {
    rRead += t.cacheRead;
    rDenom += t.cacheRead + t.cacheWrite + t.input;
  }
  const recentHitRatio = rDenom > 0 ? rRead / rDenom : 0;
  return {
    sessionKey,
    turns: s.turns,
    busts: s.busts,
    hitRatio,
    recentHitRatio,
    cacheRead: s.totalCacheRead,
    cacheWrite: s.totalCacheWrite,
    input: s.totalInput,
    output: s.totalOutput,
  };
}

/** All sessions with at least one observed turn, sorted by most recent activity. */
export function listCacheMetrics(): CacheMetrics[] {
  const out: CacheMetrics[] = [];
  for (const sessionKey of sessions.keys()) {
    const m = getCacheMetrics(sessionKey);
    if (m) out.push(m);
  }
  return out.toSorted((a, b) => b.turns - a.turns);
}

// ── Test helpers ──

/** @internal */
export function __resetCacheMonitorForTest(sessionKey?: string): void {
  if (sessionKey) {
    sessions.delete(sessionKey);
  } else {
    sessions.clear();
  }
}

/** @internal */
export const __cacheMonitorConsts = Object.freeze({ RING_SIZE });
