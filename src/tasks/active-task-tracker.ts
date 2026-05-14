/**
 * In-flight task-wakeup tracker (PLAN-17 Phase 2 E.3).
 *
 * The cron `runIsolatedJob` path calls `acquireTaskSlot` before
 * invoking an agent turn that is tagged with a `taskId`, and
 * `releaseTaskSlot` on completion. The tracker consults
 * `computeTaskConcurrency` (PLAN-16 Phase E) to compute the max
 * concurrent task wakeups allowed for the current hormonal state.
 *
 * Hormonal state is **optional**: callers that don't yet plumb a
 * per-process `HormonalStateManager` accessor get the baseline policy
 * (3 concurrent). A future PR can wire the hormonal getter via
 * `registerHormonalStateGetter` without touching the cron path.
 */

import type { HormonalState } from "../memory/hormonal.js";
import {
  type ConcurrencyPolicy,
  type ConcurrencyThresholds,
  computeTaskConcurrency,
  DEFAULT_CONCURRENCY_THRESHOLDS,
} from "./biology.js";

const BASELINE_HORMONAL_STATE: HormonalState = {
  dopamine: 0.15,
  cortisol: 0.02,
  oxytocin: 0.2,
  lastDecay: 0,
};

// Per-process registry of in-flight task wakeups, keyed by cron jobId.
const inflight = new Set<string>();

type HormonalGetter = () => HormonalState | null;
let hormonalGetter: HormonalGetter | null = null;

export function registerHormonalStateGetter(fn: HormonalGetter | null): void {
  hormonalGetter = fn;
}

/** Read-only view, for tests / dashboards. */
export function getInflightTaskCount(): number {
  return inflight.size;
}

/** Test helper: clear the registry. */
export function resetActiveTaskTrackerForTests(): void {
  inflight.clear();
  hormonalGetter = null;
}

export type AcquireResult = {
  ok: boolean;
  policy: ConcurrencyPolicy;
  inflight: number;
  reason?: "at_capacity";
};

export function acquireTaskSlot(opts: {
  jobId: string;
  hormonalState?: HormonalState;
}): AcquireResult {
  const hormonal = opts.hormonalState ?? hormonalGetter?.() ?? BASELINE_HORMONAL_STATE;
  const policy = computeTaskConcurrency(hormonal, readThresholdsFromEnv());
  if (inflight.size >= policy.maxConcurrent) {
    return { ok: false, policy, inflight: inflight.size, reason: "at_capacity" };
  }
  inflight.add(opts.jobId);
  return { ok: true, policy, inflight: inflight.size };
}

export function releaseTaskSlot(jobId: string): void {
  inflight.delete(jobId);
}

/**
 * Optional env override for thresholds — keeps the constant in
 * `biology.ts` as the source of truth but lets operators tune the
 * caps without a code change.
 */
function readThresholdsFromEnv(): ConcurrencyThresholds {
  const raw = process.env.BITTERBOT_TASKS_MAX_CONCURRENT;
  if (!raw) return DEFAULT_CONCURRENCY_THRESHOLDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY_THRESHOLDS;
  return {
    cortisolHigh: DEFAULT_CONCURRENCY_THRESHOLDS.cortisolHigh,
    cortisolMid: DEFAULT_CONCURRENCY_THRESHOLDS.cortisolMid,
    dopamineHigh: DEFAULT_CONCURRENCY_THRESHOLDS.dopamineHigh,
    maxParallelFocused: Math.min(parsed, DEFAULT_CONCURRENCY_THRESHOLDS.maxParallelFocused),
    maxParallelConservative: Math.min(
      parsed,
      DEFAULT_CONCURRENCY_THRESHOLDS.maxParallelConservative,
    ),
    maxParallelBaseline: parsed,
    maxParallelExploration: Math.max(parsed, DEFAULT_CONCURRENCY_THRESHOLDS.maxParallelExploration),
  };
}
