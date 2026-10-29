/**
 * PLAN-59 Phase 1: need, gain and priority. Development partition only.
 *
 * need(k) for a family k (a chunk path) is the sum of
 *   1. the access prior: each chunk's access_count decayed from its
 *      last_accessed_at with a 30-day half-life (a chunk with accesses but no
 *      timestamp decays from created_at);
 *   2. development demand: the number of development queries whose fused top 5
 *      contains a chunk of k;
 *   3. unsuccessful retrievals: 1 per development query whose gold is in k and
 *      whose fused rank is above 10 or missing;
 *   4. `retrieval_hits` (PLAN-59 Phase 0) decayed the same way, when the table
 *      exists and has rows. It is empty on the pilot snapshot, so the access
 *      prior carries.
 * The plan's first-order session-transition term is deferred (see README).
 *
 * gain(op | k) is the mean change in parent-mapped reciprocal rank over the
 * development queries affected by the operation whose gold is in k, measured
 * by applying only that operation on a fork. Queries are affected when their
 * gold is in a family the operation touches or when their baseline top 10
 * contains a chunk the operation touches.
 *
 * priority(op) = sum_k need(k) * gain(op | k) / cost(op),
 * cost(op) = 1 + chunksTouched + 2 * embeddingCalls (weights fixed here).
 */
import { DAY_MS } from "./common.js";
import { type Operation, type OperationCost, affectedChunkIds } from "./operations.js";

export const COST_WEIGHTS = { base: 1, perChunk: 1, perEmbeddingCall: 2 } as const;
export const NEED_HALF_LIFE_DAYS = 30;

export function costScalar(cost: Pick<OperationCost, "chunksTouched" | "embeddingCalls">): number {
  return (
    COST_WEIGHTS.base +
    COST_WEIGHTS.perChunk * Math.max(0, cost.chunksTouched) +
    COST_WEIGHTS.perEmbeddingCall * Math.max(0, cost.embeddingCalls)
  );
}

/**
 * benefit / cost with a zero-cost guard: a non-positive or non-finite cost is
 * treated as the base cost (1) rather than producing Infinity or NaN.
 */
export function priority(benefit: number, cost: number): number {
  const c = Number.isFinite(cost) && cost > 0 ? cost : COST_WEIGHTS.base;
  return benefit / c;
}

export function decayFactor(
  lastAt: number | null,
  now: number,
  halfLifeDays = NEED_HALF_LIFE_DAYS,
): number {
  if (lastAt === null || !Number.isFinite(lastAt)) {
    return 0;
  }
  const ageDays = Math.max(0, (now - lastAt) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export type ChunkNeedRow = {
  id: string;
  path: string;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number | null;
};

/** What the estimator needs from one development query's baseline run. */
export type DevBaseline = {
  chunkId: string;
  family: string;
  /** parent-mapped fused rank on the unchanged fork, null when missing */
  fusedRank: number | null;
  /** chunk ids of the fused top 10, in order */
  topTenIds: string[];
};

export type NeedBreakdown = {
  total: number;
  accessPrior: number;
  topFiveDemand: number;
  unsuccessful: number;
  retrievalHits: number;
};

export function needByFamily(params: {
  chunks: readonly ChunkNeedRow[];
  devBaseline: readonly DevBaseline[];
  chunkFamily: ReadonlyMap<string, string>;
  now: number;
  halfLifeDays?: number;
  retrievalHits?: ReadonlyArray<{ chunkId: string; createdAt: number }>;
}): Map<string, NeedBreakdown> {
  const half = params.halfLifeDays ?? NEED_HALF_LIFE_DAYS;
  const out = new Map<string, NeedBreakdown>();
  const get = (fam: string) => {
    let b = out.get(fam);
    if (!b) {
      b = { total: 0, accessPrior: 0, topFiveDemand: 0, unsuccessful: 0, retrievalHits: 0 };
      out.set(fam, b);
    }
    return b;
  };
  for (const c of params.chunks) {
    if (c.accessCount <= 0) continue;
    const at = c.lastAccessedAt ?? c.createdAt;
    get(c.path).accessPrior += c.accessCount * decayFactor(at, params.now, half);
  }
  for (const q of params.devBaseline) {
    for (const id of q.topTenIds.slice(0, 5)) {
      const fam = params.chunkFamily.get(id);
      if (fam !== undefined) get(fam).topFiveDemand += 1;
    }
    if (q.fusedRank === null || q.fusedRank > 10) {
      get(q.family).unsuccessful += 1;
    }
  }
  for (const h of params.retrievalHits ?? []) {
    const fam = params.chunkFamily.get(h.chunkId);
    if (fam !== undefined) get(fam).retrievalHits += decayFactor(h.createdAt, params.now, half);
  }
  for (const b of out.values()) {
    b.total = b.accessPrior + b.topFiveDemand + b.unsuccessful + b.retrievalHits;
  }
  return out;
}

/** Sum of need over the families an operation touches (its own ranking key for the gain cap). */
export function operationNeed(op: Operation, need: ReadonlyMap<string, NeedBreakdown>): number {
  return op.families.reduce((s, f) => s + (need.get(f)?.total ?? 0), 0);
}

/** Development queries whose outcome an operation could change. */
export function affectedQueries(op: Operation, devBaseline: readonly DevBaseline[]): DevBaseline[] {
  const fams = new Set(op.families);
  const ids = new Set(affectedChunkIds(op));
  return devBaseline.filter((q) => fams.has(q.family) || q.topTenIds.some((id) => ids.has(id)));
}

export const reciprocal = (rank: number | null): number =>
  rank === null || rank <= 0 ? 0 : 1 / rank;

/**
 * gain(op | k): mean change in reciprocal rank over the affected queries with
 * gold in k. `before` and `after` map query chunkId -> parent-mapped rank.
 */
export function gainByFamily(
  affected: readonly DevBaseline[],
  before: ReadonlyMap<string, number | null>,
  after: ReadonlyMap<string, number | null>,
): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const q of affected) {
    const d = reciprocal(after.get(q.chunkId) ?? null) - reciprocal(before.get(q.chunkId) ?? null);
    const s = sums.get(q.family) ?? { sum: 0, n: 0 };
    s.sum += d;
    s.n += 1;
    sums.set(q.family, s);
  }
  return new Map([...sums.entries()].map(([k, s]) => [k, s.sum / s.n]));
}

/** sum_k need(k) * gain(op | k) */
export function estimatedBenefit(
  gain: ReadonlyMap<string, number>,
  need: ReadonlyMap<string, NeedBreakdown>,
): number {
  let total = 0;
  for (const [fam, g] of gain) {
    total += (need.get(fam)?.total ?? 0) * g;
  }
  return total;
}

export type PriorityRow = {
  opId: string;
  need: number;
  benefit: number;
  cost: number;
  priority: number;
  affectedQueries: number;
  /** per-family gain, by family hash in the output; by path internally */
  gain: Record<string, number>;
};

export function priorityRow(params: {
  op: Operation;
  need: ReadonlyMap<string, NeedBreakdown>;
  gain: ReadonlyMap<string, number>;
  cost: OperationCost;
  affectedQueries: number;
}): PriorityRow {
  const benefit = estimatedBenefit(params.gain, params.need);
  const cost = costScalar(params.cost);
  return {
    opId: params.op.id,
    need: operationNeed(params.op, params.need),
    benefit,
    cost,
    priority: priority(benefit, cost),
    affectedQueries: params.affectedQueries,
    gain: Object.fromEntries(params.gain),
  };
}
