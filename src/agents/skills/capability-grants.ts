/**
 * PLAN-13 Phase B: persistent operator decisions on per-skill capability requests.
 *
 * Grants are keyed on the skill's content hash (not its name) because a name
 * is reusable across versions. If a publisher swaps a skill body for one that
 * declares broader capabilities, the new content hash forces a fresh consent
 * prompt rather than silently inheriting the previous decision.
 *
 * Scope JSON is opaque to this module. Callers (the profile resolver) own
 * the schema and just round-trip it as-is.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skills/capability-grants");

export type CapabilityAxis = "network" | "fs" | "wallet" | "shell" | "process";
export type GrantDecision = "allow" | "deny";

export type CapabilityGrant = {
  contentHash: string;
  capability: CapabilityAxis;
  decision: GrantDecision;
  /** Optional axis-specific scope (e.g. allowed hosts for network). */
  scope?: Record<string, unknown>;
  grantedAt: number;
  grantedBy?: string;
};

export class CapabilityGrantsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Look up a single grant. Returns null if no decision has been recorded.
   */
  get(contentHash: string, capability: CapabilityAxis): CapabilityGrant | null {
    try {
      const row = this.db
        .prepare(
          `SELECT content_hash, capability, decision, scope_json, granted_at, granted_by
           FROM skill_capability_grants
           WHERE content_hash = ? AND capability = ?`,
        )
        .get(contentHash, capability) as
        | {
            content_hash: string;
            capability: string;
            decision: string;
            scope_json: string;
            granted_at: number;
            granted_by: string | null;
          }
        | undefined;
      if (!row) return null;
      return rowToGrant(row);
    } catch (err) {
      log.debug(`grant lookup failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Record an operator decision. UPSERT semantics: re-running with the same
   * (hash, capability) overwrites the previous decision and updates the
   * timestamp. Use this for both "allow once" and "allow always" — the
   * caller owns the policy of when to call this.
   */
  set(input: {
    contentHash: string;
    capability: CapabilityAxis;
    decision: GrantDecision;
    scope?: Record<string, unknown>;
    grantedBy?: string;
  }): void {
    const scopeJson = JSON.stringify(input.scope ?? {});
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO skill_capability_grants
            (content_hash, capability, decision, scope_json, granted_at, granted_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(content_hash, capability) DO UPDATE SET
              decision = excluded.decision,
              scope_json = excluded.scope_json,
              granted_at = excluded.granted_at,
              granted_by = excluded.granted_by`,
        )
        .run(
          input.contentHash,
          input.capability,
          input.decision,
          scopeJson,
          now,
          input.grantedBy ?? null,
        );
    } catch (err) {
      log.warn(`grant write failed: ${String(err)}`);
    }
  }

  /**
   * List every recorded decision for a skill. Used by the review UX to
   * show "this skill currently has these capabilities granted."
   */
  listForSkill(contentHash: string): CapabilityGrant[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT content_hash, capability, decision, scope_json, granted_at, granted_by
           FROM skill_capability_grants
           WHERE content_hash = ?
           ORDER BY granted_at DESC`,
        )
        .all(contentHash) as Array<{
        content_hash: string;
        capability: string;
        decision: string;
        scope_json: string;
        granted_at: number;
        granted_by: string | null;
      }>;
      return rows.map(rowToGrant);
    } catch (err) {
      log.debug(`grant list failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Drop a single grant. Used when an operator revokes consent or when a
   * skill is removed from the active set.
   */
  delete(contentHash: string, capability: CapabilityAxis): void {
    try {
      this.db
        .prepare(`DELETE FROM skill_capability_grants WHERE content_hash = ? AND capability = ?`)
        .run(contentHash, capability);
    } catch (err) {
      log.debug(`grant delete failed: ${String(err)}`);
    }
  }

  /**
   * Drop all grants for a skill. Called when a skill is removed from the
   * filesystem; we don't keep grants for skills that aren't installed.
   */
  deleteAllForSkill(contentHash: string): void {
    try {
      this.db
        .prepare(`DELETE FROM skill_capability_grants WHERE content_hash = ?`)
        .run(contentHash);
    } catch (err) {
      log.debug(`grant deleteAll failed: ${String(err)}`);
    }
  }
}

function rowToGrant(row: {
  content_hash: string;
  capability: string;
  decision: string;
  scope_json: string;
  granted_at: number;
  granted_by: string | null;
}): CapabilityGrant {
  let scope: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.scope_json) as Record<string, unknown>;
    if (parsed && Object.keys(parsed).length > 0) {
      scope = parsed;
    }
  } catch {
    // Malformed scope JSON; treat as no scope.
  }
  return {
    contentHash: row.content_hash,
    capability: row.capability as CapabilityAxis,
    decision: row.decision as GrantDecision,
    scope,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by ?? undefined,
  };
}
