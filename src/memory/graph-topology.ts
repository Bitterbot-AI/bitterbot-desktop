/**
 * PLAN-18 Phase 3 — per-edge topological features.
 *
 * Computes the 8-feature vector z_{uv} that the structural gate's MLP
 * consumes. Features follow SAGE Section 4.2:
 *   [ deg(u), deg(v), |deg(u)-deg(v)|, jaccard(N(u),N(v)),
 *     commonNeighbors, mentionCount(u), mentionCount(v), recency ]
 *
 * All features are normalized into roughly [0, 1] before storage so the
 * MLP doesn't need to learn per-feature scaling.
 *
 * Stored compactly as 8×Float32 = 32 bytes per relationship in the
 * `relationships.gate_features` BLOB column (added in migration v13).
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/graph-topology");

export const TOPOLOGY_FEATURE_COUNT = 8;
export const TOPOLOGY_FEATURE_BYTES = TOPOLOGY_FEATURE_COUNT * 4; // Float32

export type TopologyFeatures = Float32Array;

/** Pack a feature vector into a Uint8Array suitable for SQLite BLOB storage. */
export function packFeatures(features: TopologyFeatures): Uint8Array {
  if (features.length !== TOPOLOGY_FEATURE_COUNT) {
    throw new Error(`expected ${TOPOLOGY_FEATURE_COUNT} features, got ${features.length}`);
  }
  return new Uint8Array(features.buffer, features.byteOffset, features.byteLength);
}

/** Unpack a feature BLOB from SQLite. Returns null on size mismatch. */
export function unpackFeatures(blob: Uint8Array | null | undefined): TopologyFeatures | null {
  if (!blob || blob.byteLength !== TOPOLOGY_FEATURE_BYTES) {
    return null;
  }
  // Copy into an aligned buffer to avoid alignment pitfalls.
  const copy = new ArrayBuffer(TOPOLOGY_FEATURE_BYTES);
  new Uint8Array(copy).set(blob);
  return new Float32Array(copy);
}

/** Squash an unbounded count into [0, 1] with a log scale + sigmoid. */
function squashCount(n: number): number {
  if (n <= 0) {
    return 0;
  }
  return 1 - 1 / (1 + Math.log1p(n));
}

/** Map recency-in-days into [0, 1] with a slow decay (≈half-life 30d). */
function squashRecencyDays(days: number): number {
  if (!Number.isFinite(days) || days < 0) {
    return 0.5;
  }
  return Math.exp(-Math.log(2) * (days / 30));
}

type DegreeRow = { eid: string; deg: number };
type NeighborRow = { eid: string; nid: string };
type EntityMetaRow = { id: string; mention_count: number };

function getDegrees(db: DatabaseSync, entityIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (entityIds.length === 0) {
    return out;
  }
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT eid, SUM(d) AS deg FROM (
         SELECT source_entity_id AS eid, COUNT(*) AS d FROM relationships
           WHERE valid_until IS NULL AND source_entity_id IN (${placeholders})
           GROUP BY source_entity_id
         UNION ALL
         SELECT target_entity_id AS eid, COUNT(*) AS d FROM relationships
           WHERE valid_until IS NULL AND target_entity_id IN (${placeholders})
           GROUP BY target_entity_id
       ) GROUP BY eid`,
    )
    .all(...entityIds, ...entityIds) as unknown as DegreeRow[];
  for (const r of rows) {
    out.set(r.eid, r.deg);
  }
  for (const id of entityIds) {
    if (!out.has(id)) {
      out.set(id, 0);
    }
  }
  return out;
}

function getNeighborSets(db: DatabaseSync, entityIds: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (entityIds.length === 0) {
    return out;
  }
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT eid, nid FROM (
         SELECT source_entity_id AS eid, target_entity_id AS nid FROM relationships
           WHERE valid_until IS NULL AND source_entity_id IN (${placeholders})
         UNION
         SELECT target_entity_id AS eid, source_entity_id AS nid FROM relationships
           WHERE valid_until IS NULL AND target_entity_id IN (${placeholders})
       )`,
    )
    .all(...entityIds, ...entityIds) as unknown as NeighborRow[];
  for (const r of rows) {
    let set = out.get(r.eid);
    if (!set) {
      set = new Set<string>();
      out.set(r.eid, set);
    }
    set.add(r.nid);
  }
  for (const id of entityIds) {
    if (!out.has(id)) {
      out.set(id, new Set<string>());
    }
  }
  return out;
}

