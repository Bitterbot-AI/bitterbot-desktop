/**
 * PLAN-18 Phase 3 — gradient-free gate optimizer.
 *
 * SAGE's writer-reader alternation, adapted to a non-differentiable
 * TS retriever. The optimizer samples a small population of parameter
 * perturbations each generation, evaluates each by running the graph
 * reader over a held-out QA fixture, keeps the top-k, and shrinks σ
 * around their mean. This is a CMA-ES-lite ("simple Gaussian random
 * search") that fits the ~145-parameter scale of our gate.
 *
 * Reward (SAGE Eq. 4):
 *   r = (α · recall + β · precision + γ · deducibility) / (α + β + γ)
 *
 * - recall:        ground-truth chunk appears in top-K
 * - precision:     1 / (1 + rank of ground-truth chunk)
 * - deducibility:  proxy = top-K chunks share an entity neighborhood
 *                  with the ground-truth chunk (graph-evidence overlap)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { graphRead, type GateFn, type GraphReaderOptions } from "./graph-reader.js";
import { getOrComputeEdgeFeatures, type TopologyFeatures } from "./graph-topology.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { planQueryHeuristic, type QueryPlan } from "./query-planner.js";
import {
  forward,
  flattenGate,
  gateValue,
  mulberry32,
  perturbGate,
  serializeGate,
  type GateParameters,
  type HormonalLevels,
} from "./structural-gate.js";

const log = createSubsystemLogger("memory/graph-optimizer");

export type TrainingPair = {
  id: string;
  query: string;
  groundTruthChunkId: string;
};

export type OptimizerConfig = {
  /** Population per generation. Default 30. */
  population?: number;
  /** Number of generations. Default 10. */
  generations?: number;
  /** Initial perturbation σ. Default 0.05. */
  initialSigma?: number;
  /** Minimum σ; floors the shrink. Default 0.005. */
  minSigma?: number;
  /** Top-k survivors per generation. Default 6. */
  elite?: number;
  /** Reward weights (α, β, γ). Default 1.0 / 1.0 / 1.0. */
  rewardWeights?: { alpha: number; beta: number; gamma: number };
  /** Reader options used during evaluation. */
  readerOptions?: GraphReaderOptions;
  /** Hormonal state to use during evaluation (Phase 5 integration). */
  hormonalState?: HormonalLevels;
  /** Random seed for reproducibility. Default Date.now(). */
  seed?: number;
};

export type OptimizerResult = {
  bestGate: GateParameters;
  bestReward: number;
  baselineReward: number;
  improvement: number;
  generations: number;
  evaluations: number;
  wallTimeMs: number;
  /** Per-generation log: (genIdx, best, mean). */
  trace: Array<{ gen: number; best: number; mean: number }>;
};

const DEFAULT_POP = 30;
const DEFAULT_GENS = 10;
const DEFAULT_SIGMA = 0.05;
const DEFAULT_MIN_SIGMA = 0.005;
const DEFAULT_ELITE = 6;

/** Make a gate function bound to a specific parameter set + hormonal state. */
export function gateFnFromParameters(
  db: DatabaseSync,
  params: GateParameters,
  hormonalState?: HormonalLevels,
): GateFn {
  // Per-relationship feature lookup is expensive in a tight loop; we
  // memoize within a single optimizer evaluation pass by relationship
  // ID. The graph-reader walks edges via the (source, target) tuple
  // rather than the rel-id, so we fetch by source+target.
  const featureCache = new Map<string, TopologyFeatures | null>();
  const cacheKey = (sid: string, tid: string) => `${sid}|${tid}`;

  const lookup = (sid: string, tid: string): TopologyFeatures | null => {
    const k = cacheKey(sid, tid);
    if (featureCache.has(k)) {
      return featureCache.get(k) ?? null;
    }
    const row = db
      .prepare(
        `SELECT id FROM relationships
         WHERE source_entity_id = ? AND target_entity_id = ? AND valid_until IS NULL
         ORDER BY weight DESC LIMIT 1`,
      )
      .get(sid, tid) as { id: string } | undefined;
    const feats = row ? getOrComputeEdgeFeatures(db, row.id) : null;
    featureCache.set(k, feats);
    return feats;
  };

  return (input) => {
    const feats = lookup(input.sourceId, input.targetId) ?? lookup(input.targetId, input.sourceId);
    if (!feats) {
      return 1;
    }
    return gateValue(params, feats, {
      relationType: input.relationType,
      hormonalState: hormonalState ?? input.hormonalState,
    });
  };
}

/**
 * Evaluate a gate parameter set against the training pairs.
 * Returns the mean reward across all pairs.
 */
