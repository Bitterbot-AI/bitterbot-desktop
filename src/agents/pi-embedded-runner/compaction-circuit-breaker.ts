/**
 * Per-session circuit breaker for conversation compaction.
 *
 * State machine: closed → open → half-open → closed.
 *
 *   closed:    compaction runs normally.
 *   open:      compaction is short-circuited; callers fall back to other
 *              context-shrinking strategies (oldest-tool-result truncation).
 *              Triggered after `FAILURE_THRESHOLD` consecutive failures
 *              whose classification is "breaking" (i.e. not just "nothing
 *              to compact" or "below threshold").
 *   half-open: after the cooldown elapses, exactly one trial compaction
 *              is allowed. Success returns to closed; failure returns to
 *              open with cooldown doubled (capped at MAX_COOLDOWN_MS).
 *
 * The breaker is keyed by session, kept in-memory only (no persistence —
 * a process restart resets every session, which is the right default).
 *
 * Reasoning behind the constants:
 *   - 3 consecutive failures is the same threshold the leaked Claude Code
 *     used (MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3). Two means a single
 *     transient hiccup opens; four means a clearly broken session burns
 *     more cycles than necessary.
 *   - 10-minute initial cooldown matches the Maxim/circuit-breaker norm
 *     for LLM apps and gives transient provider issues room to recover.
 *   - 1-hour cap keeps a session from being permanently "stuck open"
 *     while still throttling repeated trial-and-fail.
 */

const FAILURE_THRESHOLD = 3;
const INITIAL_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/** Reasons (after `classifyCompactionReason`) that should NOT count toward
 *  the failure threshold — these mean "we deliberately chose not to compact"
 *  rather than "compaction tried and broke". */
const NON_BREAKING_REASONS: ReadonlySet<string> = new Set([
  "below_threshold",
  "no_compactable_entries",
  "already_compacted_recently",
  "guard_blocked",
]);

export type BreakerState = "closed" | "open" | "half-open";

type SessionBreaker = {
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil: number;
  cooldownMs: number;
  lastReason?: string;
  /** Trials run from half-open; for telemetry only. */
  trials: number;
};

const breakers = new Map<string, SessionBreaker>();

function newBreaker(): SessionBreaker {
  return {
    state: "closed",
    consecutiveFailures: 0,
    lastFailureAt: 0,
    cooldownUntil: 0,
    cooldownMs: INITIAL_COOLDOWN_MS,
    lastReason: undefined,
    trials: 0,
  };
}

function getOrCreate(sessionKey: string): SessionBreaker {
  let b = breakers.get(sessionKey);
  if (!b) {
    b = newBreaker();
    breakers.set(sessionKey, b);
  }
  return b;
}

export type BreakerCheck =
  | { allow: true; state: BreakerState }
  | {
      allow: false;
      state: "open";
      reason: string;
      cooldownRemainingMs: number;
    };

/**
 * Returns whether a compaction attempt is allowed right now. If the breaker
 * is open and the cooldown has elapsed, this transitions it to half-open
 * and returns `allow: true` so the caller can run a single trial.
 */
export function checkCompactionBreaker(sessionKey: string, now = Date.now()): BreakerCheck {
  const b = getOrCreate(sessionKey);
  if (b.state === "closed") {
    return { allow: true, state: "closed" };
  }
  if (b.state === "open") {
    if (now >= b.cooldownUntil) {
      b.state = "half-open";
      b.trials += 1;
      return { allow: true, state: "half-open" };
    }
    return {
      allow: false,
      state: "open",
      reason: b.lastReason ?? "compaction breaker open",
      cooldownRemainingMs: Math.max(0, b.cooldownUntil - now),
    };
  }
  // half-open: a trial is already in flight. Block any concurrent trial so
  // we don't multiply the bill across simultaneous calls. The next
  // `recordSuccess` or `recordFailure` will resolve the state.
  return {
    allow: false,
    state: "open",
    reason: "trial in flight",
    cooldownRemainingMs: 0,
  };
}

/**
 * Record a successful compaction for the session. Closes the breaker
 * (whether previously closed, half-open, or otherwise).
 */
