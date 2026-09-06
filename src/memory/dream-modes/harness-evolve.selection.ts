// PLAN-25 Phase 2: a GLOBAL held-out trace set for validating harness-policy
// edits. PLAN-21's selection set is per-skill; a harness change is cross-cutting,
// so we sample held-out executions across all skills using the same deterministic
// hash partition (isHeldOut), guaranteeing reproducible, audit-stable splits.

import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_HELD_OUT_FRACTION,
  type HeldOutExecution,
  isHeldOut,
} from "../skill-execution-selection.js";

/**
 * PLAN-45 Phase 1 note: this module reads the TOOL-level `success` bit of
 * skill_executions on purpose. It measures harness policy (PLAN-25, off by
 * default), not skill competence; competence consumers use RUN_EVIDENCE_WHERE.
 *
 * List held-out executions across ALL skills, newest first. Deterministic: an
 * execution is in the held-out partition iff isHeldOut(id) — the same answer
 * forever, so two validation runs see the same split.
 */
export function listGlobalHeldOutExecutions(
  db: DatabaseSync,
  options: { limit?: number; fraction?: number; scanLimit?: number } = {},
): HeldOutExecution[] {
  const fraction = options.fraction ?? DEFAULT_HELD_OUT_FRACTION;
  const limit = options.limit ?? 24;
  const scanLimit = options.scanLimit ?? Math.max(limit * 20, 400);
  let rows: Array<{
    id: string;
    skill_crystal_id: string;
    session_id: string | null;
    completed_at: number;
    success: number | null;
    reward_score: number | null;
    error_type: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT id, skill_crystal_id, session_id, completed_at, success, reward_score, error_type
         FROM skill_executions
         WHERE completed_at IS NOT NULL
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(scanLimit) as typeof rows;
  } catch {
    return []; // table absent on a fresh install — loop stays inert
  }

  const out: HeldOutExecution[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!isHeldOut(r.id, fraction)) continue;
    out.push({
      id: r.id,
      skillId: r.skill_crystal_id,
      sessionId: r.session_id,
      completedAt: r.completed_at,
      success: r.success === 1,
      rewardScore: r.reward_score,
      errorType: r.error_type,
      contextJson: "{}",
    });
  }
  return out;
}