function getEntityMentions(db: DatabaseSync, entityIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (entityIds.length === 0) {
    return out;
  }
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, mention_count FROM entities WHERE id IN (${placeholders})`)
    .all(...entityIds) as unknown as EntityMetaRow[];
  for (const r of rows) {
    out.set(r.id, r.mention_count);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function countCommon(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter;
}

/**
 * Compute features for one edge given precomputed neighborhood data.
 * Inputs are already normalized; returned vector is the 8-feature MLP input.
 */
export function computeEdgeFeatures(input: {
  sourceDegree: number;
  targetDegree: number;
  sourceNeighbors: Set<string>;
  targetNeighbors: Set<string>;
  sourceMentions: number;
  targetMentions: number;
  ageDays: number;
}): TopologyFeatures {
  const features = new Float32Array(TOPOLOGY_FEATURE_COUNT);
  features[0] = squashCount(input.sourceDegree);
  features[1] = squashCount(input.targetDegree);
  features[2] = squashCount(Math.abs(input.sourceDegree - input.targetDegree));
  features[3] = jaccard(input.sourceNeighbors, input.targetNeighbors);
  features[4] = squashCount(countCommon(input.sourceNeighbors, input.targetNeighbors));
  features[5] = squashCount(input.sourceMentions);
  features[6] = squashCount(input.targetMentions);
  features[7] = squashRecencyDays(input.ageDays);
  return features;
}

type RelRow = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  updated_at: number;
};

/**
 * Recompute and persist gate_features for the given set of relationship IDs.
 * If no IDs are provided, recomputes for ALL active relationships.
 * Returns the number of edges updated.
 */
export function recomputeFeaturesForRelationships(
  db: DatabaseSync,
  relationshipIds: string[] | null = null,
): number {
  let rows: RelRow[];
  if (relationshipIds && relationshipIds.length > 0) {
    const placeholders = relationshipIds.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, updated_at
         FROM relationships WHERE id IN (${placeholders})`,
      )
      .all(...relationshipIds) as unknown as RelRow[];
  } else {
    rows = db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, updated_at
         FROM relationships WHERE valid_until IS NULL`,
      )
      .all() as unknown as RelRow[];
  }

  if (rows.length === 0) {
    return 0;
  }

  const allEntityIds = new Set<string>();
  for (const r of rows) {
    allEntityIds.add(r.source_entity_id);
    allEntityIds.add(r.target_entity_id);
  }
  const allIds = [...allEntityIds];

  const degrees = getDegrees(db, allIds);
  const neighbors = getNeighborSets(db, allIds);
  const mentions = getEntityMentions(db, allIds);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const update = db.prepare(`UPDATE relationships SET gate_features = ? WHERE id = ?`);
  let updated = 0;

  try {
    db.exec("BEGIN");
    for (const r of rows) {
      const sn = neighbors.get(r.source_entity_id) ?? new Set<string>();
      const tn = neighbors.get(r.target_entity_id) ?? new Set<string>();
      const features = computeEdgeFeatures({
        sourceDegree: degrees.get(r.source_entity_id) ?? 0,
        targetDegree: degrees.get(r.target_entity_id) ?? 0,
        sourceNeighbors: sn,
        targetNeighbors: tn,
        sourceMentions: mentions.get(r.source_entity_id) ?? 0,
        targetMentions: mentions.get(r.target_entity_id) ?? 0,
        ageDays: Math.max(0, (now - r.updated_at) / DAY),
      });
      const packed = packFeatures(features);
      update.run(packed, r.id);
      updated++;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    log.warn(`recompute features failed: ${String(err)}`);
    return 0;
  }

  if (updated > 0) {
    log.debug("topology features recomputed", { updated });
  }
  return updated;
}

/**
 * Retrieve features for a single relationship, computing them on-the-fly
 * if not yet persisted. Read-only convenience for the graph reader path.
 */
export function getOrComputeEdgeFeatures(
  db: DatabaseSync,
  relationshipId: string,
): TopologyFeatures | null {
  const row = db
    .prepare(
      `SELECT id, source_entity_id, target_entity_id, updated_at, gate_features
       FROM relationships WHERE id = ?`,
    )
    .get(relationshipId) as (RelRow & { gate_features: Uint8Array | null }) | undefined;
  if (!row) {
    return null;
  }
  const cached = unpackFeatures(row.gate_features);
  if (cached) {
    return cached;
  }
  // Lazy compute (best-effort; does not persist).
  const allIds = [row.source_entity_id, row.target_entity_id];
  const degrees = getDegrees(db, allIds);
  const neighbors = getNeighborSets(db, allIds);
  const mentions = getEntityMentions(db, allIds);
  const sn = neighbors.get(row.source_entity_id) ?? new Set<string>();
  const tn = neighbors.get(row.target_entity_id) ?? new Set<string>();
  const DAY = 24 * 60 * 60 * 1000;
  return computeEdgeFeatures({
    sourceDegree: degrees.get(row.source_entity_id) ?? 0,
    targetDegree: degrees.get(row.target_entity_id) ?? 0,
    sourceNeighbors: sn,
    targetNeighbors: tn,
    sourceMentions: mentions.get(row.source_entity_id) ?? 0,
    targetMentions: mentions.get(row.target_entity_id) ?? 0,
    ageDays: Math.max(0, (Date.now() - row.updated_at) / DAY),
  });
}