export function recordCompactionSuccess(sessionKey: string): void {
  const b = getOrCreate(sessionKey);
  b.state = "closed";
  b.consecutiveFailures = 0;
  b.cooldownMs = INITIAL_COOLDOWN_MS;
  b.lastReason = undefined;
}

export type RecordFailureResult = {
  /** True if this failure caused the breaker to open or re-open. */
  opened: boolean;
  state: BreakerState;
  consecutiveFailures: number;
  cooldownUntil: number;
};

/**
 * Record a failed compaction. `classifiedReason` should come from
 * `classifyCompactionReason` so non-breaking outcomes (like
 * "below_threshold") don't accidentally trip the breaker.
 */
export function recordCompactionFailure(
  sessionKey: string,
  classifiedReason: string,
  now = Date.now(),
): RecordFailureResult {
  const b = getOrCreate(sessionKey);
  b.lastReason = classifiedReason;
  b.lastFailureAt = now;

  // Non-breaking reasons reset failures (we successfully decided not to
  // compact, so the system isn't "broken").
  if (NON_BREAKING_REASONS.has(classifiedReason)) {
    b.consecutiveFailures = 0;
    if (b.state === "half-open") {
      b.state = "closed";
      b.cooldownMs = INITIAL_COOLDOWN_MS;
    }
    return {
      opened: false,
      state: b.state,
      consecutiveFailures: 0,
      cooldownUntil: b.cooldownUntil,
    };
  }

  b.consecutiveFailures += 1;

  // From half-open: any breaking failure → re-open with doubled cooldown.
  if (b.state === "half-open") {
    b.cooldownMs = Math.min(b.cooldownMs * 2, MAX_COOLDOWN_MS);
    b.state = "open";
    b.cooldownUntil = now + b.cooldownMs;
    return {
      opened: true,
      state: "open",
      consecutiveFailures: b.consecutiveFailures,
      cooldownUntil: b.cooldownUntil,
    };
  }

  // From closed: open after threshold.
  if (b.consecutiveFailures >= FAILURE_THRESHOLD && b.state === "closed") {
    b.state = "open";
    b.cooldownUntil = now + b.cooldownMs;
    return {
      opened: true,
      state: "open",
      consecutiveFailures: b.consecutiveFailures,
      cooldownUntil: b.cooldownUntil,
    };
  }

  return {
    opened: false,
    state: b.state,
    consecutiveFailures: b.consecutiveFailures,
    cooldownUntil: b.cooldownUntil,
  };
}

/** Snapshot for diagnostics. */
export function getCompactionBreakerSnapshot(sessionKey: string): {
  state: BreakerState;
  consecutiveFailures: number;
  lastReason?: string;
  cooldownUntil: number;
  cooldownMs: number;
  trials: number;
} | null {
  const b = breakers.get(sessionKey);
  if (!b) return null;
  return {
    state: b.state,
    consecutiveFailures: b.consecutiveFailures,
    lastReason: b.lastReason,
    cooldownUntil: b.cooldownUntil,
    cooldownMs: b.cooldownMs,
    trials: b.trials,
  };
}

/** All currently-tracked session keys. Useful for `bitterbot doctor`. */
export function listCompactionBreakers(): Array<{
  sessionKey: string;
  state: BreakerState;
  consecutiveFailures: number;
  lastReason?: string;
  cooldownUntil: number;
}> {
  const out: Array<{
    sessionKey: string;
    state: BreakerState;
    consecutiveFailures: number;
    lastReason?: string;
    cooldownUntil: number;
  }> = [];
  for (const [sessionKey, b] of breakers) {
    out.push({
      sessionKey,
      state: b.state,
      consecutiveFailures: b.consecutiveFailures,
      lastReason: b.lastReason,
      cooldownUntil: b.cooldownUntil,
    });
  }
  return out;
}

// ── Test helpers ──

/** @internal Reset a single session breaker. Tests only. */
export function __resetCompactionBreakerForTest(sessionKey?: string): void {
  if (sessionKey) {
    breakers.delete(sessionKey);
  } else {
    breakers.clear();
  }
}

/** @internal Read constants for assertions. */
export const __compactionBreakerConsts = Object.freeze({
  FAILURE_THRESHOLD,
  INITIAL_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
});
