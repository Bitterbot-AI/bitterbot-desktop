/**
 * PLAN-45 Phase 3.3: monitor statistics.
 */

import { describe, expect, it } from "vitest";
import { inCanaryBucket } from "../../agents/skills/canary-registry.js";
import { decideCanary, fisherExposedWorse } from "./canary-stats.js";

const DAY = 24 * 60 * 60 * 1000;

describe("fisherExposedWorse", () => {
  it("matches known one-sided values", () => {
    // Exposed 1/8 pass vs unexposed 7/8 pass: strongly worse.
    const strong = fisherExposedWorse({ n: 8, pass: 1 }, { n: 8, pass: 7 });
    expect(strong.pValue).toBeLessThan(0.01);
    expect(strong.gap).toBeCloseTo(-0.75);
    // Equal rates: not significant.
    const equal = fisherExposedWorse({ n: 8, pass: 4 }, { n: 8, pass: 4 });
    expect(equal.pValue).toBeGreaterThan(0.5);
    // Exposed better: one-sided p near 1.
    const better = fisherExposedWorse({ n: 8, pass: 8 }, { n: 8, pass: 2 });
    expect(better.pValue).toBeCloseTo(1, 5);
    // Empty cohort: p = 1.
    expect(fisherExposedWorse({ n: 0, pass: 0 }, { n: 8, pass: 4 }).pValue).toBe(1);
    // Classic 2x2: exposed 2/10 vs unexposed 8/10 -> p ~= 0.0115 one-sided.
    expect(fisherExposedWorse({ n: 10, pass: 2 }, { n: 10, pass: 8 }).pValue).toBeCloseTo(
      0.0115,
      3,
    );
  });
});

describe("decideCanary", () => {
  const base = { startedAt: 0, now: 3 * DAY, exposedEligible: 12, reads: 9 };
  it("rolls back a significant regression at a fresh checkpoint, at the per-look alpha", () => {
    const d = decideCanary({
      ...base,
      exposed: { n: 9, pass: 1 },
      unexposed: { n: 10, pass: 9 },
    });
    expect(d.action).toBe("rollback");
    expect(d.reason).toContain("look 8");
    expect(d.action === "rollback" && d.checkpoint).toBe(8);
    // The same look is never repeated: with checkpoint 8 consumed and n
    // still below 16, the pass only watches (adversarial 3-5).
    const again = decideCanary({
      ...base,
      exposed: { n: 9, pass: 1 },
      unexposed: { n: 10, pass: 9 },
      checkpointsDone: [8],
    });
    expect(again.action).toBe("continue");
    expect(again.action === "continue" && again.checkpoint).toBeUndefined();
    // A borderline table that clears 0.05 but not 0.0125 does not roll back.
    const borderline = decideCanary({
      ...base,
      exposed: { n: 8, pass: 3 },
      unexposed: { n: 8, pass: 7 },
    });
    expect(borderline.action).toBe("continue");
    expect(borderline.action === "continue" && borderline.checkpoint).toBe(8);
  });
  it("keeps watching with too little evidence, too little control, or no regression", () => {
    expect(
      decideCanary({ ...base, exposed: { n: 3, pass: 0 }, unexposed: { n: 10, pass: 9 } }).action,
    ).toBe("continue");
    // Not enough control runs: the look is NOT consumed.
    const noControl = decideCanary({
      ...base,
      exposed: { n: 9, pass: 1 },
      unexposed: { n: 3, pass: 3 },
    });
    expect(noControl.action).toBe("continue");
    expect(noControl.action === "continue" && noControl.checkpoint).toBeUndefined();
    expect(
      decideCanary({ ...base, exposed: { n: 9, pass: 8 }, unexposed: { n: 10, pass: 8 } }).action,
    ).toBe("continue");
  });
  it("retires a canary that is never read across many eligible exposures or by the max age", () => {
    expect(
      decideCanary({
        ...base,
        exposedEligible: 20,
        reads: 0,
        exposed: { n: 18, pass: 15 },
        unexposed: { n: 10, pass: 8 },
      }).action,
    ).toBe("retire");
    expect(
      decideCanary({
        ...base,
        now: 29 * DAY,
        exposedEligible: 3,
        reads: 0,
        exposed: { n: 2, pass: 2 },
        unexposed: { n: 1, pass: 1 },
      }).action,
    ).toBe("retire");
  });
  it("graduates only with evidence: reads and >= 8 determinate exposed runs (adversarial 3-4)", () => {
    const byRuns = decideCanary({
      ...base,
      exposedEligible: 20,
      exposed: { n: 9, pass: 8 },
      unexposed: { n: 10, pass: 8 },
    });
    expect(byRuns.action).toBe("graduate");
    // Fourteen idle days with two determinate runs is not evidence.
    const idle = decideCanary({
      ...base,
      now: 15 * DAY,
      exposedEligible: 5,
      exposed: { n: 2, pass: 2 },
      unexposed: { n: 3, pass: 2 },
    });
    expect(idle.action).toBe("continue");
    // At the max age, read evidence graduates and says it is thin.
    const maxAge = decideCanary({
      ...base,
      now: 29 * DAY,
      exposedEligible: 5,
      reads: 2,
      exposed: { n: 2, pass: 2 },
      unexposed: { n: 3, pass: 2 },
    });
    expect(maxAge.action).toBe("graduate");
    expect(maxAge.reason).toContain("thin evidence");
    // A regression inside the window still wins over graduation.
    const regressed = decideCanary({
      ...base,
      exposedEligible: 25,
      exposed: { n: 9, pass: 1 },
      unexposed: { n: 10, pass: 9 },
    });
    expect(regressed.action).toBe("rollback");
  });
});

describe("inCanaryBucket", () => {
  it("is deterministic per (run, skill, seed) and roughly proportional", () => {
    expect(inCanaryBucket("run-1", "skill-a", 0.5, "s")).toBe(
      inCanaryBucket("run-1", "skill-a", 0.5, "s"),
    );
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      if (inCanaryBucket(`run-${i}`, "skill-a", 0.5, "s")) hits += 1;
    }
    expect(hits).toBeGreaterThan(850);
    expect(hits).toBeLessThan(1150);
    expect(inCanaryBucket("run-1", "skill-a", 1, "s")).toBe(true);
    expect(inCanaryBucket("run-1", "skill-a", 0, "s")).toBe(false);
  });
});
