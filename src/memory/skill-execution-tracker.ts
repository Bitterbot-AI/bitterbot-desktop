/**
 * SkillExecutionTracker: tracks when skills are executed, records outcomes,
 * and computes empirical quality metrics for feedback into mutation scoring.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { ExecutionOutcome, SkillMetrics, PeerSkillMetrics } from "./crystal-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const _log = createSubsystemLogger("memory/execution-tracker");

/** What a skill_executions row is evidence OF (PLAN-45 Phase 1.1). */
export type ExecutionEvidence = "tool" | "run" | "task" | "human";

/**
 * SQL predicate: rows that carry run-level-or-better evidence with a
 * determinate verdict. Tool-level rows (a tool call that did not report an
 * error) and indeterminate run labels (env-fail, unknown, unattributable)
 * never count toward competence. Every consumer of execution statistics
 * that feeds a decision must include this; `RUN_SUCCESS_EXPR` is the matching
 * success column (the tool-level `success` flag is NOT competence).
 */
export const RUN_EVIDENCE_WHERE =
  "COALESCE(evidence, 'tool') != 'tool' AND run_outcome_label IN ('pass', 'fail')";
export const RUN_SUCCESS_EXPR = "CASE WHEN run_outcome_label = 'pass' THEN 1 ELSE 0 END";
/** Same predicate with a table alias. */
export function runEvidenceWhere(alias: string): string {
  return `COALESCE(${alias}.evidence, 'tool') != 'tool' AND ${alias}.run_outcome_label IN ('pass', 'fail')`;
}
export function runSuccessExpr(alias: string): string {
  return `CASE WHEN ${alias}.run_outcome_label = 'pass' THEN 1 ELSE 0 END`;
}

export type RunOutcomeLabel = "pass" | "fail" | "env-fail" | "unknown" | "unattributable";

function evidenceForOutcome(label: RunOutcomeLabel, level: number): ExecutionEvidence {
  if (label !== "pass" && label !== "fail") {
    return "tool";
  }
  if (level >= 4) {
    return "human";
  }
  if (level >= 3) {
    return "task";
  }
  return "run";
}

/**
 * Stamp a run's grounded outcome on every not-yet-stamped execution row of
 * that run and move the crystals' steering reward on determinate verdicts.
 * Idempotent per row (run_outcome_level IS NULL guard). Returns rows stamped.
 */
export function stampExecutionRunOutcome(
  db: DatabaseSync,
  runId: string,
  outcome: { label: RunOutcomeLabel; level: number; at?: number },
): number {
  const evidence = evidenceForOutcome(outcome.label, outcome.level);
  const crystals = db
    .prepare(
      `SELECT DISTINCT skill_crystal_id FROM skill_executions
        WHERE run_id = ? AND run_outcome_level IS NULL`,
    )
    .all(runId) as Array<{ skill_crystal_id: string }>;
  const result = db
    .prepare(
      `UPDATE skill_executions
          SET run_outcome_label = ?, run_outcome_level = ?, run_outcome_at = ?, evidence = ?
        WHERE run_id = ? AND run_outcome_level IS NULL`,
    )
    .run(outcome.label, outcome.level, outcome.at ?? Date.now(), evidence, runId);
  const changes = Number(result.changes);
  if (changes > 0 && evidence !== "tool") {
    // Steering moves once per (run, crystal) on a run-level verdict; it used
    // to move +0.1 per tool call that did not throw.
    const delta = outcome.label === "pass" ? 0.1 : -0.05;
    const bump = db.prepare(
      `UPDATE chunks
          SET steering_reward = MAX(-1.0, MIN(1.0, COALESCE(steering_reward, 0) + ?))
        WHERE id = ?`,
    );
    for (const c of crystals) {
      bump.run(delta, c.skill_crystal_id);
    }
  }
  return changes;
}

function steeringDeltaFor(label: string | null): number {
  return label === "pass" ? 0.1 : label === "fail" ? -0.05 : 0;
}

/**
 * Overwrite a run's stamped outcome with a HIGHER-level verdict (human
 * feedback arrives after the fact by definition) and correct the steering
 * reward by the difference. Rows already at the target level or above are
 * left alone. Returns rows re-stamped. (adversarial H3)
 */
