/**
 * Deterministic held-out partition over `skill_executions`.
 *
 * Originally the selection set for the PLAN-21 skill-mutation gate (retired
 * in PLAN-45 Phase 1). The hash partition survives because harness-evolve
 * (PLAN-25) samples a GLOBAL held-out trace set with `isHeldOut`, and the
 * skill-evolution sampler re-uses `hashBucket` for its own splits.
 *
 * No schema migration: the partition is derived purely from a SHA-1 of
 * `execution_id`. A row is always in the same partition forever, regardless of
 * who runs the query or when.
 */

import { createHash } from "node:crypto";

/** Default held-out fraction. 20% reservation matches PLAN-21 Phase A. */
export const DEFAULT_HELD_OUT_FRACTION = 0.2;

/** Minimum paired sample size before harness-evolve trusts the bootstrap CI. */
export const MIN_PAIRED_FOR_BOOTSTRAP = 5;

export interface HeldOutExecution {
  /** `skill_executions.id`. */
  readonly id: string;
  /** `skill_executions.skill_crystal_id`. */
  readonly skillId: string;
  /** `skill_executions.session_id`, when present. */
  readonly sessionId: string | null;
  /** Wall-clock at execution completion (`completed_at`). */
  readonly completedAt: number;
  /** Whether the original execution was scored as success. */
  readonly success: boolean;
  /** Continuous reward signal, when available. */
  readonly rewardScore: number | null;
  /** Recorded error type, if any (rendered into the paired-judge prompt). */
  readonly errorType: string | null;
  /** JSON-encoded context from `skill_executions.context_json`. */
  readonly contextJson: string;
}

/**
 * Pure: decide whether the given execution id belongs to the held-out
 * selection partition. Deterministic across processes — same input string
 * always yields the same bucket.
 */
export function isHeldOut(
  executionId: string,
  fraction: number = DEFAULT_HELD_OUT_FRACTION,
): boolean {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return false;
  }
  if (fraction >= 1) {
    return true;
  }
  const bucket = hashBucket(executionId);
  // Buckets are 0..99 inclusive.
  return bucket < Math.floor(fraction * 100);
}

/**
 * Return the deterministic SHA-1 hash bucket [0, 99] for an id. Exposed so
 * other samplers can re-use the same hash discipline with a different
 * ratio. Pure.
 */
export function hashBucket(id: string): number {
  const hex = createHash("sha1").update(id).digest("hex");
  // Take a stable byte slice and modulo by 100 — sufficient uniformity for
  // partitioning a few thousand rows.
  const n = parseInt(hex.slice(0, 8), 16);
  return n % 100;
}

export const __testing = {
  hashBucket,
};
