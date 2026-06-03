/**
 * PLAN-23 SABM Phase 5/6: relationship reconsolidation dream mode.
 *
 * This is the ONLY place destructive belief revision happens. The write path
 * only ever FLAGS a mutual contradiction (both edges stay active). Here, during
 * a calm dream cycle, each flagged contradiction is adjudicated and the losing
 * edge is closed via `supersedeRelationship` (sets valid_until) - but only
 * after a labile-window gate and a hormonal gate:
 *
 *   1. Labile gate: every evidence chunk backing the flagged edge must have
 *      exited its labile window (labile_until IS NULL OR <= now). If ANY
 *      backing chunk is still labile, the close is deferred to a later cycle
 *      (conservative ALL-closed rule). A flagged edge whose evidence chunks
 *      were pruned/forgotten (rows absent) is treated as non-labile so it is
 *      never stranded un-adjudicatable.
 *   2. Hormonal gate: a confidence floor modulated by effectiveDelta over
 *      cortisol/dopamine. High cortisol raises the bar (conservative under
 *      stress); high dopamine lowers it (more willing to revise). Social
 *      relations get extra protection (need a stronger signal to close).
 *
 * No write-path coupling: callers pass an `adjudicate` function (LLM-backed)
 * and the KnowledgeGraphManager. Pure orchestration otherwise.
 */

import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeGraphManager } from "../knowledge-graph.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream/relationship-reconsolidation");

/** Social relations need a stronger signal before a close (oxytocin protection). */
const SOCIAL_RELATIONS = new Set(["knows", "manages", "prefers", "works_on"]);

/** Base confidence a winner must clear before the loser is closed. */
const BASE_CLOSE_CONFIDENCE = 0.6;
const SOCIAL_PENALTY = 0.15;

export type HormonalLevels = { dopamine: number; cortisol: number; oxytocin: number };

/** LLM-backed (or test-injected) winner picker for a contradiction pair. */
export type AdjudicateFn = (input: {
  relationType: string;
  candidates: Array<{ relationshipId: string; targetName: string; weight: number }>;
}) => Promise<{ winnerRelationshipId: string; confidence: number } | null>;

export interface ReconsolidationDeps {
  db: DatabaseSync;
  kg: KnowledgeGraphManager;
  adjudicate: AdjudicateFn;
  hormones?: HormonalLevels | null;
  nowMs: number;
  /** Max contradictions to process per cycle. */
  maxItems?: number;
}

export interface ReconsolidationResult {
  flaggedSeen: number;
  deferredLabile: number;
  closed: number;
  llmCalls: number;
}

/** effectiveDelta mirror (structural-gate.ts:212): cortisol narrows, dopamine widens. */
function effectiveDelta(base: number, h?: HormonalLevels | null): number {
  if (!h) return base;
  const c = Math.max(0, Math.min(1, h.cortisol));
  const d = Math.max(0, Math.min(1, h.dopamine));
  return Math.max(0, Math.min(1, base - 0.4 * c + 0.4 * d));
}

type FlaggedRow = {
  relationship_id: string;
  evidence_chunk_ids: string;
};

type RelRow = {
  id: string;
  source_entity_id: string;
  relation_type: string;
  target_entity_id: string;
  weight: number;
  valid_until: number | null;
};

/**
 * Return true iff every backing evidence chunk has exited its labile window.
 * Pruned/forgotten chunks (no row) count as non-labile so the edge is never
 * stranded. An empty evidence list also counts as non-labile.
 */
function evidenceLabileWindowClosed(
  db: DatabaseSync,
  evidenceIds: string[],
  nowMs: number,
): boolean {
  for (const cid of evidenceIds) {
    const row = db.prepare(`SELECT labile_until FROM chunks WHERE id = ?`).get(cid) as
      | { labile_until: number | null }
      | undefined;
    if (row && row.labile_until != null && row.labile_until > nowMs) {
      return false; // still labile -> defer
    }
  }
  return true;
}

