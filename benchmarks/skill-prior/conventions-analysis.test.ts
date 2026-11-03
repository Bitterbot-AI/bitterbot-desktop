import { describe, expect, it } from "vitest";
import {
  clusterBootstrapCi,
  holm,
  idealPickProb,
  noisyRecords,
  recordsFromTraining,
  shuffled,
  swapRecords,
} from "./conventions-analysis.js";
import type { TrialRecord } from "./executor.js";

const rec = (over: Partial<TrialRecord>): TrialRecord => ({
  key: "k",
  phase: "cv-train",
  arm: "forced-a",
  taskId: "t",
  family: "ledger-sum",
  seed: 1,
  trialIndex: 0,
  indexOrder: ["xp-ledger-sum-a"],
  pass: 1,
  read: ["xp-ledger-sum-a"],
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  wallMs: 0,
  model: "m",
  error: null,
  runId: "r",
  cell: "alder:ledger-sum",
  ...over,
});

describe("recordsFromTraining", () => {
  it("credits only runs that read the forced skill without error", () => {
    const ev = recordsFromTraining([
      rec({}),
      rec({ pass: 0 }),
      rec({ read: [] }),
      rec({ error: "boom" }),
      rec({ indexOrder: ["xp-ledger-sum-b"], read: ["xp-ledger-sum-b"], pass: 0 }),
    ]);
    expect(ev).toEqual({
      "alder:ledger-sum": {
        "xp-ledger-sum-a": { passed: 1, runs: 2 },
        "xp-ledger-sum-b": { passed: 0, runs: 1 },
      },
    });
  });
});

describe("swapRecords", () => {
  it("exchanges the right variant's record with exactly one wrong variant's", () => {
    const cell = {
      a: { passed: 2, runs: 2 },
      b: { passed: 0, runs: 2 },
      c: { passed: 0, runs: 1 },
      d: { passed: 0, runs: 2 },
    };
    const out = swapRecords(cell, "a", ["b", "c", "d"], "seed");
    expect(out.a).not.toEqual(cell.a);
    const moved = ["b", "c", "d"].filter((k) => out[k as "b"]?.passed === 2);
    expect(moved).toHaveLength(1);
    expect(out[moved[0] as "b"]).toEqual(cell.a);
    expect(swapRecords(cell, "a", ["b", "c", "d"], "seed")).toEqual(out);
  });
});

describe("holm", () => {
  it("matches the textbook step-down", () => {
    expect(holm([0.01, 0.04, 0.03, 0.2])).toEqual([0.04, 0.09, 0.09, 0.2]);
  });
});

describe("clusterBootstrapCi", () => {
  it("centres on the pooled mean and widens with between-family spread", () => {
    const tight = clusterBootstrapCi(
      new Map([
        ["f1", [0.2, 0.2]],
        ["f2", [0.2, 0.2]],
        ["f3", [0.2, 0.2]],
      ]),
    )!;
    expect(tight.mean).toBeCloseTo(0.2);
    expect(tight.hi - tight.lo).toBeLessThan(1e-9);
    const spread = clusterBootstrapCi(
      new Map([
        ["f1", [1, 1]],
        ["f2", [0, 0]],
        ["f3", [-1, -1]],
      ]),
    )!;
    expect(spread.mean).toBeCloseTo(0);
    expect(spread.hi - spread.lo).toBeGreaterThan(0.5);
  });
});

describe("shuffled", () => {
  it("is a deterministic permutation", () => {
    const xs = ["a", "b", "c", "d", "e"];
    expect(shuffled(xs, "s").toSorted()).toEqual(xs);
    expect(shuffled(xs, "s")).toEqual(shuffled(xs, "s"));
  });
});

describe("noisyRecords", () => {
  const vs = ["a", "b", "c", "d"];
  it("is exact at eps 0", () => {
    const r = noisyRecords(vs, "b", 0, 5, "s");
    expect(r.b).toEqual({ passed: 5, runs: 5 });
    expect(r.a).toEqual({ passed: 0, runs: 5 });
  });
  it("nests: higher eps only adds flips, larger n only adds runs", () => {
    for (let i = 0; i < 50; i++) {
      const lo = noisyRecords(vs, "a", 0.1, 5, `s${i}`);
      const hi = noisyRecords(vs, "a", 0.3, 5, `s${i}`);
      const big = noisyRecords(vs, "a", 0.3, 10, `s${i}`);
      expect(hi.a!.passed).toBeLessThanOrEqual(lo.a!.passed);
      for (const v of ["b", "c", "d"]) {
        expect(hi[v]!.passed).toBeGreaterThanOrEqual(lo[v]!.passed);
      }
      for (const v of vs) {
        expect(big[v]!.passed).toBeGreaterThanOrEqual(hi[v]!.passed);
        expect(big[v]!.passed - hi[v]!.passed).toBeLessThanOrEqual(5);
      }
    }
  });
  it("flip rate tracks eps", () => {
    let flips = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const r = noisyRecords(vs, "a", 0.3, 5, `t${i}`);
      flips += 5 - r.a!.passed + r.b!.passed + r.c!.passed + r.d!.passed;
      total += 20;
    }
    expect(flips / total).toBeGreaterThan(0.27);
    expect(flips / total).toBeLessThan(0.33);
  });
});

describe("idealPickProb", () => {
  it("handles unique best, ties and inversions", () => {
    const e = (passed: number) => ({ passed, runs: 5 });
    expect(idealPickProb({ a: e(4), b: e(1), c: e(0), d: e(2) }, "a")).toBe(1);
    expect(idealPickProb({ a: e(3), b: e(3), c: e(0), d: e(2) }, "a")).toBe(0.5);
    expect(idealPickProb({ a: e(2), b: e(3), c: e(0), d: e(2) }, "a")).toBe(0);
    expect(idealPickProb({}, "a")).toBe(0);
  });
});