export function evaluateGate(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  params: GateParameters,
  pairs: TrainingPair[],
  cfg: OptimizerConfig = {},
): { reward: number; perPair: number[] } {
  if (pairs.length === 0) {
    return { reward: 0, perPair: [] };
  }
  const w = cfg.rewardWeights ?? { alpha: 1, beta: 1, gamma: 1 };
  const totalWeight = w.alpha + w.beta + w.gamma;
  const readerOpts: GraphReaderOptions = {
    ...cfg.readerOptions,
    gateFn: gateFnFromParameters(db, params, cfg.hormonalState),
    hormonalState: cfg.hormonalState,
    cacheTtlMs: 0, // disable cache during training
  };
  const perPair: number[] = [];
  let sum = 0;

  for (const pair of pairs) {
    const plan: QueryPlan = planQueryHeuristic(pair.query);
    const result = graphRead(db, kg, plan, readerOpts);
    const k = result.chunks.length;
    const rank = result.chunks.findIndex((c) => c.chunkId === pair.groundTruthChunkId);
    const recall = rank >= 0 ? 1 : 0;
    const precision = rank >= 0 ? 1 / (1 + rank) : 0;
    const deducibility = computeDeducibility(
      db,
      result.chunks.slice(0, Math.min(10, k)).map((c) => c.chunkId),
      pair.groundTruthChunkId,
    );
    const reward =
      (w.alpha * recall + w.beta * precision + w.gamma * deducibility) /
      Math.max(1e-9, totalWeight);
    perPair.push(reward);
    sum += reward;
  }
  return { reward: sum / pairs.length, perPair };
}

/**
 * Deducibility proxy: do the top-K retrieved chunks share at least one
 * entity-neighborhood with the ground-truth chunk? Returns ∈ [0, 1].
 */
function computeDeducibility(
  db: DatabaseSync,
  retrievedChunkIds: string[],
  groundTruthChunkId: string,
): number {
  if (retrievedChunkIds.length === 0) {
    return 0;
  }
  // Find all entities whose evidence chunks contain the ground-truth chunk.
  const truthEntities = findEntitiesForChunk(db, groundTruthChunkId);
  if (truthEntities.size === 0) {
    // No entities anchored to the ground-truth chunk → can't measure
    // deducibility; assume neutral.
    return 0.5;
  }
  // 1-hop neighborhood of those entities.
  const neighbors = oneHopNeighbors(db, [...truthEntities]);
  const closure = new Set<string>([...truthEntities, ...neighbors]);

  let hits = 0;
  for (const cid of retrievedChunkIds) {
    const e = findEntitiesForChunk(db, cid);
    let overlap = false;
    for (const id of e) {
      if (closure.has(id)) {
        overlap = true;
        break;
      }
    }
    if (overlap) {
      hits++;
    }
  }
  return hits / retrievedChunkIds.length;
}

function findEntitiesForChunk(db: DatabaseSync, chunkId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT source_entity_id, target_entity_id, evidence_chunk_ids
       FROM relationships
       WHERE valid_until IS NULL AND evidence_chunk_ids LIKE ?`,
    )
    .all(`%${chunkId}%`) as Array<{
    source_entity_id: string;
    target_entity_id: string;
    evidence_chunk_ids: string;
  }>;
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.evidence_chunk_ids || "[]");
      if (Array.isArray(arr) && arr.includes(chunkId)) {
        out.add(r.source_entity_id);
        out.add(r.target_entity_id);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function oneHopNeighbors(db: DatabaseSync, entityIds: string[]): Set<string> {
  const out = new Set<string>();
  if (entityIds.length === 0) {
    return out;
  }
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT target_entity_id AS nid FROM relationships
        WHERE valid_until IS NULL AND source_entity_id IN (${placeholders})
       UNION
       SELECT source_entity_id AS nid FROM relationships
        WHERE valid_until IS NULL AND target_entity_id IN (${placeholders})`,
    )
    .all(...entityIds, ...entityIds) as Array<{ nid: string }>;
  for (const r of rows) {
    out.add(r.nid);
  }
  return out;
}

/**
 * Read up to `limit` training pairs from the graph_gate_training_pairs table.
 * Most recent first.
 */