export async function runRelationshipReconsolidation(
  deps: ReconsolidationDeps,
): Promise<ReconsolidationResult> {
  const { db, kg, adjudicate, hormones, nowMs } = deps;
  const maxItems = deps.maxItems ?? 50;
  const result: ReconsolidationResult = {
    flaggedSeen: 0,
    deferredLabile: 0,
    closed: 0,
    llmCalls: 0,
  };

  let flagged: FlaggedRow[];
  try {
    flagged = db
      .prepare(
        `SELECT relationship_id, evidence_chunk_ids
         FROM relationship_belief_history
         WHERE action = 'flag_contradiction'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(maxItems) as FlaggedRow[];
  } catch {
    // Pre-v16 DB: nothing to do.
    return result;
  }

  for (const f of flagged) {
    result.flaggedSeen++;

    // The flagged (newer) edge; skip if it was already closed by a prior cycle.
    const flaggedRel = db
      .prepare(
        `SELECT id, source_entity_id, relation_type, target_entity_id, weight, valid_until
         FROM relationships WHERE id = ?`,
      )
      .get(f.relationship_id) as RelRow | undefined;
    if (!flaggedRel || flaggedRel.valid_until != null) {
      continue;
    }

    const evidenceIds: string[] = (() => {
      try {
        return JSON.parse(f.evidence_chunk_ids || "[]") as string[];
      } catch {
        return [];
      }
    })();
    if (!evidenceLabileWindowClosed(db, evidenceIds, nowMs)) {
      result.deferredLabile++;
      continue;
    }

    // Sibling active edges of the same source + type (the contradiction set).
    const siblings = db
      .prepare(
        `SELECT r.id, r.source_entity_id, r.relation_type, r.target_entity_id, r.weight, r.valid_until,
                e.name as target_name
         FROM relationships r JOIN entities e ON e.id = r.target_entity_id
         WHERE r.source_entity_id = ? AND r.relation_type = ? AND r.valid_until IS NULL`,
      )
      .all(flaggedRel.source_entity_id, flaggedRel.relation_type) as Array<
      RelRow & { target_name: string }
    >;
    if (siblings.length < 2) {
      continue; // contradiction already resolved
    }

    const verdict = await adjudicate({
      relationType: flaggedRel.relation_type,
      candidates: siblings.map((s) => ({
        relationshipId: s.id,
        targetName: s.target_name,
        weight: s.weight,
      })),
    });
    result.llmCalls++;
    if (!verdict) {
      continue;
    }

    // Hormonal gate: cortisol raises the close bar, dopamine lowers it; social
    // relations are extra-protected.
    let floor = BASE_CLOSE_CONFIDENCE;
    if (SOCIAL_RELATIONS.has(flaggedRel.relation_type)) {
      floor += SOCIAL_PENALTY;
    }
    // effectiveDelta widens/narrows the *willingness*; invert into the floor so
    // high cortisol => higher floor (less likely to close).
    const willingness = effectiveDelta(0.5, hormones); // 0.5 baseline
    const modulatedFloor = Math.max(0, Math.min(1, floor + (0.5 - willingness)));

    if (verdict.confidence < modulatedFloor) {
      log.debug("reconsolidation deferred: confidence below hormonal floor", {
        rel: flaggedRel.relation_type,
        confidence: verdict.confidence.toFixed(2),
        floor: modulatedFloor.toFixed(2),
      });
      continue;
    }

    // Close every sibling that is not the winner (the irreversible step).
    for (const s of siblings) {
      if (s.id !== verdict.winnerRelationshipId) {
        kg.supersedeRelationship(s.id);
        result.closed++;
      }
    }
  }

  if (result.closed > 0 || result.deferredLabile > 0) {
    log.info(
      `relationship reconsolidation: seen=${result.flaggedSeen} closed=${result.closed} deferred=${result.deferredLabile} llm=${result.llmCalls}`,
    );
  }
  return result;
}
