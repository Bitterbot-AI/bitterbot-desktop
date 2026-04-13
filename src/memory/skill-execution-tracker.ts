/**
 * SkillExecutionTracker: tracks when skills are executed, records outcomes,
 * and computes empirical quality metrics for feedback into mutation scoring.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { ExecutionOutcome, SkillMetrics, PeerSkillMetrics } from "./crystal-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const _log = createSubsystemLogger("memory/execution-tracker");

export class SkillExecutionTracker {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Record when a skill starts executing. Returns the execution ID.
   */
  startExecution(skillCrystalId: string, sessionId?: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO skill_executions (id, skill_crystal_id, session_id, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, skillCrystalId, sessionId ?? null, now);
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

    // Update steering reward on the skill crystal
    const row = this.db
      .prepare(`SELECT skill_crystal_id FROM skill_executions WHERE id = ?`)
      .get(executionId) as { skill_crystal_id: string } | undefined;

    if (row) {
      const delta = outcome.success ? 0.1 : -0.05;
      this.db
        .prepare(
          `UPDATE chunks
           SET steering_reward = MAX(-1.0, MIN(1.0, COALESCE(steering_reward, 0) + ?))
           WHERE id = ?`,
        )
        .run(delta, row.skill_crystal_id);
    }
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
        `SELECT success, reward_score, error_type, execution_time_ms,
                user_feedback, started_at
         FROM skill_executions
         WHERE skill_crystal_id = ? AND completed_at IS NOT NULL
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
