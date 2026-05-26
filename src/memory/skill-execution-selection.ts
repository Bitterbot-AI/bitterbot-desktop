/**
 * Held-out selection set for the skill-mutation validation gate (PLAN-21 Phase A).
 *
 * The deterministic-hash partition over `skill_executions` lets the validation
 * gate score a mutation against a fixed, reproducible subset of real past
 * trajectories rather than against LLM-synthesized scenarios that change on
 * every call. Two evaluations of the same mutation produce the same paired
 * trials, so verdicts are auditable across runs.
 *
 * No schema migration: the partition is derived purely from a SHA-1 of
 * `execution_id`. A row is always in the same partition forever, regardless of
 * who runs the query or when.
 *
 * Train/selection/test ratio defaults to 80/20/0 inside this module — only
 * train and selection are surfaced via the public API. The longmemeval split
 * (PLAN-21 Phase E) re-uses the same hash discipline but with a 20/10/70 ratio.
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/** Default held-out fraction. 20% reservation matches PLAN-21 Phase A. */
export const DEFAULT_HELD_OUT_FRACTION = 0.2;

/** Maximum rows returned by `listHeldOutExecutions` unless caller overrides. */
const DEFAULT_LIST_LIMIT = 20;

/** Minimum sample size before the gate uses bootstrap CI vs. the heuristic. */
export const MIN_PAIRED_FOR_BOOTSTRAP = 5;

export interface HeldOutExecution {
  /** `skill_executions.id`. */
  readonly id: string;
  /** `skill_executions.skill_crystal_id`. */
  readonly skillId: string;
  /** `skill_executions.session_id`, when present. PLAN-21 Phase D uses this
   *  to join back to `intervention_records` for the hormonal/GCCRF snapshot. */
  readonly sessionId: string | null;
  /** Wall-clock at execution completion (`completed_at`). */
  readonly completedAt: number;
  /** Whether the original execution was scored as success. */
  readonly success: boolean;
  /** Continuous reward signal, when available. */
  readonly rewardScore: number | null;
  /** Recorded error type, if any (used by the performance-gate prompt). */
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
 * the longmemeval split (Phase E) can re-use the same hash discipline with a
 * different ratio. Pure.
 */
export function hashBucket(id: string): number {
  const hex = createHash("sha1").update(id).digest("hex");
  // Take a stable byte slice and modulo by 100 — sufficient uniformity for
  // partitioning a few thousand rows.
  const n = parseInt(hex.slice(0, 8), 16);
  return n % 100;
}

/**
 * Read the held-out subset of completed executions for one skill, ordered by
 * recency. The validation gate uses this as its selection set.
 */
export function listHeldOutExecutions(
  db: DatabaseSync,
  skillId: string,
  options: { limit?: number; fraction?: number } = {},
): HeldOutExecution[] {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const fraction = options.fraction ?? DEFAULT_HELD_OUT_FRACTION;
  // Pull a generous oversample (5x the cap) so the post-filter still has
  // headroom to satisfy the limit even at a 20% reservation rate. Going wider
  // than that is wasted I/O.
  const oversample = Math.max(limit * 5, 50);
  type Row = {
    id: string;
    skill_crystal_id: string;
    session_id: string | null;
    completed_at: number;
    success: number | null;
    reward_score: number | null;
    error_type: string | null;
    context_json: string | null;
  };
  let rows: ReadonlyArray<Row>;
  try {
    rows = db
      .prepare(
        `SELECT id, skill_crystal_id, session_id, completed_at, success, reward_score, error_type, context_json
         FROM skill_executions
         WHERE skill_crystal_id = ? AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(skillId, oversample) as unknown as ReadonlyArray<Row>;
  } catch {
    return [];
  }

  const heldOut: HeldOutExecution[] = [];
  for (const row of rows) {
    if (!isHeldOut(row.id, fraction)) {
      continue;
    }
    heldOut.push({
      id: row.id,
      skillId: row.skill_crystal_id,
      sessionId: row.session_id,
      completedAt: row.completed_at,
      success: row.success === 1,
      rewardScore: row.reward_score,
      errorType: row.error_type,
      contextJson: row.context_json ?? "{}",
    });
    if (heldOut.length >= limit) {
      break;
    }
  }
  return heldOut;
}

/**
 * Return the count of held-out executions for a skill without materialising
 * the rows. Used by the cold-start fallback to decide whether the gate has
 * enough trials to run the bootstrap CI path.
 */
export function countHeldOutExecutions(
  db: DatabaseSync,
  skillId: string,
  fraction: number = DEFAULT_HELD_OUT_FRACTION,
): number {
  return listHeldOutExecutions(db, skillId, { fraction, limit: Number.MAX_SAFE_INTEGER }).length;
}

export const __testing = {
  hashBucket,
};
