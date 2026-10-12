/**
 * PLAN-55 Phase 2: "bring back" is a full undo.
 *
 * The preference and graph consumers remove things: a preference row on the
 * owner's retire (or when the new value is one the owner suppressed), graph
 * edges closed by a supersede or retire, replacement edges added. Each such
 * change is recorded in `canonical_propagation_undo` keyed by (fact key, the
 * value that stopped being current). When that value becomes current again
 * (unretire, a pin back to it), restoreForValue() runs before the consumers:
 * the preference row comes back (unless the owner suppressed it since), the
 * closed edges reopen (unless an equal edge is open already) and the
 * replacement edges close. Each record is applied once (undone_at).
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { KnowledgeGraphManager } from "./knowledge-graph.js";
import {
  isSuppressed,
  normalizeExact,
  preferenceKeyHash,
  preferenceValueHash,
} from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

export type UndoKind = "preference_row" | "edge_closed" | "edge_added";

export type PreferenceRowPayload = {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number | null;
  evidence_ids: string | null;
  created_at: number;
  updated_at: number;
};

export function recordUndo(
  db: DatabaseSync,
  factKey: string,
  value: string,
  kind: UndoKind,
  payload: unknown,
): void {
  try {
    db.prepare(
      `INSERT INTO canonical_propagation_undo (fact_key, value, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(factKey, normalizeExact(value), kind, JSON.stringify(payload), Date.now());
  } catch (err) {
    log.debug(`undo record skipped: ${String(err)}`);
  }
}

export type RestoreResult = { preferences: number; edgesReopened: number; edgesClosed: number };

/** Undo what the consumers removed for (key, value), now that value is current again. */
export function restoreForValue(
  db: DatabaseSync,
  kg: KnowledgeGraphManager | null,
  factKey: string,
  value: string,
): RestoreResult {
  const result: RestoreResult = { preferences: 0, edgesReopened: 0, edgesClosed: 0 };
  let rows: Array<{ id: number; kind: UndoKind; payload: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, kind, payload FROM canonical_propagation_undo
          WHERE fact_key = ? AND value = ? AND undone_at IS NULL
          ORDER BY id DESC LIMIT 100`,
      )
      .all(factKey, normalizeExact(value)) as unknown as typeof rows;
  } catch {
    return result;
  }
  const done = db.prepare(`UPDATE canonical_propagation_undo SET undone_at = ? WHERE id = ?`);
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (row.kind === "preference_row") {
        result.preferences += restorePreference(db, payload as PreferenceRowPayload);
      } else if (row.kind === "edge_closed") {
        result.edgesReopened += reopenEdge(db, String(payload.id));
      } else if (row.kind === "edge_added" && kg) {
        result.edgesClosed += closeEdge(db, kg, String(payload.id));
      }
      done.run(Date.now(), row.id);
    } catch (err) {
      log.debug(`undo ${row.kind} #${row.id} failed: ${String(err)}`);
    }
  }
  if (result.preferences + result.edgesReopened + result.edgesClosed > 0) {
    log.info(
      `canonical:changed [${factKey}] restored ${result.preferences} preference(s), ` +
        `reopened ${result.edgesReopened} and closed ${result.edgesClosed} graph edge(s)`,
    );
  }
  return result;
}

function restorePreference(db: DatabaseSync, row: PreferenceRowPayload): number {
  if (
    isSuppressed(db, "preference_key", preferenceKeyHash(row.category, row.key)) ||
    isSuppressed(db, "preference_value", preferenceValueHash(row.category, row.value))
  ) {
    return 0;
  }
  const existing = db
    .prepare(`SELECT value FROM user_preferences WHERE category = ? AND key = ?`)
    .get(row.category, row.key) as { value: string } | undefined;
  if (existing) {
    if (normalizeExact(existing.value) === normalizeExact(row.value)) {
      return 0;
    }
    return Number(
      db
        .prepare(
          `UPDATE user_preferences SET value = ?, updated_at = ? WHERE category = ? AND key = ?`,
        )
        .run(row.value, Date.now(), row.category, row.key).changes,
    );
  }
  return Number(
    db
      .prepare(
        `INSERT INTO user_preferences
           (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.category,
        row.key,
        row.value,
        row.confidence ?? 0.5,
        row.evidence_ids ?? "[]",
        row.created_at,
        Date.now(),
      ).changes,
  );
}

function reopenEdge(db: DatabaseSync, id: string): number {
  const edge = db
    .prepare(
      `SELECT source_entity_id AS s, target_entity_id AS t, relation_type AS r, valid_until
         FROM relationships WHERE id = ?`,
    )
    .get(id) as { s: string; t: string; r: string; valid_until: number | null } | undefined;
  if (!edge || edge.valid_until === null) {
    return 0;
  }
  const open = db
    .prepare(
      `SELECT 1 FROM relationships WHERE source_entity_id = ? AND target_entity_id = ?
          AND relation_type = ? AND valid_until IS NULL LIMIT 1`,
    )
    .get(edge.s, edge.t, edge.r);
  if (open) {
    return 0;
  }
  return Number(
    db
      .prepare(`UPDATE relationships SET valid_until = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id).changes,
  );
}

function closeEdge(db: DatabaseSync, kg: KnowledgeGraphManager, id: string): number {
  const edge = db.prepare(`SELECT valid_until FROM relationships WHERE id = ?`).get(id) as
    | { valid_until: number | null }
    | undefined;
  if (!edge || edge.valid_until !== null) {
    return 0;
  }
  kg.supersedeRelationship(id);
  return 1;
}
