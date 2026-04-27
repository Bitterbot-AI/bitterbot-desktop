// Exponential retry backoff for recurring cron jobs after consecutive errors.
// The cadence is 30s → 1m → 5m → 15m → 60m, then stays at 60m. One-shot jobs
// (`at`) never retry — they disable after the first terminal run.

const STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function backoffDelayMs(consecutiveErrors: number): number {
  if (!Number.isFinite(consecutiveErrors) || consecutiveErrors <= 0) {
    return 0;
  }
  const idx = Math.min(consecutiveErrors - 1, STEPS_MS.length - 1);
  return STEPS_MS[idx];
}

// When in retry mode, defer the next fire to `now + backoff` if the natural
// schedule would have it sooner.
export function applyBackoff(
  scheduledNextMs: number,
  consecutiveErrors: number,
  nowMs = Date.now(),
): number {
  const delay = backoffDelayMs(consecutiveErrors);
  if (delay <= 0) {
    return scheduledNextMs;
  }
  return Math.max(scheduledNextMs, nowMs + delay);
}
