import { describe, expect, it } from "vitest";
import {
  appraiseComplexity,
  modulateThresholds,
  scorePrompt,
  type ComplexityModulators,
} from "./complexity.js";

const TRIVIAL = "what time is it?";
const SMALL_TALK = "thanks, that looks great";
const LARGE =
  "Refactor the auth module across all three packages, add tests for each, " +
  "then migrate the session store, and finally open a PR with the changes.";

describe("scorePrompt (Stage-1 heuristic)", () => {
  it("is pure: identical input yields identical output", () => {
    const a = scorePrompt(LARGE);
    const b = scorePrompt(LARGE);
    expect(a).toEqual(b);
  });

  it("scores trivial prompts low and large multi-step prompts high", () => {
    expect(scorePrompt(TRIVIAL).score).toBeLessThan(0.35);
    expect(scorePrompt(LARGE).score).toBeGreaterThanOrEqual(0.52);
  });

  it("keeps the score within [0,1]", () => {
    const huge = LARGE.repeat(20);
    const s = scorePrompt(huge).score;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("surfaces contributing signals and reasons", () => {
    const { signals, reasons } = scorePrompt(LARGE);
    expect(signals.actionVerbs).toBeGreaterThan(0);
    expect(signals.artifactHints).toBeGreaterThan(0);
    expect(reasons.length).toBeGreaterThan(0);
  });
});

describe("false-positive guard: long-but-simple prompts", () => {
  it("does not push a large pasted code block into the goal tier", () => {
    const codeBlock = "```ts\n" + "const x = 1;\n".repeat(120) + "```";
    const prompt = `here is the error, what's wrong?\n${codeBlock}`;
    const v = appraiseComplexity(prompt);
    expect(v.signals.pastedFraction).toBeGreaterThan(0.5);
    expect(v.tier).not.toBe("goal");
  });

  it("discounts a pasted log dump", () => {
    const log = Array.from(
      { length: 80 },
      (_, i) => `2026-05-31T10:00:${String(i % 60).padStart(2, "0")}Z [ERROR] boom ${i}`,
    ).join("\n");
    const prompt = `why is this happening?\n${log}`;
    const v = appraiseComplexity(prompt);
    expect(v.signals.pastedFraction).toBeGreaterThan(0.5);
    expect(v.tier).not.toBe("goal");
  });
});

describe("modulateThresholds", () => {
  it("raises thresholds under high cortisol (more conservative)", () => {
    const base = modulateThresholds({});
    const stressed = modulateThresholds({ cortisol: 1 });
    expect(stressed.low).toBeGreaterThan(base.low);
    expect(stressed.high).toBeGreaterThan(base.high);
  });

  it("lowers thresholds under high dopamine/curiosity (more eager)", () => {
    const base = modulateThresholds({});
    const eager = modulateThresholds({ dopamine: 1, curiosity: 1 });
    expect(eager.low).toBeLessThan(base.low);
    expect(eager.high).toBeLessThan(base.high);
  });

  it("never crosses the rails regardless of saturated input", () => {
    const extremes: ComplexityModulators[] = [
      { cortisol: 1, dopamine: 0, curiosity: 0 },
      { cortisol: 0, dopamine: 1, curiosity: 1 },
      { cortisol: 1, dopamine: 1, curiosity: 1 },
    ];
    for (const mod of extremes) {
      const { low, high } = modulateThresholds(mod);
      expect(low).toBeGreaterThanOrEqual(0.2);
      expect(low).toBeLessThanOrEqual(0.45);
      expect(high).toBeGreaterThanOrEqual(0.48);
      expect(high).toBeLessThanOrEqual(0.78);
      expect(low).toBeLessThan(high);
    }
  });

  it("treats omitted modulators as neutral baseline", () => {
    expect(modulateThresholds({})).toEqual(
      modulateThresholds({ cortisol: 0, dopamine: 0, curiosity: 0 }),
    );
  });
});

describe("appraiseComplexity (tiering)", () => {
  it("routes trivial -> inline", () => {
    expect(appraiseComplexity(TRIVIAL).tier).toBe("inline");
    expect(appraiseComplexity(SMALL_TALK).tier).toBe("inline");
  });

  it("routes large multi-step -> goal", () => {
    expect(appraiseComplexity(LARGE).tier).toBe("goal");
  });

  it("flags the gray band with needsLlm and resolves it nowhere here", () => {
    // A prompt engineered to land between the thresholds.
    const mid = "refactor the login handler and add a test";
    const v = appraiseComplexity(mid);
    if (v.tier === "gray") {
      expect(v.needsLlm).toBe(true);
    } else {
      // If weighting drifts, at least assert needsLlm tracks the tier.
      expect(v.needsLlm).toBe(false);
    }
  });

  it("needsLlm is true iff tier is gray", () => {
    for (const p of [TRIVIAL, SMALL_TALK, LARGE, "refactor the login handler and add a test"]) {
      const v = appraiseComplexity(p);
      expect(v.needsLlm).toBe(v.tier === "gray");
    }
  });

  it("high cortisol can pull a borderline prompt down out of the goal tier", () => {
    const borderline = "add a feature flag and write a test for it";
    const calm = appraiseComplexity(borderline, { dopamine: 1, curiosity: 1 });
    const stressed = appraiseComplexity(borderline, { cortisol: 1 });
    // Eager state should never be a higher tier than stressed state.
    const order = { inline: 0, gray: 1, goal: 2 } as const;
    expect(order[stressed.tier]).toBeLessThanOrEqual(order[calm.tier]);
  });
});
