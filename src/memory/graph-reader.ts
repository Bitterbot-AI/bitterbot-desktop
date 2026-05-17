/**
 * PLAN-18 Phase 2 — SAGE-style graph reader.
 *
 * Performs L-step message passing over the existing entities/relationships
 * tables, seeded from a `QueryPlan` (Phase 1). Returns a probability
 * distribution over chunk IDs via relationships.evidence_chunk_ids.
 *
 * The reader is intentionally NOT a real GNN — there is no PyTorch in
 * Electron. The "GNN" is iterated SQL propagation with scalar per-edge
 * gates. The gate function is injectable so Phase 3 can swap a learned
 * MLP in without touching this file.
 *
 * Pure functions. Caller owns the DB handle.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { KnowledgeGraphManager, EntityType } from "./knowledge-graph.js";
import type { QueryPlan } from "./query-planner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/graph-reader");

export type GraphReaderOptions = {
  /** Number of message-passing hops. Default 2 (SAGE-aligned). */
  hops?: number;
  /** Cap on the activation frontier per hop to bound cost. Default 200. */
  maxFrontier?: number;
  /** Activation decay per hop (1-α). Default 0.5. */
  decay?: number;
  /** Propagation rate. Default 1.0. */
  propagate?: number;
  /** Final return cap on chunks. Default 50. */
  topK?: number;
  /** Optional per-edge gate. Default: identity (returns 1.0). */
  gateFn?: GateFn;
  /** Optional hormonal state to influence the gate (Phase 5). */
  hormonalState?: { dopamine: number; cortisol: number; oxytocin: number };
  /** Cache TTL for the activation pass (ms). Default 30s. 0 disables. */
  cacheTtlMs?: number;
};

export type GateFn = (input: GateInput) => number;

export type GateInput = {
  sourceId: string;
  targetId: string;
  weight: number;
  relationType: string;
  sourceDegree: number;
  targetDegree: number;
  hormonalState?: { dopamine: number; cortisol: number; oxytocin: number };
};

export type GraphReaderResult = {
  /** Ranked chunk IDs with graph-propagation scores in [0, 1]. */
  chunks: Array<{ chunkId: string; score: number }>;
  /** Entity activations at the final hop, ranked. Useful for telemetry. */
  entities: Array<{ entityId: string; entityName: string; activation: number }>;
  /** Wall-clock cost of the pass (ms). */
  readingTimeMs: number;
  /** Entities matched from the plan (the seed set). */
  seedEntityIds: string[];
  /** Hops actually performed (capped if frontier exceeded maxFrontier). */
  hopsPerformed: number;
  /** True if served from cache. */
  cached: boolean;
};

const DEFAULT_HOPS = 2;
const DEFAULT_FRONTIER = 200;
const DEFAULT_DECAY = 0.5;
const DEFAULT_PROPAGATE = 1.0;
const DEFAULT_TOPK = 50;
const DEFAULT_TTL_MS = 30_000;
const CACHE_CAPACITY = 64;

type CacheEntry = { result: GraphReaderResult; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function purgeExpired(now: number): void {
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) {
      cache.delete(k);
    }
  }
}

function admitCache(key: string, result: GraphReaderResult, ttl: number): void {
  if (cache.size >= CACHE_CAPACITY) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, { result, expiresAt: Date.now() + ttl });
}

function hashKey(plan: QueryPlan, opts: GraphReaderOptions): string {
  const fingerprint = JSON.stringify({
    q: plan.rawQuery,
    e: plan.explicitEntities.toSorted(),
    a: plan.aliases.toSorted(),
    hops: opts.hops ?? DEFAULT_HOPS,
    k: opts.topK ?? DEFAULT_TOPK,
    h: opts.hormonalState
      ? {
          d: Math.round(opts.hormonalState.dopamine * 10),
          c: Math.round(opts.hormonalState.cortisol * 10),
          o: Math.round(opts.hormonalState.oxytocin * 10),
        }
      : null,
  });
  return crypto.createHash("sha1").update(fingerprint).digest("hex");
}

const ENTITY_TYPES_FOR_RESOLUTION: EntityType[] = [
  "person",
  "project",
  "concept",
  "tool",
  "organization",
  "location",
  "file",
  "service",
  "event",
];

