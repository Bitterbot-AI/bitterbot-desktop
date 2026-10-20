/**
 * Paired bootstrap CI (salvaged from the retired PLAN-21 sandbox suite in
 * PLAN-45 Phase 1). `bootstrapPairedCI` is the only statistical surface
 * harness-evolve still consumes from experiment-sandbox.ts, together with
 * the paired-judge response parser.
 */

import { describe, it, expect } from "vitest";
import { bootstrapPairedCI, __testing } from "./experiment-sandbox.js";
import { hashBucket, isHeldOut } from "./skill-execution-selection.js";

/** Tiny deterministic LCG so the bootstrap is reproducible in tests. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("bootstrapPairedCI", () => {
  it("returns zeros for an empty input", () => {
    const r = bootstrapPairedCI([], 100, seededRng(1));
    expect(r.delta).toBe(0);
    expect(r.ci95Low).toBe(0);
    expect(r.ci95High).toBe(0);
    expect(r.nPaired).toBe(0);
  });

  it("computes a CI that brackets a strongly positive delta", () => {
    // 12 trials, B passes on every A failure: delta = +12/12 = 1.0
    const paired = Array.from({ length: 12 }, () => ({
      executionId: "x",
      originalPassed: false,
      mutatedPassed: true,
    }));
    const r = bootstrapPairedCI(paired, 500, seededRng(99));
    expect(r.nPaired).toBe(12);
    expect(r.delta).toBe(1);
    expect(r.ci95Low).toBeGreaterThan(0.5);
    expect(r.ci95High).toBeCloseTo(1, 5);
  });

  it("returns a CI that straddles zero for ambiguous data", () => {
    const paired = [
      { executionId: "a", originalPassed: true, mutatedPassed: true },
      { executionId: "b", originalPassed: false, mutatedPassed: false },
      { executionId: "c", originalPassed: true, mutatedPassed: false },
      { executionId: "d", originalPassed: false, mutatedPassed: true },
    ];
    const r = bootstrapPairedCI(paired, 500, seededRng(3));
    expect(r.ci95Low).toBeLessThanOrEqual(0);
    expect(r.ci95High).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic under the same seed", () => {
    const paired = Array.from({ length: 8 }, (_, i) => ({
      executionId: `e${i}`,
      originalPassed: i % 2 === 0,
      mutatedPassed: i < 6,
    }));
    const a = bootstrapPairedCI(paired, 200, seededRng(42));
    const b = bootstrapPairedCI(paired, 200, seededRng(42));
    expect(a.ci95Low).toBe(b.ci95Low);
    expect(a.ci95High).toBe(b.ci95High);
  });
});

describe("paired-judge response parser", () => {
  it("rejects malformed input", () => {
    expect(__testing.parsePerformanceResponse("not json")).toBeNull();
    expect(__testing.parsePerformanceResponse(JSON.stringify({ trials: "wrong" }))).toBeNull();
    expect(__testing.parsePerformanceResponse(JSON.stringify({ trials: [] }))).toBeNull();
  });

  it("accepts a minimal fenced payload", () => {
    const parsed = __testing.parsePerformanceResponse(
      '```json\n{"trials":[{"index":1,"originalPassed":true,"mutatedPassed":false}]}\n```',
    );
    expect(parsed?.trials).toEqual([{ index: 1, originalPassed: true, mutatedPassed: false }]);
  });
});

describe("held-out hash partition", () => {
  it("isHeldOut is deterministic and respects the fraction", () => {
    expect(isHeldOut("abc", 0.2)).toBe(isHeldOut("abc", 0.2));
    expect(isHeldOut("abc", 0)).toBe(false);
    expect(isHeldOut("abc", 1)).toBe(true);
  });

  it("hashBucket returns a value in [0, 99]", () => {
    for (let i = 0; i < 50; i++) {
      const b = hashBucket(`id-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });
});
