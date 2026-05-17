/**
 * PLAN-18 Phase 4 — writer-reader coupling.
 *
 * Detects retrieval failures from the SAGE graph reader and emits
 * `graph_bridge` curiosity targets. The next session's extractor sees
 * these as epistemic directives nudging it to capture richer triples
 * around the entities that were *near* the answer chunk but didn't
 * reach it.
 *
 * The detection rule is simple: an agent turn references a chunk that
 * the most recent graph read did NOT surface in its top-K, but the
 * vector or keyword channel did. That means the chunk was reachable
 * in content-space but not in graph-space — a missing bridge edge.
 *
 * This module does NOT depend on the curiosity engine internals; it
 * just inserts rows into `curiosity_targets`. The engine picks them up
 * on its next pass.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/graph-bridge-target");

export type GraphGapSignal = {
  query: string;
  /** The chunk the agent ultimately cited / used. */
  missedChunkId: string;
  /** Entities that *were* activated by the graph reader (the nearest miss). */
  nearestActivatedEntityIds: string[];
  /** Entities the missed chunk anchors on (if known). */
  truthEntityIds: string[];
  /** Wall-clock origin of the signal. Defaults to now. */
  detectedAt?: number;
};

export type GraphBridgeTargetMetadata = {
  source: "graph_bridge";
  query: string;
  missedChunkId: string;
  nearestActivatedEntityIds: string[];
  truthEntityIds: string[];
  /** Free-form natural-language nudge for downstream extraction prompts. */
  nudge: string;
};

const DEFAULT_TTL_DAYS = 14;

function buildNudge(truthEntities: string[], nearestEntities: string[]): string {
  if (truthEntities.length === 0 || nearestEntities.length === 0) {
    return "When extracting entities and relations from this session, prefer explicit triples over implicit references.";
  }
  const truthSample = truthEntities.slice(0, 3).join(", ");
  const nearSample = nearestEntities.slice(0, 3).join(", ");
  return (
    `Recent retrieval missed a bridge: when ${nearSample} appear near ${truthSample}, ` +
    `capture the relationship explicitly (use a typed relation, not just co-occurrence).`
  );
}

/**
 * Persist a single graph_bridge curiosity target. Idempotent on
 * (query, missedChunkId) — repeated signals reinforce priority instead
 * of creating duplicates.
 */
export function emitGraphBridgeSignal(
  db: DatabaseSync,
  signal: GraphGapSignal,
  opts: { ttlDays?: number; priority?: number } = {},
): { targetId: string; reinforced: boolean } {
  const now = signal.detectedAt ?? Date.now();
  const ttlMs = (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const expiresAt = now + ttlMs;
  const truthEntities = signal.truthEntityIds.slice(0, 8);
  const nearestEntities = signal.nearestActivatedEntityIds.slice(0, 8);
  const nudge = buildNudge(truthEntities, nearestEntities);
  const metadata: GraphBridgeTargetMetadata = {
    source: "graph_bridge",
    query: signal.query,
    missedChunkId: signal.missedChunkId,
    nearestActivatedEntityIds: nearestEntities,
    truthEntityIds: truthEntities,
    nudge,
  };
  const description = `Graph bridge missing for query "${signal.query.slice(0, 80)}"`;

  // Look for an existing unresolved target with the same query + missed chunk.
  try {
    const existing = db
      .prepare(
        `SELECT id, priority, metadata FROM curiosity_targets
         WHERE type = 'graph_bridge' AND resolved_at IS NULL
           AND description = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(description) as { id: string; priority: number; metadata: string } | undefined;
    if (existing) {
      const nextPriority = Math.min(1, Math.max(existing.priority, opts.priority ?? 0.5) + 0.1);
      db.prepare(
        `UPDATE curiosity_targets
         SET priority = ?, metadata = ?, expires_at = ? WHERE id = ?`,
      ).run(nextPriority, JSON.stringify(metadata), expiresAt, existing.id);
      return { targetId: existing.id, reinforced: true };
    }
  } catch (err) {
    log.debug(`graph_bridge dedup lookup failed: ${String(err)}`);
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO curiosity_targets
         (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
       VALUES (?, 'graph_bridge', ?, ?, NULL, ?, ?, NULL, ?)`,
    ).run(id, description, opts.priority ?? 0.5, JSON.stringify(metadata), now, expiresAt);
  } catch (err) {
    log.debug(`emitGraphBridgeSignal insert failed: ${String(err)}`);
    return { targetId: id, reinforced: false };
  }
  return { targetId: id, reinforced: false };
}

/**
 * Diff a graph-reader result against a known list of chunks the agent
 * actually used in its turn. Returns the signals that should fire.
 */
export function detectGraphGaps(input: {
  query: string;
  usedChunkIds: string[];
  graphReaderChunkIds: string[];
  vectorOrKeywordChunkIds: string[];
  graphReaderEntityIds: string[];
}): GraphGapSignal[] {
  const grSet = new Set(input.graphReaderChunkIds);
  const otherSet = new Set(input.vectorOrKeywordChunkIds);
  const signals: GraphGapSignal[] = [];
  for (const cid of input.usedChunkIds) {
    if (!grSet.has(cid) && otherSet.has(cid)) {
      signals.push({
        query: input.query,
        missedChunkId: cid,
        nearestActivatedEntityIds: input.graphReaderEntityIds,
        truthEntityIds: [],
      });
    }
  }
  return signals;
}

/**
 * Fetch active graph_bridge targets so the session extractor can fold
 * them into its prompt. Caller decides how many to surface.
 */
export function readActiveBridgeTargets(db: DatabaseSync, limit = 5): GraphBridgeTargetMetadata[] {
  try {
    const rows = db
      .prepare(
        `SELECT metadata FROM curiosity_targets
         WHERE type = 'graph_bridge' AND resolved_at IS NULL
         ORDER BY priority DESC, created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ metadata: string }>;
    const out: GraphBridgeTargetMetadata[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.metadata) as Record<string, unknown>;
        if (parsed.source === "graph_bridge" && typeof parsed.query === "string") {
          out.push(parsed as unknown as GraphBridgeTargetMetadata);
        }
      } catch {
        // ignore malformed metadata rows
      }
    }
    return out;
  } catch (err) {
    log.debug(`readActiveBridgeTargets failed: ${String(err)}`);
    return [];
  }
}
