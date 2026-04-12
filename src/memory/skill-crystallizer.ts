/**
 * SkillCrystallizer: auto-generates new skill crystals from execution patterns.
 *
 * This is the `git commit` of a new experiment in the Karpathy autoresearch
 * pattern. When execution data shows a tool being used successfully and
 * consistently, a new skill crystal is created to capture that pattern.
 *
 * Criteria:
 *  - ≥3 successful executions for a given tool pattern
 *  - >70% success rate
 *  - No existing skill crystal for that pattern (dedup)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/crystallizer");

const MIN_SUCCESSES = 3;
const MIN_SUCCESS_RATE = 0.7;

type ExecutionPattern = {
  skillCrystalId: string;
  totalExecutions: number;
  successes: number;
  successRate: number;
  toolName: string | null;
};

export class SkillCrystallizer {
  private readonly db: DatabaseSync;
  private readonly executionTracker: SkillExecutionTracker;

  constructor(db: DatabaseSync, executionTracker: SkillExecutionTracker) {
    this.db = db;
    this.executionTracker = executionTracker;
  }

  /**
   * Detect successful execution patterns and crystallize them into new skill
   * crystals. Returns the count of new skills created.
   */
  crystallizePatterns(): number {
    const patterns = this.findSuccessfulPatterns();
    let created = 0;

    for (const pattern of patterns) {
      if (this.skillCrystalExists(pattern.skillCrystalId, pattern.toolName)) {
        continue;
      }

      if (this.createSkillCrystal(pattern)) {
        created++;
      }
    }

    if (created > 0) {
      log.debug(`crystallized ${created} new skill(s) from execution patterns`);
    }

    return created;
  }

  /**
   * Find execution patterns with ≥3 successes and >70% success rate.
   * Groups by the original skill crystal that was matched during execution tracking.
   */
  private findSuccessfulPatterns(): ExecutionPattern[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT
             se.skill_crystal_id,
             COUNT(*) as total,
             SUM(CASE WHEN se.success = 1 THEN 1 ELSE 0 END) as successes,
             c.skill_category
           FROM skill_executions se
           LEFT JOIN chunks c ON c.id = se.skill_crystal_id
           WHERE se.completed_at IS NOT NULL
           GROUP BY se.skill_crystal_id
           HAVING successes >= ? AND CAST(successes AS REAL) / COUNT(*) >= ?`,
        )
        .all(MIN_SUCCESSES, MIN_SUCCESS_RATE) as Array<{
        skill_crystal_id: string;
        total: number;
        successes: number;
        skill_category: string | null;
      }>;

      return rows.map((row) => ({
        skillCrystalId: row.skill_crystal_id,
        totalExecutions: row.total,
        successes: row.successes,
        successRate: row.successes / row.total,
        toolName: row.skill_category,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check if a frozen skill crystal already exists for this pattern.
   * Dedup by skill_crystal_id (already exists) or by tool name.
   */
  private skillCrystalExists(skillCrystalId: string, toolName: string | null): boolean {
    try {
      // Check if the source skill is already frozen (promoted)
      const existing = this.db
        .prepare(
          `SELECT id FROM chunks
           WHERE id = ?
             AND COALESCE(lifecycle, 'generated') = 'frozen'
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')`,
        )
        .get(skillCrystalId) as { id: string } | undefined;

      if (existing) {
        return true;
      }

      // Check if a crystallized version already exists from this parent
      if (toolName) {
        const byParent = this.db
          .prepare(
            `SELECT id FROM chunks
             WHERE parent_id = ?
               AND COALESCE(lifecycle, 'generated') = 'frozen'
               AND (COALESCE(memory_type, 'plaintext') = 'skill'
                    OR COALESCE(semantic_type, 'general') = 'skill')`,
          )
          .get(skillCrystalId) as { id: string } | undefined;

        if (byParent) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Create a new skill crystal from a successful execution pattern.
   */
  private createSkillCrystal(pattern: ExecutionPattern): boolean {
    const now = Date.now();
    const crystalId = crypto.randomUUID();
    const successPct = (pattern.successRate * 100).toFixed(0);

    // Get the original skill text to base the crystal on
    let originalText = "";
    try {
      const row = this.db
        .prepare(`SELECT text FROM chunks WHERE id = ?`)
        .get(pattern.skillCrystalId) as { text: string } | undefined;
      originalText = row?.text ?? "";
    } catch {
      /* empty */
    }

    const skillText = [
      `SKILL: ${pattern.toolName ?? "unknown"} (auto-crystallized)`,
      `TOOLS: ${pattern.toolName ?? "unknown"}`,
      `SUCCESS_RATE: ${successPct}%`,
      `EXECUTIONS: ${pattern.totalExecutions}`,
      `PATTERN: Consistently successful execution pattern detected from ${pattern.successes} successes over ${pattern.totalExecutions} attempts.`,
      originalText ? `\nBASED ON:\n${originalText.slice(0, 500)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Importance based on success rate × frequency (normalized)
    const frequencyFactor = Math.min(1, pattern.totalExecutions / 20);
    const importanceScore = pattern.successRate * 0.6 + frequencyFactor * 0.4;

    const governance = JSON.stringify({
      accessScope: "shared",
      lifespanPolicy: "permanent",
      priority: importanceScore,
      sensitivity: "normal",
      provenanceChain: [pattern.skillCrystalId],
    });

    try {
      this.db
        .prepare(
          `INSERT INTO chunks (
            id, path, source, start_line, end_line, hash, model, text, embedding,
            updated_at, importance_score, access_count, lifecycle_state, lifecycle,
            memory_type, semantic_type, origin, governance_json, created_at,
            version, parent_id, skill_category
          ) VALUES (
            ?, 'crystallizer/auto', 'skills', 0, 0, ?, 'crystallizer', ?, '[]',
            ?, ?, 0, 'active', 'generated',
            'skill', 'skill', 'inferred', ?, ?,
            1, ?, ?
          )`,
        )
        .run(
          crystalId,
          crypto.randomUUID(),
          skillText,
          now,
          importanceScore,
          governance,
          now,
          pattern.skillCrystalId,
          pattern.toolName,
        );

      // Audit log
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          crystalId,
          "skill_crystallized",
          now,
          "crystallizer",
          JSON.stringify({
            sourceId: pattern.skillCrystalId,
            successRate: pattern.successRate,
            totalExecutions: pattern.totalExecutions,
          }),
        );

      return true;
    } catch (err) {
      log.debug(`failed to crystallize pattern: ${String(err)}`);
      return false;
    }
  }
}
