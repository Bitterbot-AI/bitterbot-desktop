/**
 * TaskMemoryManager: tracks goals and task progress across sessions.
 * Goals are stored as special crystals with semantic_type='goal' and
 * can be surfaced in system prompts for continuity.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/task-memory");

export type TaskGoal = {
  id: string;
  description: string;
  progress: number; // 0-1
  relatedCrystalIds: string[];
  sessionKey: string | null;
  status: "active" | "completed" | "stalled" | "abandoned";
  createdAt: number;
  updatedAt: number;
};

export class TaskMemoryManager {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_goals (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        progress REAL DEFAULT 0,
        related_crystal_ids TEXT DEFAULT '[]',
        session_key TEXT,
        status TEXT DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_task_goals_status ON task_goals(status);`);
  }

  /**
   * Register a new goal/task.
   */
  registerGoal(description: string, sessionKey?: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO task_goals (id, description, progress, related_crystal_ids, session_key, status, created_at, updated_at)
         VALUES (?, ?, 0, '[]', ?, 'active', ?, ?)`,
      )
      .run(id, description, sessionKey ?? null, now, now);

    log.debug("goal registered", { id, description: description.slice(0, 80) });
    return id;
  }

  /**
   * Update progress on a goal.
   */
  updateProgress(goalId: string, update: string, progress: number): void {
    const now = Date.now();
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const status = clampedProgress >= 1 ? "completed" : "active";

    this.db
      .prepare(`UPDATE task_goals SET progress = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(clampedProgress, status, now, goalId);
  }

  /**
   * Link a crystal to a goal.
   */
  linkCrystal(goalId: string, crystalId: string): void {
    const row = this.db
      .prepare(`SELECT related_crystal_ids FROM task_goals WHERE id = ?`)
      .get(goalId) as { related_crystal_ids: string } | undefined;

    if (!row) {
      return;
    }

    let ids: string[] = [];
    try {
      ids = JSON.parse(row.related_crystal_ids);
    } catch {}

    if (!ids.includes(crystalId)) {
      ids.push(crystalId);
      this.db
        .prepare(`UPDATE task_goals SET related_crystal_ids = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(ids), Date.now(), goalId);
    }
  }

  /**
   * Get active goals for session context.
   */
  getActiveGoals(): TaskGoal[] {
    const rows = this.db
      .prepare(
        `SELECT id, description, progress, related_crystal_ids, session_key, status, created_at, updated_at
         FROM task_goals
         WHERE status IN ('active', 'stalled')
         ORDER BY updated_at DESC
         LIMIT 20`,
      )
      .all() as Array<{
      id: string;
      description: string;
      progress: number;
      related_crystal_ids: string;
      session_key: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      description: r.description,
      progress: r.progress,
      relatedCrystalIds: (() => {
        try {
          return JSON.parse(r.related_crystal_ids);
        } catch {
          return [];
        }
      })(),
      sessionKey: r.session_key,
      status: r.status as TaskGoal["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Get all goals (including completed).
   */
  getAllGoals(): TaskGoal[] {
    const rows = this.db
      .prepare(
        `SELECT id, description, progress, related_crystal_ids, session_key, status, created_at, updated_at
         FROM task_goals
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all() as Array<{
      id: string;
      description: string;
      progress: number;
      related_crystal_ids: string;
      session_key: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      description: r.description,
      progress: r.progress,
      relatedCrystalIds: (() => {
        try {
          return JSON.parse(r.related_crystal_ids);
        } catch {
          return [];
        }
      })(),
      sessionKey: r.session_key,
      status: r.status as TaskGoal["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Auto-detect goals from conversation text.
   * Returns descriptions of detected goals.
   */
  detectGoals(text: string): string[] {
    const goals: string[] = [];
    const lower = text.toLowerCase();

    // Pattern: "I want to ...", "I need to ...", "My goal is ..."
    const goalPatterns = [
      /\b(?:i want to|i need to|i'd like to|i aim to|my goal is to|let's|we should)\s+(.{10,80}?)(?:\.|!|\?|$)/gi,
      /\b(?:plan to|intend to|going to|trying to)\s+(.{10,80}?)(?:\.|!|\?|$)/gi,
    ];

    for (const pattern of goalPatterns) {
      let match;
      while ((match = pattern.exec(lower)) !== null) {
        const description = match[1]?.trim();
        if (description && description.length >= 10) {
          goals.push(description);
        }
      }
    }

    return goals.slice(0, 5);
  }

  /**
   * Mark stalled goals (no progress update for a long time).
   */
  markStalledGoals(stalledAfterMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - stalledAfterMs;
    const result = this.db
      .prepare(
        `UPDATE task_goals SET status = 'stalled' WHERE status = 'active' AND updated_at < ?`,
      )
      .run(cutoff);
    return (result as { changes: number }).changes;
  }
}
