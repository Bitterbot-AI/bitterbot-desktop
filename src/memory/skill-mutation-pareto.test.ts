/**
 * Unit tests for the PLAN-21 Phase B Pareto pool ranker + cosine-decay budget.
 */
import { describe, it, expect } from "vitest";
import {
  cosineDecayBudget,
  defaultPlan21Axes,
  defaultPlan21TieBreak,
  type MutationPoolCandidate,
  paretoFront,
  type ParetoAxis,
  selectTopL,
} from "./skill-mutation-pareto.js";

describe("cosineDecayBudget", () => {
  it("returns the initial value at cycle 0", () => {
    expect(cosineDecayBudget(0)).toBe(4);
  });

  it("monotonically decays toward the floor", () => {
    const values: number[] = [];
    for (let t = 0; t <= 100; t += 5) {
      values.push(cosineDecayBudget(t));
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  it("respects the floor for very mature skills", () => {
    expect(cosineDecayBudget(1000)).toBe(2);
    expect(cosineDecayBudget(10000)).toBe(2);
  });

  it("respects custom initial/floor/halfLife overrides", () => {
    const b = cosineDecayBudget(50, { initial: 10, floor: 1, halfLifeCycles: 25 });
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThan(10);
  });

  it("treats negative cycles as the initial value", () => {
    expect(cosineDecayBudget(-5)).toBe(4);
  });
});

describe("paretoFront", () => {
  interface Pt {
    name: string;
    x: number; // max
    y: number; // max
  }

  const axes2: ParetoAxis<Pt>[] = [
    { name: "x", direction: "max", value: (c) => c.x },
    { name: "y", direction: "max", value: (c) => c.y },
  ];

  it("returns all points when none dominate", () => {
    // Anti-diagonal: each point trades x for y.
    const pts: Pt[] = [
      { name: "a", x: 1, y: 4 },
      { name: "b", x: 2, y: 3 },
      { name: "c", x: 3, y: 2 },
      { name: "d", x: 4, y: 1 },
    ];
    const front = paretoFront(pts, axes2);
    expect(front.length).toBe(4);
  });

  it("drops dominated points", () => {
    const pts: Pt[] = [
      { name: "a", x: 3, y: 3 }, // dominated by c
      { name: "b", x: 1, y: 5 },
      { name: "c", x: 4, y: 4 },
      { name: "d", x: 5, y: 1 },
    ];
    const front = paretoFront(pts, axes2);
    const names = front.map((p) => p.name);
    expect(names).toContain("b");
    expect(names).toContain("c");
    expect(names).toContain("d");
    expect(names).not.toContain("a");
  });

  it("handles a mix of max and min axes", () => {
    interface P {
      n: string;
      benefit: number; // max
      cost: number; // min
    }
    const pts: P[] = [
      { n: "cheap-bad", benefit: 1, cost: 1 },
      { n: "mid", benefit: 3, cost: 2 },
      { n: "exp-good", benefit: 5, cost: 5 },
      { n: "exp-bad", benefit: 2, cost: 6 }, // dominated by mid
    ];
    const front = paretoFront(pts, [
      { name: "benefit", direction: "max", value: (p) => p.benefit },
      { name: "cost", direction: "min", value: (p) => p.cost },
    ]);
    const names = front.map((p) => p.n);
    expect(names).not.toContain("exp-bad");
    expect(names).toContain("cheap-bad");
    expect(names).toContain("mid");
    expect(names).toContain("exp-good");
  });

  it("excludes candidates that fail an axis floor", () => {
    const axes: ParetoAxis<Pt>[] = [
      { name: "x", direction: "max", value: (c) => c.x, floor: 2 },
      { name: "y", direction: "max", value: (c) => c.y },
    ];
    const pts: Pt[] = [
      { name: "below-floor", x: 1, y: 10 }, // would dominate everything on y, but x < 2
      { name: "above-floor", x: 3, y: 5 },
    ];
    const front = paretoFront(pts, axes);
    expect(front.map((p) => p.name)).toEqual(["above-floor"]);
  });

  it("preserves input order on the front", () => {
    const pts: Pt[] = [
      { name: "first", x: 5, y: 1 },
      { name: "second", x: 1, y: 5 },
      { name: "third", x: 3, y: 3 },
    ];
    const front = paretoFront(pts, axes2);
    // first and second are non-dominated; third dominated by neither (3,3) vs (5,1) (5≥3 but 1<3)
    expect(front.map((p) => p.name)).toEqual(["first", "second", "third"]);
  });
});

describe("selectTopL", () => {
  it("returns all entries when L >= front.length", () => {
    expect(selectTopL([1, 2, 3], 5, (n) => n).length).toBe(3);
  });

  it("returns an empty array when L <= 0", () => {
    expect(selectTopL([1, 2, 3], 0, (n) => n)).toEqual([]);
    expect(selectTopL([1, 2, 3], -1, (n) => n)).toEqual([]);
  });

  it("clips to L entries by tie-break score", () => {
    const out = selectTopL([1, 5, 3, 2, 4], 2, (n) => n);
    expect(out).toEqual([5, 4]);
  });

  it("is stable on equal tie-break scores (input order preserved)", () => {
    interface E {
      id: string;
      score: number;
    }
    const entries: E[] = [
      { id: "a", score: 5 },
      { id: "b", score: 5 },
      { id: "c", score: 5 },
      { id: "d", score: 1 },
    ];
    const out = selectTopL(entries, 2, (e) => e.score);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("PLAN-21 axes (delta / faithfulness / tokenDelta)", () => {
  interface Candidate extends MutationPoolCandidate {
    label: string;
  }

  it("excludes candidates that fail faithfulness floor", () => {
    const pool: Candidate[] = [
      { label: "kept", delta: 0.2, faithfulnessMargin: 1.0, tokenDelta: 50 },
      { label: "dropped", delta: 0.5, faithfulnessMargin: 0.3, tokenDelta: -100 },
    ];
    const front = paretoFront(pool, defaultPlan21Axes<Candidate>());
    expect(front.map((p) => p.label)).toEqual(["kept"]);
  });

  it("excludes candidates with negative delta", () => {
    const pool: Candidate[] = [
      { label: "ok", delta: 0.1, faithfulnessMargin: 1.0, tokenDelta: 0 },
      { label: "regression", delta: -0.05, faithfulnessMargin: 1.0, tokenDelta: -50 },
    ];
    const front = paretoFront(pool, defaultPlan21Axes<Candidate>());
    expect(front.map((p) => p.label)).toEqual(["ok"]);
  });

  it("favors compression over growth at equal delta and faithfulness", () => {
    const pool: Candidate[] = [
      { label: "compressed", delta: 0.2, faithfulnessMargin: 1.0, tokenDelta: -100 },
      { label: "grown", delta: 0.2, faithfulnessMargin: 1.0, tokenDelta: +100 },
    ];
    const front = paretoFront(pool, defaultPlan21Axes<Candidate>());
    // 'compressed' dominates 'grown' on tokenDelta with equal delta and faithfulness.
    expect(front.map((p) => p.label)).toEqual(["compressed"]);
  });

  it("end-to-end ranks a realistic pool by delta after Pareto-then-clip", () => {
    const pool: Candidate[] = [
      { label: "big-grow-big-win", delta: 0.4, faithfulnessMargin: 1.0, tokenDelta: 300 },
      { label: "small-grow-small-win", delta: 0.1, faithfulnessMargin: 0.8, tokenDelta: 50 },
      { label: "compress-medium-win", delta: 0.25, faithfulnessMargin: 1.0, tokenDelta: -150 },
      { label: "unfaithful", delta: 0.5, faithfulnessMargin: 0.3, tokenDelta: 0 },
      { label: "regression", delta: -0.1, faithfulnessMargin: 1.0, tokenDelta: 0 },
    ];
    const front = paretoFront(pool, defaultPlan21Axes<Candidate>());
    // unfaithful and regression excluded by floors.
    expect(front.map((p) => p.label)).not.toContain("unfaithful");
    expect(front.map((p) => p.label)).not.toContain("regression");
    const top = selectTopL(front, 2, defaultPlan21TieBreak<Candidate>());
    expect(top.length).toBeLessThanOrEqual(2);
    // Top picks should not include outright dominated ones.
    expect(top.map((p) => p.label)).toContain("big-grow-big-win");
  });
});
