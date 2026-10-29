/**
 * PLAN-59 Phase 1: ranks, metrics and the family-level paired bootstrap.
 *
 * Raw rank follows benchmarks/live-recall/run.mts: the first result on the
 * gold chunk's path whose line span overlaps the gold span. Parent-mapped rank
 * additionally counts a result that resolves to the gold chunk's parent (the
 * consolidated chunk a cluster operation created). Both are recorded.
 */
import { type Question, mean, seededRandom } from "./common.js";

export type Channel = "vector" | "keyword" | "graph";
export const CHANNELS: readonly Channel[] = ["vector", "keyword", "graph"];

/** One search result reduced to what scoring needs. */
export type RankedResult = {
  path: string;
  startLine: number;
  endLine: number;
  /** chunk id resolved from (path, lines, snippet); null when ambiguous */
  id: string | null;
  channels?: Partial<Record<Channel, { rank: number }>>;
};

export type QueryOutcome = {
  chunkId: string;
  family: string;
  rawRank: number | null;
  mappedRank: number | null;
  channelRanks: Record<Channel, number | null>;
  topTenIds: string[];
  /** path of the first result, null when nothing came back */
  topOneFamily: string | null;
  returned: number;
  latencyMs: number;
};

export const isRawHit = (r: RankedResult, q: Question): boolean =>
  r.path === q.path && r.startLine <= q.endLine && r.endLine >= q.startLine;

export function rankOf(
  results: readonly RankedResult[],
  gold: Question,
  parentId: string | null,
): { raw: number | null; mapped: number | null } {
  let raw: number | null = null;
  let mapped: number | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const hit = isRawHit(r, gold);
    if (hit && raw === null) raw = i + 1;
    if ((hit || (parentId !== null && r.id === parentId)) && mapped === null) mapped = i + 1;
    if (raw !== null && mapped !== null) break;
  }
  return { raw, mapped };
}

export function channelRanks(
  results: readonly RankedResult[],
  gold: Question,
  parentId: string | null,
): Record<Channel, number | null> {
  const out = { vector: null, keyword: null, graph: null } as Record<Channel, number | null>;
  for (const ch of CHANNELS) {
    const ranked = results
      .filter((r) => r.channels?.[ch])
      .toSorted((a, b) => a.channels![ch]!.rank - b.channels![ch]!.rank);
    out[ch] = rankOf(ranked, gold, parentId).mapped;
  }
  return out;
}

export const reciprocal = (rank: number | null): number =>
  rank === null || rank <= 0 ? 0 : 1 / rank;

export type ArmSummary = {
  n: number;
  families: number;
  mrr: number;
  rawMrr: number;
  r1: number;
  r5: number;
  /** share of queries with gold (parent-mapped) in the top 10 */
  coverage10: number;
  /** share of queries whose top-1 result is on a different path than gold */
  wrongAnswerProxy: number;
  emptyShare: number;
  latencyMs: { mean: number; p50: number; p95: number };
  channels: Record<Channel, { mrr: number; r5: number }>;
};

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarize(outcomes: readonly QueryOutcome[]): ArmSummary {
  const n = outcomes.length;
  const share = (pred: (o: QueryOutcome) => boolean) =>
    n === 0 ? 0 : outcomes.filter(pred).length / n;
  const lat = outcomes.map((o) => o.latencyMs).toSorted((a, b) => a - b);
  const channels = {} as ArmSummary["channels"];
  for (const ch of CHANNELS) {
    channels[ch] = {
      mrr: mean(outcomes.map((o) => reciprocal(o.channelRanks[ch]))),
      r5: share((o) => o.channelRanks[ch] !== null && o.channelRanks[ch]! <= 5),
    };
  }
  return {
    n,
    families: new Set(outcomes.map((o) => o.family)).size,
    mrr: mean(outcomes.map((o) => reciprocal(o.mappedRank))),
    rawMrr: mean(outcomes.map((o) => reciprocal(o.rawRank))),
    r1: share((o) => o.mappedRank === 1),
    r5: share((o) => o.mappedRank !== null && o.mappedRank <= 5),
    coverage10: share((o) => o.mappedRank !== null && o.mappedRank <= 10),
    wrongAnswerProxy: share((o) => o.topOneFamily !== null && o.topOneFamily !== o.family),
    emptyShare: share((o) => o.returned === 0),
    latencyMs: { mean: mean(lat), p50: percentile(lat, 50), p95: percentile(lat, 95) },
    channels,
  };
}

/** Mean of a per-query metric within each family. */
export function familyMeans(
  outcomes: readonly QueryOutcome[],
  metric: (o: QueryOutcome) => number,
): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const o of outcomes) {
    const list = acc.get(o.family) ?? [];
    list.push(metric(o));
    acc.set(o.family, list);
  }
  return new Map([...acc.entries()].map(([f, xs]) => [f, mean(xs)]));
}

export type PairedContrast = {
  families: number;
  /** mean over families of (a - b) */
  estimate: number;
  ci95: [number, number];
  resamples: number;
  seed: string;
  /** share of families where a > b, a < b */
  familiesUp: number;
  familiesDown: number;
};

/**
 * Family-paired contrast a minus b with a percentile bootstrap over families
 * (resampled with replacement, seeded). Families present in only one map are
 * dropped; with the same question set under every arm that never happens.
 */
export function pairedFamilyBootstrap(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  opts: { resamples?: number; seed: string },
): PairedContrast {
  const resamples = opts.resamples ?? 2000;
  const fams = [...a.keys()].filter((f) => b.has(f)).toSorted();
  const diffs = fams.map((f) => a.get(f)! - b.get(f)!);
  const estimate = mean(diffs);
  if (diffs.length === 0) {
    return {
      families: 0,
      estimate: 0,
      ci95: [0, 0],
      resamples,
      seed: opts.seed,
      familiesUp: 0,
      familiesDown: 0,
    };
  }
  const rnd = seededRandom(opts.seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) {
      s += diffs[Math.floor(rnd() * diffs.length)]!;
    }
    stats.push(s / diffs.length);
  }
  stats.sort((x, y) => x - y);
  return {
    families: diffs.length,
    estimate,
    ci95: [percentile(stats, 2.5), percentile(stats, 97.5)],
    resamples,
    seed: opts.seed,
    familiesUp: diffs.filter((d) => d > 0).length,
    familiesDown: diffs.filter((d) => d < 0).length,
  };
}