export function restampExecutionRunOutcome(
  db: DatabaseSync,
  runId: string,
  outcome: { label: RunOutcomeLabel; level: number; at?: number },
): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT skill_crystal_id, run_outcome_label FROM skill_executions
        WHERE run_id = ? AND (run_outcome_level IS NULL OR run_outcome_level < ?)`,
    )
    .all(runId, outcome.level) as Array<{
    skill_crystal_id: string;
    run_outcome_label: string | null;
  }>;
  if (rows.length === 0) {
    return 0;
  }
  const evidence = evidenceForOutcome(outcome.label, outcome.level);
  const result = db
    .prepare(
      `UPDATE skill_executions
          SET run_outcome_label = ?, run_outcome_level = ?, run_outcome_at = ?, evidence = ?
        WHERE run_id = ? AND (run_outcome_level IS NULL OR run_outcome_level < ?)`,
    )
    .run(outcome.label, outcome.level, outcome.at ?? Date.now(), evidence, runId, outcome.level);
  const bump = db.prepare(
    `UPDATE chunks
        SET steering_reward = MAX(-1.0, MIN(1.0, COALESCE(steering_reward, 0) + ?))
      WHERE id = ?`,
  );
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.skill_crystal_id)) {
      continue;
    }
    seen.add(r.skill_crystal_id);
    const delta = steeringDeltaFor(outcome.label) - steeringDeltaFor(r.run_outcome_label);
    if (delta !== 0) {
      bump.run(delta, r.skill_crystal_id);
    }
  }
  return Number(result.changes);
}

export class SkillExecutionTracker {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Record when a skill starts executing. Returns the execution ID.
   */
  startExecution(
    skillCrystalId: string,
    sessionId?: string,
    provenance?: {
      toolName?: string;
      recordedBy?: string;
      /** PLAN-45 Phase 1.1: the journal run and tool call this row belongs to. */
      runId?: string;
      toolCallId?: string;
      /** Defaults to "tool": the row proves a tool call, nothing more. */
      evidence?: ExecutionEvidence;
    },
  ): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    // PLAN-40 Phase 2a: tool_name + recorded_by give Lane 1 the provenance
    // the adversarial pass proved missing — pre-migration rows are
    // unattributable and excluded from distillation eligibility. Falls back
    // to the older column sets on pre-v64 / pre-v58 schemas.
    try {
      this.db
        .prepare(
          `INSERT INTO skill_executions (id, skill_crystal_id, session_id, started_at, tool_name, recorded_by,
             run_id, tool_call_id, evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          skillCrystalId,
          sessionId ?? null,
          now,
          provenance?.toolName ?? null,
          provenance?.recordedBy ?? null,
          provenance?.runId ?? null,
          provenance?.toolCallId ?? null,
          provenance?.evidence ?? "tool",
        );
      return id;
    } catch {
      /* pre-v64 schema: fall through */
    }
    try {
      this.db
        .prepare(
          `INSERT INTO skill_executions (id, skill_crystal_id, session_id, started_at, tool_name, recorded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          skillCrystalId,
          sessionId ?? null,
          now,
          provenance?.toolName ?? null,
          provenance?.recordedBy ?? null,
        );
    } catch {
      this.db
        .prepare(
          `INSERT INTO skill_executions (id, skill_crystal_id, session_id, started_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, skillCrystalId, sessionId ?? null, now);
    }
    return id;
  }

  /**
   * Record the outcome of a skill execution.
   */
  completeExecution(executionId: string, outcome: ExecutionOutcome): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE skill_executions
         SET completed_at = ?,
             success = ?,
             reward_score = ?,
             error_type = ?,
             error_detail = ?,
             execution_time_ms = ?,
             tool_calls_count = ?
         WHERE id = ?`,
      )
      .run(
        now,
        outcome.success ? 1 : 0,
        outcome.rewardScore ?? null,
        outcome.errorType ?? null,
        outcome.errorDetail ? String(outcome.errorDetail).slice(0, 500) : null,
        outcome.executionTimeMs ?? null,
        outcome.toolCallsCount ?? null,
        executionId,
      );

    // PLAN-45 Phase 1.1: steering no longer moves here. A completed row is
    // tool-level evidence; the crystal's steering reward moves when the
    // run's grounded outcome is stamped (stampExecutionRunOutcome).
  }

  /** See stampExecutionRunOutcome. */
  stampRunOutcome(
    runId: string,
    outcome: { label: RunOutcomeLabel; level: number; at?: number },
  ): number {
    return stampExecutionRunOutcome(this.db, runId, outcome);
  }

  /**
   * Record user feedback for an execution (may come asynchronously).
   */
  recordFeedback(executionId: string, feedback: -1 | 0 | 1): void {
    this.db
      .prepare(`UPDATE skill_executions SET user_feedback = ? WHERE id = ?`)
      .run(feedback, executionId);
  }

  /**
   * Compute empirical quality metrics for a skill crystal.
   */
  getSkillMetrics(skillCrystalId: string): SkillMetrics {
    const rows = this.db
      .prepare(
        `SELECT ${RUN_SUCCESS_EXPR} AS success, reward_score, error_type, execution_time_ms,
                user_feedback, started_at
         FROM skill_executions
         WHERE skill_crystal_id = ? AND completed_at IS NOT NULL AND ${RUN_EVIDENCE_WHERE}
         ORDER BY started_at DESC`,
      )
      .all(skillCrystalId) as Array<{
      success: number | null;
      reward_score: number | null;
      error_type: string | null;
      execution_time_ms: number | null;
      user_feedback: number | null;
      started_at: number;
    }>;

    if (rows.length === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        avgRewardScore: 0,
        avgExecutionTimeMs: 0,
        userFeedbackScore: 0,
        lastExecutedAt: 0,
        errorBreakdown: {},
      };
    }

    let successes = 0;
    let totalReward = 0;
    let rewardCount = 0;
    let totalTime = 0;
    let timeCount = 0;
    let feedbackTotal = 0;
    let feedbackCount = 0;
    const errorBreakdown: Record<string, number> = {};

    for (const row of rows) {
      if (row.success === 1) {
        successes++;
      }
      if (row.reward_score != null) {
        totalReward += row.reward_score;
        rewardCount++;
      }
      if (row.execution_time_ms != null) {
        totalTime += row.execution_time_ms;
        timeCount++;
      }
      if (row.user_feedback != null) {
        feedbackTotal += row.user_feedback;
        feedbackCount++;
      }
      if (row.error_type) {
        errorBreakdown[row.error_type] = (errorBreakdown[row.error_type] ?? 0) + 1;
      }
    }

    return {
      totalExecutions: rows.length,
      successRate: successes / rows.length,
      avgRewardScore: rewardCount > 0 ? totalReward / rewardCount : 0,
      avgExecutionTimeMs: timeCount > 0 ? totalTime / timeCount : 0,
      userFeedbackScore: feedbackCount > 0 ? feedbackTotal / feedbackCount : 0,
      lastExecutedAt: rows[0]!.started_at,
      errorBreakdown,
    };
  }

  /**
   * Aggregate metrics across every skill crystal whose `skill_category`
   * matches the given key. Used by the gateway to surface per-skillKey
   * counters for SKILL.md-based skills (which may map to 0..N crystals).
   */
  getMetricsForSkillKey(skillKey: string): SkillMetrics {
    const trimmed = skillKey.trim();
    if (!trimmed) {
      return {
        totalExecutions: 0,
        successRate: 0,
        avgRewardScore: 0,
        avgExecutionTimeMs: 0,
        userFeedbackScore: 0,
        lastExecutedAt: 0,
        errorBreakdown: {},
      };
    }
    const rows = this.db
      .prepare(
        `SELECT ${runSuccessExpr("se")} AS success, se.reward_score, se.error_type, se.execution_time_ms,
                se.user_feedback, se.started_at
         FROM skill_executions se
         JOIN chunks c ON c.id = se.skill_crystal_id
         WHERE c.skill_category = ? AND se.completed_at IS NOT NULL AND ${runEvidenceWhere("se")}
         ORDER BY se.started_at DESC`,
      )
      .all(trimmed) as Array<{
      success: number | null;
      reward_score: number | null;
      error_type: string | null;
      execution_time_ms: number | null;
      user_feedback: number | null;
      started_at: number;
    }>;

    if (rows.length === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        avgRewardScore: 0,
        avgExecutionTimeMs: 0,
        userFeedbackScore: 0,
        lastExecutedAt: 0,
        errorBreakdown: {},
      };
    }

    let successes = 0;
    let totalReward = 0;
    let rewardCount = 0;
    let totalTime = 0;
    let timeCount = 0;
    let feedbackTotal = 0;
    let feedbackCount = 0;
    const errorBreakdown: Record<string, number> = {};

    for (const row of rows) {
      if (row.success === 1) successes++;
      if (row.reward_score != null) {
        totalReward += row.reward_score;
        rewardCount++;
      }
      if (row.execution_time_ms != null) {
        totalTime += row.execution_time_ms;
        timeCount++;
      }
      if (row.user_feedback != null) {
        feedbackTotal += row.user_feedback;
        feedbackCount++;
      }
      if (row.error_type) {
        errorBreakdown[row.error_type] = (errorBreakdown[row.error_type] ?? 0) + 1;
      }
    }

    return {
      totalExecutions: rows.length,
      successRate: successes / rows.length,
      avgRewardScore: rewardCount > 0 ? totalReward / rewardCount : 0,
      avgExecutionTimeMs: timeCount > 0 ? totalTime / timeCount : 0,
      userFeedbackScore: feedbackCount > 0 ? feedbackTotal / feedbackCount : 0,
      lastExecutedAt: rows[0]!.started_at,
      errorBreakdown,
    };
  }

  /**
   * Bulk variant: returns one entry per distinct `skill_category` that has
   * at least one completed execution. Cheap single-query rollup used by
   * the gateway when callers omit skillKey.
   */
  getAllSkillKeyMetrics(): Array<{ skillKey: string; metrics: SkillMetrics }> {
    const rows = this.db
      .prepare(
        `SELECT c.skill_category AS skill_category,
                ${runSuccessExpr("se")} AS success, se.reward_score, se.error_type,
                se.execution_time_ms, se.user_feedback, se.started_at
         FROM skill_executions se
         JOIN chunks c ON c.id = se.skill_crystal_id
         WHERE c.skill_category IS NOT NULL
           AND c.skill_category != ''
           AND se.completed_at IS NOT NULL
           AND ${runEvidenceWhere("se")}
         ORDER BY se.started_at DESC`,
      )
      .all() as Array<{
      skill_category: string;
      success: number | null;
      reward_score: number | null;
      error_type: string | null;
      execution_time_ms: number | null;
      user_feedback: number | null;
      started_at: number;
    }>;

    const byKey = new Map<
      string,
      {
        rows: number;
        successes: number;
        rewardSum: number;
        rewardCount: number;
        timeSum: number;
        timeCount: number;
        fbSum: number;
        fbCount: number;
        errors: Record<string, number>;
        lastAt: number;
      }
    >();
    for (const row of rows) {
      const key = row.skill_category;
      let agg = byKey.get(key);
      if (!agg) {
        agg = {
          rows: 0,
          successes: 0,
          rewardSum: 0,
          rewardCount: 0,
          timeSum: 0,
          timeCount: 0,
          fbSum: 0,
          fbCount: 0,
          errors: {},
          lastAt: 0,
        };
        byKey.set(key, agg);
      }
      agg.rows++;
      if (row.success === 1) agg.successes++;
      if (row.reward_score != null) {
        agg.rewardSum += row.reward_score;
        agg.rewardCount++;
      }
      if (row.execution_time_ms != null) {
        agg.timeSum += row.execution_time_ms;
        agg.timeCount++;
      }
      if (row.user_feedback != null) {
        agg.fbSum += row.user_feedback;
        agg.fbCount++;
      }
      if (row.error_type) {
        agg.errors[row.error_type] = (agg.errors[row.error_type] ?? 0) + 1;
      }
      if (row.started_at > agg.lastAt) {
        agg.lastAt = row.started_at;
      }
    }

    return [...byKey.entries()].map(([skillKey, agg]) => ({
      skillKey,
      metrics: {
        totalExecutions: agg.rows,
        successRate: agg.rows > 0 ? agg.successes / agg.rows : 0,
        avgRewardScore: agg.rewardCount > 0 ? agg.rewardSum / agg.rewardCount : 0,
        avgExecutionTimeMs: agg.timeCount > 0 ? agg.timeSum / agg.timeCount : 0,
        userFeedbackScore: agg.fbCount > 0 ? agg.fbSum / agg.fbCount : 0,
        lastExecutedAt: agg.lastAt,
        errorBreakdown: agg.errors,
      },
    }));
  }

  /**
   * Get aggregated metrics for skills from a specific peer.
   */
  getPeerSkillMetrics(peerPubkey: string): PeerSkillMetrics {
    // Find all skill crystals from this peer
    const skills = this.db
      .prepare(
        `SELECT id FROM chunks
         WHERE governance_json LIKE ?
           AND (COALESCE(memory_type, 'plaintext') = 'skill' OR COALESCE(semantic_type, 'general') = 'skill')`,
      )
      .all(`%"peerOrigin":"${peerPubkey}"%`) as Array<{ id: string }>;

    if (skills.length === 0) {
      return { peerPubkey, totalSkills: 0, avgSuccessRate: 0, avgRewardScore: 0 };
    }

    let totalSuccess = 0;
    let totalReward = 0;
    let counted = 0;

    for (const skill of skills) {
      const metrics = this.getSkillMetrics(skill.id);
      if (metrics.totalExecutions > 0) {
        totalSuccess += metrics.successRate;
        totalReward += metrics.avgRewardScore;
        counted++;
      }
    }

    return {
      peerPubkey,
      totalSkills: skills.length,
      avgSuccessRate: counted > 0 ? totalSuccess / counted : 0,
      avgRewardScore: counted > 0 ? totalReward / counted : 0,
    };
  }

  /**
   * Decay all steering rewards by a factor (called during consolidation).
   */
  decaySteeringRewards(factor = 0.95): number {
    const result = this.db
      .prepare(
        `UPDATE chunks SET steering_reward = steering_reward * ?
         WHERE steering_reward != 0`,
      )
      .run(factor);
    return (result as { changes: number }).changes;
  }
}