export function readTrainingPairs(db: DatabaseSync, limit = 200): TrainingPair[] {
  const rows = db
    .prepare(
      `SELECT id, query, ground_truth_chunk_id
       FROM graph_gate_training_pairs
       ORDER BY collected_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    query: string;
    ground_truth_chunk_id: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    query: r.query,
    groundTruthChunkId: r.ground_truth_chunk_id,
  }));
}

/**
 * Insert a training pair. Caps the table at 5000 rows.
 */
export function insertTrainingPair(
  db: DatabaseSync,
  query: string,
  chunkId: string,
  source: "access_log" | "session_extractor" | "manual" = "access_log",
): void {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO graph_gate_training_pairs (id, query, ground_truth_chunk_id, collected_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, query, chunkId, now, source);
    // Trim oldest beyond the cap.
    db.prepare(
      `DELETE FROM graph_gate_training_pairs WHERE id IN (
         SELECT id FROM graph_gate_training_pairs
           ORDER BY collected_at DESC LIMIT -1 OFFSET 5000
       )`,
    ).run();
  } catch (err) {
    log.debug(`insertTrainingPair failed: ${String(err)}`);
  }
}

/**
 * Run one optimization cycle. Caller is responsible for persisting the
 * returned gate parameters (and for invoking only when the dream engine
 * has scheduled a `graph_optimization` mode).
 */
export function runOptimizationCycle(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  baseline: GateParameters,
  pairs: TrainingPair[],
  cfg: OptimizerConfig = {},
): OptimizerResult {
  const start = Date.now();
  const pop = Math.max(4, cfg.population ?? DEFAULT_POP);
  const gens = Math.max(1, cfg.generations ?? DEFAULT_GENS);
  let sigma = Math.max(1e-6, cfg.initialSigma ?? DEFAULT_SIGMA);
  const minSigma = Math.max(1e-6, cfg.minSigma ?? DEFAULT_MIN_SIGMA);
  const elite = Math.max(1, Math.min(cfg.elite ?? DEFAULT_ELITE, pop - 1));
  const seed = cfg.seed ?? Date.now();
  const rng = mulberry32(seed);

  // Cortisol gate: skip training when hormones say "high arousal".
  if (cfg.hormonalState && cfg.hormonalState.cortisol > 0.7) {
    log.debug("skipping optimization — cortisol too high", {
      cortisol: cfg.hormonalState.cortisol,
    });
    return {
      bestGate: baseline,
      bestReward: 0,
      baselineReward: 0,
      improvement: 0,
      generations: 0,
      evaluations: 0,
      wallTimeMs: Date.now() - start,
      trace: [],
    };
  }

  const baselineEval = evaluateGate(db, kg, baseline, pairs, cfg);
  let best = baseline;
  let bestReward = baselineEval.reward;
  let evaluations = 1;
  const trace: Array<{ gen: number; best: number; mean: number }> = [];

  for (let g = 0; g < gens; g++) {
    const candidates: Array<{ gate: GateParameters; reward: number }> = [];
    for (let i = 0; i < pop; i++) {
      const cand = perturbGate(best, sigma, rng);
      const { reward } = evaluateGate(db, kg, cand, pairs, cfg);
      candidates.push({ gate: cand, reward });
      evaluations++;
    }
    const sortedCandidates = candidates.toSorted((a, b) => b.reward - a.reward);
    const survivors = sortedCandidates.slice(0, elite);
    const meanReward = candidates.reduce((s, c) => s + c.reward, 0) / candidates.length;
    const topReward = survivors[0]?.reward ?? bestReward;

    trace.push({ gen: g, best: topReward, mean: meanReward });

    if (topReward > bestReward) {
      bestReward = topReward;
      best = survivors[0]!.gate;
      // Mean of elite (flat) becomes new centroid — improves robustness.
      best = elitesCentroid(
        survivors.map((s) => s.gate),
        best,
      );
      sigma = Math.max(minSigma, sigma * 0.9);
    } else {
      sigma = Math.max(minSigma, sigma * 0.8);
    }
  }

  const wallTimeMs = Date.now() - start;
  const improvement = bestReward - baselineEval.reward;
  if (log.debug) {
    log.debug("optimization cycle complete", {
      baseline: baselineEval.reward,
      best: bestReward,
      improvement,
      evaluations,
      wallTimeMs,
    });
  }
  return {
    bestGate: best,
    bestReward,
    baselineReward: baselineEval.reward,
    improvement,
    generations: gens,
    evaluations,
    wallTimeMs,
    trace,
  };
}

function elitesCentroid(elites: GateParameters[], currentBest: GateParameters): GateParameters {
  if (elites.length === 0) {
    return currentBest;
  }
  const flats = elites.map((e) => flattenGate(e));
  const dim = flats[0]!.length;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    let s = 0;
    for (const f of flats) {
      s += f[i];
    }
    out[i] = s / flats.length;
  }
  return {
    ...currentBest,
    w1: out.subarray(0, currentBest.w1.length).slice(),
    b1: out.subarray(currentBest.w1.length, currentBest.w1.length + currentBest.b1.length).slice(),
    w2: out
      .subarray(
        currentBest.w1.length + currentBest.b1.length,
        currentBest.w1.length + currentBest.b1.length + currentBest.w2.length,
      )
      .slice(),
    b2: out
      .subarray(
        currentBest.w1.length + currentBest.b1.length + currentBest.w2.length,
        currentBest.w1.length +
          currentBest.b1.length +
          currentBest.w2.length +
          currentBest.b2.length,
      )
      .slice(),
    delta: Math.max(0, Math.min(1, out[dim - 1])),
  };
}

/** Serialize the gate to a JSON string suitable for the gate file. */
export function gateToJsonString(g: GateParameters): string {
  return JSON.stringify(serializeGate(g));
}

// Touch the forward function so the lazy import isn't tree-shaken; we
// use it transitively via gateValue.
void forward;