function resolveSeedEntities(kg: KnowledgeGraphManager, plan: QueryPlan): Set<string> {
  const seeds = new Set<string>();
  const candidates: string[] = [...plan.explicitEntities, ...plan.aliases, ...plan.hardConstraints];
  for (const cand of candidates) {
    const name = cand.trim();
    if (name.length === 0) {
      continue;
    }
    let matched = false;
    for (const t of ENTITY_TYPES_FOR_RESOLUTION) {
      const ent = kg.findEntityByNameType(name, t);
      if (ent) {
        seeds.add(ent.id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const fuzzy = kg.searchEntities(name, 3);
      for (const ent of fuzzy) {
        seeds.add(ent.id);
      }
    }
  }
  return seeds;
}

type Neighbor = {
  neighborId: string;
  weight: number;
  relationType: string;
  evidenceChunkIds: string[];
};

type DegreeMap = Map<string, number>;

function readNeighbors(db: DatabaseSync, entityIds: string[]): Map<string, Neighbor[]> {
  if (entityIds.length === 0) {
    return new Map();
  }
  const placeholders = entityIds.map(() => "?").join(",");
  // Outgoing edges
  const outRows = db
    .prepare(
      `SELECT source_entity_id AS sid, target_entity_id AS tid, weight, relation_type, evidence_chunk_ids
       FROM relationships
       WHERE source_entity_id IN (${placeholders}) AND valid_until IS NULL`,
    )
    .all(...entityIds) as Array<{
    sid: string;
    tid: string;
    weight: number;
    relation_type: string;
    evidence_chunk_ids: string;
  }>;
  // Incoming edges (treat as undirected for propagation purposes)
  const inRows = db
    .prepare(
      `SELECT target_entity_id AS sid, source_entity_id AS tid, weight, relation_type, evidence_chunk_ids
       FROM relationships
       WHERE target_entity_id IN (${placeholders}) AND valid_until IS NULL`,
    )
    .all(...entityIds) as Array<{
    sid: string;
    tid: string;
    weight: number;
    relation_type: string;
    evidence_chunk_ids: string;
  }>;

  const out = new Map<string, Neighbor[]>();
  const push = (sid: string, n: Neighbor): void => {
    const arr = out.get(sid);
    if (arr) {
      arr.push(n);
    } else {
      out.set(sid, [n]);
    }
  };

  for (const row of [...outRows, ...inRows]) {
    let evidence: string[] = [];
    try {
      const parsed = JSON.parse(row.evidence_chunk_ids || "[]");
      if (Array.isArray(parsed)) {
        evidence = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore malformed evidence
    }
    push(row.sid, {
      neighborId: row.tid,
      weight: row.weight,
      relationType: row.relation_type,
      evidenceChunkIds: evidence,
    });
  }
  return out;
}

function readDegrees(db: DatabaseSync, entityIds: string[]): DegreeMap {
  const out: DegreeMap = new Map();
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
    .all(...entityIds, ...entityIds) as Array<{ eid: string; deg: number }>;
  for (const r of rows) {
    out.set(r.eid, Math.max(1, r.deg));
  }
  for (const id of entityIds) {
    if (!out.has(id)) {
      out.set(id, 1);
    }
  }
  return out;
}

function topActivationsByFrontier(
  activation: Map<string, number>,
  cap: number,
): Map<string, number> {
  if (activation.size <= cap) {
    return activation;
  }
  const sorted = [...activation.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, cap);
  return new Map(sorted);
}

function readEntityNames(db: DatabaseSync, entityIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (entityIds.length === 0) {
    return out;
  }
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, name FROM entities WHERE id IN (${placeholders})`)
    .all(...entityIds) as Array<{ id: string; name: string }>;
  for (const r of rows) {
    out.set(r.id, r.name);
  }
  return out;
}

/**
 * Run a SAGE-style graph read. Pure function over the supplied DB handle.
 */
export function graphRead(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  plan: QueryPlan,
  opts: GraphReaderOptions = {},
): GraphReaderResult {
  const start = Date.now();
  const hops = Math.max(1, Math.min(opts.hops ?? DEFAULT_HOPS, 4));
  const maxFrontier = Math.max(10, opts.maxFrontier ?? DEFAULT_FRONTIER);
  const decay = Math.max(0, Math.min(1, opts.decay ?? DEFAULT_DECAY));
  const propagate = Math.max(0, opts.propagate ?? DEFAULT_PROPAGATE);
  const topK = Math.max(1, opts.topK ?? DEFAULT_TOPK);
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const gateFn: GateFn = opts.gateFn ?? (() => 1.0);

  if (ttl > 0) {
    purgeExpired(Date.now());
    const key = hashKey(plan, opts);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return { ...hit.result, cached: true };
    }
  }

  const seedSet = resolveSeedEntities(kg, plan);
  const seedEntityIds = [...seedSet];

  if (seedEntityIds.length === 0) {
    const empty: GraphReaderResult = {
      chunks: [],
      entities: [],
      readingTimeMs: Date.now() - start,
      seedEntityIds: [],
      hopsPerformed: 0,
      cached: false,
    };
    return empty;
  }

  // Initial activation = 1.0 for each seed entity, normalized.
  let activation = new Map<string, number>();
  const seedActivation = 1.0 / Math.sqrt(seedEntityIds.length);
  for (const id of seedEntityIds) {
    activation.set(id, seedActivation);
  }

  // Track chunk accumulation across hops to weight evidence edges traversed.
  const chunkScores = new Map<string, number>();
  let hopsPerformed = 0;

  for (let h = 0; h < hops; h++) {
    const frontierIds = [...activation.keys()];
    if (frontierIds.length === 0) {
      break;
    }
    const neighbors = readNeighbors(db, frontierIds);
    const allTouched = new Set<string>();
    for (const list of neighbors.values()) {
      for (const n of list) {
        allTouched.add(n.neighborId);
      }
    }
    for (const id of frontierIds) {
      allTouched.add(id);
    }
    const degrees = readDegrees(db, [...allTouched]);

    const next = new Map<string, number>();

    // Carry decayed self-activation forward.
    for (const [id, a] of activation) {
      if (a > 0) {
        next.set(id, (1 - decay) * a);
      }
    }

    // Propagate.
    for (const [sid, a] of activation) {
      if (a <= 0) {
        continue;
      }
      const out = neighbors.get(sid);
      if (!out) {
        continue;
      }
      const sourceDegree = degrees.get(sid) ?? 1;
      for (const n of out) {
        const targetDegree = degrees.get(n.neighborId) ?? 1;
        const gate = gateFn({
          sourceId: sid,
          targetId: n.neighborId,
          weight: n.weight,
          relationType: n.relationType,
          sourceDegree,
          targetDegree,
          hormonalState: opts.hormonalState,
        });
        const contribution = (propagate * gate * n.weight * a) / Math.sqrt(targetDegree);
        next.set(n.neighborId, (next.get(n.neighborId) ?? 0) + contribution);

        // Accumulate chunk evidence along the traversed edge.
        if (n.evidenceChunkIds.length > 0) {
          const chunkContribution = contribution / Math.max(1, n.evidenceChunkIds.length);
          for (const cid of n.evidenceChunkIds) {
            chunkScores.set(cid, (chunkScores.get(cid) ?? 0) + chunkContribution);
          }
        }
      }
    }

    // L1-normalize next-step activations to keep magnitudes bounded.
    let total = 0;
    for (const a of next.values()) {
      total += Math.abs(a);
    }
    if (total > 0) {
      for (const [id, a] of next) {
        next.set(id, a / total);
      }
    }

    activation = topActivationsByFrontier(next, maxFrontier);
    hopsPerformed++;
  }

  // Normalize chunk scores into [0, 1] by max.
  let maxScore = 0;
  for (const s of chunkScores.values()) {
    if (s > maxScore) {
      maxScore = s;
    }
  }
  const chunks: Array<{ chunkId: string; score: number }> = [];
  if (maxScore > 0) {
    for (const [cid, s] of chunkScores) {
      chunks.push({ chunkId: cid, score: s / maxScore });
    }
  }
  const sortedChunks = chunks.toSorted((a, b) => b.score - a.score);
  const topChunks = sortedChunks.slice(0, topK);

  const finalEntityIds = [...activation.keys()];
  const names = readEntityNames(db, finalEntityIds);
  const entities = finalEntityIds
    .map((id) => ({
      entityId: id,
      entityName: names.get(id) ?? id,
      activation: activation.get(id) ?? 0,
    }))
    .toSorted((a, b) => b.activation - a.activation)
    .slice(0, topK);

  const result: GraphReaderResult = {
    chunks: topChunks,
    entities,
    readingTimeMs: Date.now() - start,
    seedEntityIds,
    hopsPerformed,
    cached: false,
  };

  if (ttl > 0) {
    admitCache(hashKey(plan, opts), result, ttl);
  }

  if (log.debug) {
    log.debug("graph-read", {
      seeds: seedEntityIds.length,
      hops: hopsPerformed,
      chunks: result.chunks.length,
      ms: result.readingTimeMs,
    });
  }
  return result;
}

/** Visible for tests. */
export function _clearGraphReaderCache(): void {
  cache.clear();
}
