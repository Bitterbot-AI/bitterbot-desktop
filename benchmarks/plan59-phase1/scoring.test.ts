import { describe, expect, it } from "vitest";
import {
  channelRanks,
  familyMeans,
  pairedFamilyBootstrap,
  type QueryOutcome,
  type RankedResult,
  rankOf,
  summarize,
} from "./scoring.js";
import { question } from "./test-support.js";

const gold = question("g", "sessions/a.jsonl", 10, 15);
const r = (path: string, start: number, end: number, id: string | null): RankedResult => ({
  path,
  startLine: start,
  endLine: end,
  id,
});

describe("rankOf", () => {
  it("counts a raw hit by path and overlapping lines, like live-recall run.mts", () => {
    const results = [
      r("memory/x.md", 0, 0, "x"),
      r("sessions/a.jsonl", 14, 20, "g2"),
      r("sessions/a.jsonl", 10, 15, "g"),
    ];
    expect(rankOf(results, gold, null)).toEqual({ raw: 2, mapped: 2 });
    expect(rankOf([r("sessions/a.jsonl", 16, 20, "n")], gold, null)).toEqual({
      raw: null,
      mapped: null,
    });
  });

  it("maps a returned parent to a hit for its member while the raw rank stays a miss", () => {
    const results = [
      r("memory/x.md", 0, 0, "x"),
      r("sessions/a.jsonl", -1, -1, "parent"),
      r("sessions/a.jsonl", 10, 15, "g"),
    ];
    expect(rankOf(results, gold, "parent")).toEqual({ raw: 3, mapped: 2 });
    expect(rankOf(results.slice(0, 2), gold, "parent")).toEqual({ raw: null, mapped: 2 });
    // an unresolved id never matches the parent
    expect(rankOf([r("sessions/a.jsonl", -1, -1, null)], gold, "parent")).toEqual({
      raw: null,
      mapped: null,
    });
  });

  it("ranks each channel by its own order", () => {
    const results: RankedResult[] = [
      { ...r("memory/x.md", 0, 0, "x"), channels: { vector: { rank: 1 }, keyword: { rank: 2 } } },
      {
        ...r("sessions/a.jsonl", 10, 15, "g"),
        channels: { vector: { rank: 2 }, keyword: { rank: 1 } },
      },
    ];
    expect(channelRanks(results, gold, null)).toEqual({ vector: 2, keyword: 1, graph: null });
  });
});

const outcome = (
  family: string,
  mapped: number | null,
  raw: number | null = mapped,
  top1: string | null = family,
): QueryOutcome => ({
  chunkId: `${family}-${mapped}`,
  family,
  rawRank: raw,
  mappedRank: mapped,
  channelRanks: { vector: mapped, keyword: null, graph: null },
  topTenIds: [],
  topOneFamily: top1,
  returned: mapped === null ? 0 : 10,
  latencyMs: 100,
});

describe("summarize", () => {
  it("computes MRR, recall, coverage and the wrong-answer proxy", () => {
    const s = summarize([
      outcome("A", 1),
      outcome("A", 4, 8),
      outcome("B", 12, 12, "C"),
      outcome("C", null, null, null),
    ]);
    expect(s.n).toBe(4);
    expect(s.families).toBe(3);
    expect(s.mrr).toBeCloseTo((1 + 0.25 + 1 / 12 + 0) / 4, 10);
    expect(s.rawMrr).toBeCloseTo((1 + 0.125 + 1 / 12 + 0) / 4, 10);
    expect(s.r1).toBe(0.25);
    expect(s.r5).toBe(0.5);
    expect(s.coverage10).toBe(0.5);
    expect(s.wrongAnswerProxy).toBe(0.25);
    expect(s.emptyShare).toBe(0.25);
    expect(s.channels.vector.r5).toBe(0.5);
  });
});

describe("pairedFamilyBootstrap", () => {
  const a = familyMeans(
    [outcome("A", 1), outcome("A", 2), outcome("B", 5), outcome("C", null)],
    (o) => (o.mappedRank === null ? 0 : 1 / o.mappedRank),
  );
  const b = familyMeans(
    [outcome("A", 2), outcome("A", 2), outcome("B", 10), outcome("C", null)],
    (o) => (o.mappedRank === null ? 0 : 1 / o.mappedRank),
  );

  it("pairs by family and is reproducible under a seed", () => {
    const c1 = pairedFamilyBootstrap(a, b, { seed: "s", resamples: 500 });
    const c2 = pairedFamilyBootstrap(a, b, { seed: "s", resamples: 500 });
    expect(c1).toEqual(c2);
    expect(c1.families).toBe(3);
    // A: 0.75 - 0.5 = 0.25; B: 0.2 - 0.1 = 0.1; C: 0 -> mean 0.11667
    expect(c1.estimate).toBeCloseTo((0.25 + 0.1 + 0) / 3, 10);
    expect(c1.familiesUp).toBe(2);
    expect(c1.familiesDown).toBe(0);
    expect(c1.ci95[0]).toBeLessThanOrEqual(c1.estimate);
    expect(c1.ci95[1]).toBeGreaterThanOrEqual(c1.estimate);
    const c3 = pairedFamilyBootstrap(a, b, { seed: "t", resamples: 500 });
    expect(c3.estimate).toBe(c1.estimate);
    expect(c3.ci95).not.toEqual(c1.ci95);
  });

  it("is antisymmetric and handles the empty case", () => {
    const ab = pairedFamilyBootstrap(a, b, { seed: "s" });
    const ba = pairedFamilyBootstrap(b, a, { seed: "s" });
    expect(ba.estimate).toBeCloseTo(-ab.estimate, 10);
    expect(pairedFamilyBootstrap(new Map(), new Map(), { seed: "s" }).families).toBe(0);
  });
});
