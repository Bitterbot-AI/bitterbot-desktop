/**
 * SkillLifecycleStore: per-SKILL.md state for the procedural-memory curator.
 *
 * Tracks origin (who created the skill — agent dream cycle, user, P2P, etc.),
 * lifecycle state (active / stale / archived / pinned), aggregated usage and
 * error counts, and the last-used timestamp. Updated from two places:
 *
 *   1. `recordUsage()` is called by the execution pipeline whenever a skill
 *      crystal completes; it upserts the aggregate row for that skill.
 *   2. The skill-consolidation dream mode reads it via `list*()` selectors
 *      and writes back via `setState()` / `consolidateInto()`.
 *
 * The table is populated lazily — rows are created on first use. The v12
 * migration backfills from the existing `skill_executions` table so existing
 * installs do not start with an empty lifecycle log.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-lifecycle");

export type SkillOrigin = "agent_authored" | "managed" | "workspace" | "p2p" | "unknown";

export type SkillLifecycleState = "active" | "stale" | "archived" | "pinned";

export interface SkillLifecycleRow {
  skillName: string;
  origin: SkillOrigin;
  state: SkillLifecycleState;
  createdAt: number;
  lastUsedAt: number | null;
  usageCount: number;
  successCount: number;
  errorCount: number;
  consolidatedInto: string | null;
  pinned: boolean;
  updatedAt: number;
}

interface DbRow {
  skill_name: string;
  origin: string;
  state: string;
  created_at: number;
  last_used_at: number | null;
  usage_count: number;
  success_count: number;
  error_count: number;
  consolidated_into: string | null;
  pinned: number;
  updated_at: number;
}

const VALID_ORIGINS: ReadonlySet<SkillOrigin> = new Set([
  "agent_authored",
  "managed",
  "workspace",
  "p2p",
  "unknown",
]);

const VALID_STATES: ReadonlySet<SkillLifecycleState> = new Set([
  "active",
  "stale",
  "archived",
  "pinned",
]);

function rowToLifecycle(row: DbRow): SkillLifecycleRow {
  return {
    skillName: row.skill_name,
    origin: (VALID_ORIGINS.has(row.origin as SkillOrigin) ? row.origin : "unknown") as SkillOrigin,
    state: (VALID_STATES.has(row.state as SkillLifecycleState)
      ? row.state
      : "active") as SkillLifecycleState,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count,
    successCount: row.success_count,
    errorCount: row.error_count,
    consolidatedInto: row.consolidated_into,
    pinned: row.pinned === 1,
    updatedAt: row.updated_at,
  };
}

export class SkillLifecycleStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Upsert a lifecycle row from execution telemetry. Increments usage / success /
   * error counts and bumps `last_used_at`. If the row does not yet exist, it is
   * created with the supplied origin (or 'unknown' if omitted).
   *
   * Idempotent only with respect to the upsert mechanics — repeated calls
   * accumulate counts as intended.
   */
  recordUsage(params: {
    skillName: string;
    success: boolean;
    timestamp?: number;
    origin?: SkillOrigin;
  }): void {
    const skillName = params.skillName.trim();
    if (!skillName) {
      return;
    }
    const ts = params.timestamp ?? Date.now();
    const origin = params.origin ?? "unknown";
    const successDelta = params.success ? 1 : 0;
    const errorDelta = params.success ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO skill_lifecycle (
           skill_name, origin, state, created_at, last_used_at,
           usage_count, success_count, error_count, pinned, updated_at
         ) VALUES (?, ?, 'active', ?, ?, 1, ?, ?, 0, ?)
         ON CONFLICT(skill_name) DO UPDATE SET
           last_used_at = excluded.last_used_at,
           usage_count = usage_count + 1,
           success_count = success_count + ?,
           error_count = error_count + ?,
           updated_at = excluded.updated_at`,
      )
      .run(skillName, origin, ts, ts, successDelta, errorDelta, ts, successDelta, errorDelta);
  }

  /**
   * Create a row at skill-creation time. Sets origin authoritatively (does not
   * overwrite an existing row's origin — first writer wins, so a row backfilled
   * with origin='unknown' stays unknown unless explicitly upgraded via
   * `setOrigin`).
   */
  ensureRow(params: { skillName: string; origin: SkillOrigin; timestamp?: number }): void {
    const skillName = params.skillName.trim();
    if (!skillName) {
      return;
    }
    const ts = params.timestamp ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO skill_lifecycle (
           skill_name, origin, state, created_at, updated_at
         ) VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(skillName, params.origin, ts, ts);
  }

  /**
   * Overwrite the origin on an existing row. Use when promoting a backfilled
   * 'unknown' row to its real origin once the gateway has the information.
   */
  setOrigin(skillName: string, origin: SkillOrigin): void {
    const trimmed = skillName.trim();
    if (!trimmed) {
      return;
    }
    this.db
      .prepare(`UPDATE skill_lifecycle SET origin = ?, updated_at = ? WHERE skill_name = ?`)
      .run(origin, Date.now(), trimmed);
  }

  /**
   * Read one lifecycle row, or null if no row exists yet.
   */
  get(skillName: string): SkillLifecycleRow | null {
    const trimmed = skillName.trim();
    if (!trimmed) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT skill_name, origin, state, created_at, last_used_at,
                usage_count, success_count, error_count,
                consolidated_into, pinned, updated_at
         FROM skill_lifecycle WHERE skill_name = ?`,
      )
      .get(trimmed) as unknown as DbRow | undefined;
    return row ? rowToLifecycle(row) : null;
  }

  /**
   * List all rows, ordered by `last_used_at` desc, NULL-last.
   */
  listAll(): SkillLifecycleRow[] {
    const rows = this.db
      .prepare(
        `SELECT skill_name, origin, state, created_at, last_used_at,
                usage_count, success_count, error_count,
                consolidated_into, pinned, updated_at
         FROM skill_lifecycle
         ORDER BY last_used_at IS NULL, last_used_at DESC`,
      )
      .all() as unknown as DbRow[];
    return rows.map(rowToLifecycle);
  }

  /**
   * List rows matching a state predicate. Includes pinned skills only if the
   * caller explicitly asks for `state='pinned'` — by default, pinned skills are
   * filtered out of every other selector so the curator never touches them.
   */
  listByState(state: SkillLifecycleState): SkillLifecycleRow[] {
    const rows = (state === "pinned"
      ? this.db
          .prepare(
            `SELECT skill_name, origin, state, created_at, last_used_at,
                    usage_count, success_count, error_count,
                    consolidated_into, pinned, updated_at
             FROM skill_lifecycle WHERE pinned = 1
             ORDER BY last_used_at IS NULL, last_used_at DESC`,
          )
          .all()
      : this.db
          .prepare(
            `SELECT skill_name, origin, state, created_at, last_used_at,
                    usage_count, success_count, error_count,
                    consolidated_into, pinned, updated_at
             FROM skill_lifecycle WHERE state = ? AND pinned = 0
             ORDER BY last_used_at IS NULL, last_used_at DESC`,
          )
          .all(state)) as unknown as DbRow[];
    return rows.map(rowToLifecycle);
  }

  /**
   * List skills the curator should examine — `agent_authored` origin only,
   * not pinned, not already archived. The curator never touches user-authored
   * or P2P-imported skills; ownership stays with the human or the marketplace.
   */
  listCuratorCandidates(): SkillLifecycleRow[] {
    const rows = this.db
      .prepare(
        `SELECT skill_name, origin, state, created_at, last_used_at,
                usage_count, success_count, error_count,
                consolidated_into, pinned, updated_at
         FROM skill_lifecycle
         WHERE origin = 'agent_authored'
           AND pinned = 0
           AND state != 'archived'
         ORDER BY last_used_at IS NULL, last_used_at DESC`,
      )
      .all() as unknown as DbRow[];
    return rows.map(rowToLifecycle);
  }

  /**
   * Update the lifecycle state. Refuses to overwrite the `pinned` state via
   * this path — use `pin()`/`unpin()` for that.
   */
  setState(skillName: string, state: SkillLifecycleState): void {
    const trimmed = skillName.trim();
    if (!trimmed || state === "pinned") {
      return;
    }
    this.db
      .prepare(
        `UPDATE skill_lifecycle SET state = ?, updated_at = ?
         WHERE skill_name = ? AND pinned = 0`,
      )
      .run(state, Date.now(), trimmed);
  }

  /**
   * Mark a skill as consolidated into another. Sets state='archived' and
   * records the target skill name. The original SKILL.md may then be safely
   * archived to the version-archive directory by the caller.
   */
  consolidateInto(sourceName: string, targetName: string): void {
    const src = sourceName.trim();
    const tgt = targetName.trim();
    if (!src || !tgt || src === tgt) {
      return;
    }
    this.db
      .prepare(
        `UPDATE skill_lifecycle
         SET state = 'archived', consolidated_into = ?, updated_at = ?
         WHERE skill_name = ? AND pinned = 0`,
      )
      .run(tgt, Date.now(), src);
  }

  /**
   * Pin a skill so the curator never archives or consolidates it. User-driven.
   */
  pin(skillName: string): void {
    const trimmed = skillName.trim();
    if (!trimmed) {
      return;
    }
    this.db
      .prepare(`UPDATE skill_lifecycle SET pinned = 1, updated_at = ? WHERE skill_name = ?`)
      .run(Date.now(), trimmed);
  }

  unpin(skillName: string): void {
    const trimmed = skillName.trim();
    if (!trimmed) {
      return;
    }
    this.db
      .prepare(`UPDATE skill_lifecycle SET pinned = 0, updated_at = ? WHERE skill_name = ?`)
      .run(Date.now(), trimmed);
  }

  /**
   * Delete a lifecycle row. Used when the skill itself is deleted from disk
   * (not for archival — archived skills keep their row so the curator
   * remembers the decision).
   */
  forget(skillName: string): void {
    const trimmed = skillName.trim();
    if (!trimmed) {
      return;
    }
    const result = this.db.prepare(`DELETE FROM skill_lifecycle WHERE skill_name = ?`).run(trimmed);
    if ((result as { changes: number }).changes > 0) {
      log.debug(`forgot lifecycle row for ${trimmed}`);
    }
  }
}
