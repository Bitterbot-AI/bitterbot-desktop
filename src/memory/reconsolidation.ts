/**
 * Memory Reconsolidation: when a consolidated memory is recalled, it enters
 * a temporary "labile" state where it can be updated, strengthened, or flagged
 * for review. After the labile window closes, the memory restabilizes.
 *
 * FIRST IMPLEMENTATION in any agent memory system.
 *
 * Scientific basis:
 * - Nader, Schafe & LeDoux (2000) — fear memories require protein synthesis
 *   for reconsolidation after recall.
 * - Reconsolidation window: ~30 minutes in biology, configurable here.
 *
 * PLAN-9: GAP-5 (Memory Reconsolidation)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/reconsolidation");

export interface ReconsolidationConfig {
  enabled: boolean;
  /** Labile window duration in ms (default: 30 minutes) */
  labileWindowMs: number;
  /** Importance boost for simply being recalled (restabilization strengthening) */
  recallBoost: number;
  /** Importance boost when user confirms/uses the memory */
  confirmationBoost: number;
  /** Minimum importance to be eligible for reconsolidation */
  minImportance: number;
}

export const DEFAULT_RECONSOLIDATION_CONFIG: ReconsolidationConfig = {
  enabled: true,
  labileWindowMs: 30 * 60 * 1000, // 30 minutes
  recallBoost: 0.02,
  confirmationBoost: 0.05,
  minImportance: 0.1,
};

export type ReconsolidationAction = "update" | "strengthen" | "flag_contradiction" | "restabilize";

export interface LabileChunk {
  chunkId: string;
  labileUntil: number;
  originalImportance: number;
}

export class ReconsolidationEngine {
  private readonly db: DatabaseSync;
  private readonly config: ReconsolidationConfig;

  constructor(db: DatabaseSync, config?: Partial<ReconsolidationConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_RECONSOLIDATION_CONFIG, ...config };
  }

  /**
   * Mark a retrieved chunk as labile. Called when a memory is retrieved
   * during search. The chunk enters a window where it can be updated.
   */
  markLabile(chunkId: string): boolean {
    if (!this.config.enabled) return false;

    const now = Date.now();
    const labileUntil = now + this.config.labileWindowMs;

    try {
      // Only mark if chunk exists and has sufficient importance
      const chunk = this.db
        .prepare(
          `SELECT id, importance_score, labile_until FROM chunks WHERE id = ? AND importance_score >= ?`,
        )
        .get(chunkId, this.config.minImportance) as
        | { id: string; importance_score: number; labile_until: number | null }
        | undefined;

      if (!chunk) return false;

      // Already labile? Extend the window
      if (chunk.labile_until && chunk.labile_until > now) {
        this.db
          .prepare(`UPDATE chunks SET labile_until = ? WHERE id = ?`)
          .run(labileUntil, chunkId);
        return true;
      }

      this.db
        .prepare(`UPDATE chunks SET labile_until = ? WHERE id = ?`)
        .run(labileUntil, chunkId);

      log.debug("chunk marked labile", { chunkId: chunkId.slice(0, 8), labileUntil });
      return true;
    } catch (err) {
      log.debug(`markLabile failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Check if a chunk is currently in a labile state.
   */
  isLabile(chunkId: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT labile_until FROM chunks WHERE id = ?`)
        .get(chunkId) as { labile_until: number | null } | undefined;
      return !!row?.labile_until && row.labile_until > Date.now();
    } catch {
      return false;
    }
  }

  /**
   * Get all currently labile chunks.
   */
  getLabileChunks(): LabileChunk[] {
    try {
      const now = Date.now();
      const rows = this.db
        .prepare(
          `SELECT id, labile_until, importance_score FROM chunks
           WHERE labile_until IS NOT NULL AND labile_until > ?`,
        )
        .all(now) as Array<{ id: string; labile_until: number; importance_score: number }>;

      return rows.map((r) => ({
        chunkId: r.id,
        labileUntil: r.labile_until,
        originalImportance: r.importance_score,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Strengthen a labile memory — the user confirmed or used the information.
   * Applies a larger importance boost than passive restabilization.
   */
  strengthen(chunkId: string): boolean {
    if (!this.isLabile(chunkId)) return false;

    try {
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE chunks SET
             importance_score = MIN(1.0, importance_score + ?),
             reconsolidation_count = COALESCE(reconsolidation_count, 0) + 1,
             labile_until = NULL,
             last_accessed_at = ?
           WHERE id = ?`,
        )
        .run(this.config.confirmationBoost, now, chunkId);

      this.auditLog(chunkId, "reconsolidation_strengthen");
      log.debug("chunk strengthened via reconsolidation", { chunkId: chunkId.slice(0, 8) });
      return true;
    } catch (err) {
      log.debug(`strengthen failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Flag a labile memory for contradiction review. The user provided info
   * that conflicts with the recalled memory. Will be reviewed in next dream cycle.
   */
  flagContradiction(chunkId: string, contradictingInfo: string): boolean {
    if (!this.isLabile(chunkId)) return false;

    try {
      this.db
        .prepare(
          `UPDATE chunks SET
             labile_until = NULL,
             open_loop = 1,
             open_loop_context = ?
           WHERE id = ?`,
        )
        .run(`CONTRADICTION: ${contradictingInfo.slice(0, 500)}`, chunkId);

      this.auditLog(chunkId, "reconsolidation_contradiction", { contradictingInfo: contradictingInfo.slice(0, 200) });
      log.debug("chunk flagged for contradiction review", { chunkId: chunkId.slice(0, 8) });
      return true;
    } catch (err) {
      log.debug(`flagContradiction failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Process expired labile windows: restabilize with a mild importance boost.
   * Called during consolidation cycles.
   */
  restabilizeExpired(): number {
    const now = Date.now();
    try {
      const result = this.db
        .prepare(
          `UPDATE chunks SET
             importance_score = MIN(1.0, importance_score + ?),
             reconsolidation_count = COALESCE(reconsolidation_count, 0) + 1,
             labile_until = NULL
           WHERE labile_until IS NOT NULL AND labile_until <= ?`,
        )
        .run(this.config.recallBoost, now);

      const count = (result as { changes: number }).changes;
      if (count > 0) {
        log.debug(`restabilized ${count} expired labile chunks`);
      }
      return count;
    } catch (err) {
      log.debug(`restabilizeExpired failed: ${String(err)}`);
      return 0;
    }
  }

  private auditLog(chunkId: string, event: string, metadata?: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, 'reconsolidation', ?)`,
        )
        .run(crypto.randomUUID(), chunkId, event, Date.now(), JSON.stringify(metadata ?? {}));
    } catch {}
  }
}
