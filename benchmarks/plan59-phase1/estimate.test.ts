import { describe, expect, it } from "vitest";
import { DAY_MS } from "./common.js";
import {
  affectedQueries,
  costScalar,
  decayFactor,
  type DevBaseline,
  estimatedBenefit,
  gainByFamily,
  needByFamily,
  operationNeed,
  priority,
  priorityRow,
} from "./estimate.js";
import type { ClusterCandidate } from "./operations.js";

const NOW = 1_800_000_000_000;

describe("need", () => {
  it("decays access counts with a 30-day half-life", () => {
    expect(decayFactor(NOW, NOW)).toBe(1);
    expect(decayFactor(NOW - 30 * DAY_MS, NOW)).toBeCloseTo(0.5, 10);
    expect(decayFactor(NOW - 60 * DAY_MS, NOW)).toBeCloseTo(0.25, 10);
    expect(decayFactor(NOW - 15 * DAY_MS, NOW, 15)).toBeCloseTo(0.5, 10);
    expect(decayFactor(null, NOW)).toBe(0);
    // a timestamp in the future counts as fresh, never above 1
    expect(decayFactor(NOW + DAY_MS, NOW)).toBe(1);
  });

  it("sums the access prior, top-5 demand and unsuccessful retrievals per family", () => {
    const chunks = [
      { id: "a1", path: "A", accessCount: 4, lastAccessedAt: NOW - 30 * DAY_MS, createdAt: 0 },
      { id: "a2", path: "A", accessCount: 2, lastAccessedAt: null, createdAt: NOW },
      { id: "b1", path: "B", accessCount: 0, lastAccessedAt: null, createdAt: null },
      { id: "c1", path: "C", accessCount: 10, lastAccessedAt: NOW, createdAt: 0 },
    ];
    const dev: DevBaseline[] = [
      { chunkId: "a1", family: "A", fusedRank: 1, topTenIds: ["a1", "c1", "x", "y", "z", "b1"] },
      { chunkId: "b1", family: "B", fusedRank: null, topTenIds: ["c1", "a2"] },
      { chunkId: "c1", family: "C", fusedRank: 12, topTenIds: ["c1"] },
    ];
    const chunkFamily = new Map(chunks.map((c) => [c.id, c.path]));
    const need = needByFamily({ chunks, devBaseline: dev, chunkFamily, now: NOW });
    // A: 4 * 0.5 (30 days) + 2 * 1 (no timestamp, decays from created_at = now) = 4;
    //    top-5 demand: a1 (q1) + a2 (q2) = 2; no unsuccessful
    expect(need.get("A")!.accessPrior).toBeCloseTo(4, 10);
    expect(need.get("A")!.topFiveDemand).toBe(2);
    expect(need.get("A")!.unsuccessful).toBe(0);
    expect(need.get("A")!.total).toBeCloseTo(6, 10);
    // B: no accesses, b1 sits at position 6 (outside top 5), gold missing -> 1
    expect(need.get("B")!.total).toBe(1);
    // C: 10 fresh accesses, in top 5 of q1, q2, q3 = 3, rank 12 -> unsuccessful 1
    expect(need.get("C")!.total).toBeCloseTo(14, 10);
  });

  it("uses retrieval_hits when present and leaves them at zero otherwise", () => {
    const chunks = [{ id: "a1", path: "A", accessCount: 0, lastAccessedAt: null, createdAt: 0 }];
    const chunkFamily = new Map([["a1", "A"]]);
    const without = needByFamily({ chunks, devBaseline: [], chunkFamily, now: NOW });
    expect(without.get("A")).toBeUndefined();
    const withHits = needByFamily({
      chunks,
      devBaseline: [],
      chunkFamily,
      now: NOW,
      retrievalHits: [
        { chunkId: "a1", createdAt: NOW },
        { chunkId: "a1", createdAt: NOW - 30 * DAY_MS },
      ],
    });
    expect(withHits.get("A")!.retrievalHits).toBeCloseTo(1.5, 10);
    expect(withHits.get("A")!.total).toBeCloseTo(1.5, 10);
  });
});

const cluster: ClusterCandidate = {
  kind: "consolidate_cluster",
  id: "cc_1",
  families: ["A"],
  memberIds: ["a1", "a2"],
  pairCount: 1,
  minSimilarity: 0.9,
  lastAccessedAt: null,
};

describe("priority", () => {
  it("prices cost as 1 + chunks + 2 * embedding calls", () => {
    expect(costScalar({ chunksTouched: 3, embeddingCalls: 1 })).toBe(6);
    expect(costScalar({ chunksTouched: 0, embeddingCalls: 0 })).toBe(1);
  });

  it("guards a zero or invalid cost instead of dividing by it", () => {
    expect(priority(2, 4)).toBe(0.5);
    expect(priority(2, 0)).toBe(2);
    expect(priority(2, -3)).toBe(2);
    expect(priority(2, Number.NaN)).toBe(2);
    expect(Number.isFinite(priority(2, 0))).toBe(true);
  });

  it("weights gain by need and divides by cost", () => {
    const need = new Map([
      ["A", { total: 6, accessPrior: 6, topFiveDemand: 0, unsuccessful: 0, retrievalHits: 0 }],
      ["B", { total: 2, accessPrior: 2, topFiveDemand: 0, unsuccessful: 0, retrievalHits: 0 }],
    ]);
    const gain = new Map([
      ["A", 0.5],
      ["B", -0.25],
    ]);
    expect(estimatedBenefit(gain, need)).toBeCloseTo(2.5, 10);
    expect(operationNeed(cluster, need)).toBe(6);
    const row = priorityRow({
      op: cluster,
      need,
      gain,
      cost: { chunksTouched: 3, embeddingCalls: 1, estimatedMs: 0 },
      affectedQueries: 4,
    });
    expect(row.cost).toBe(6);
    expect(row.priority).toBeCloseTo(2.5 / 6, 10);
  });
});

describe("gain", () => {
  const dev: DevBaseline[] = [
    { chunkId: "q1", family: "A", fusedRank: 2, topTenIds: ["x"] },
    { chunkId: "q2", family: "B", fusedRank: 4, topTenIds: ["a1", "y"] },
    { chunkId: "q3", family: "C", fusedRank: null, topTenIds: ["z"] },
  ];

  it("selects the queries whose gold family or baseline top 10 the operation touches", () => {
    const affected = affectedQueries(cluster, dev);
    expect(affected.map((q) => q.chunkId)).toEqual(["q1", "q2"]);
  });

  it("averages the change in reciprocal rank per family, missing ranks as zero", () => {
    const before = new Map<string, number | null>([
      ["q1", 2],
      ["q2", 4],
    ]);
    const after = new Map<string, number | null>([
      ["q1", 1],
      ["q2", null],
    ]);
    const gain = gainByFamily(dev.slice(0, 2), before, after);
    expect(gain.get("A")).toBeCloseTo(0.5, 10);
    expect(gain.get("B")).toBeCloseTo(-0.25, 10);
  });
});
