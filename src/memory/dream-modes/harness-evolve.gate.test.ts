import { describe, expect, it } from "vitest";
import type { ScorePairFn } from "../experiment-sandbox.js";
import type { HeldOutExecution } from "../skill-execution-selection.js";
import {
  defaultHarnessPolicy,
  type HarnessPolicy,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import { evaluateHarnessCandidate } from "./harness-evolve.gate.js";

function selection(n: number): HeldOutExecution[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    skillId: "sk",
    sessionId: "s",
    completedAt: i,
    success: true,
    rewardScore: null,
    errorType: null,
    contextJson: "{}",
  }));
}

function fragPolicy(id: string, text: string): HarnessPolicy {
  const p = defaultHarnessPolicy();
  p.prompt.fragments.push({ id, text, order: 0 });
  return p;
}

const candidateAlwaysBetter: ScorePairFn = async (_a, _b, sel) =>
  sel.map((e) => ({ taskId: e.id, aPassed: false, bPassed: true }));
const noDifference: ScorePairFn = async (_a, _b, sel) =>
  sel.map((e) => ({ taskId: e.id, aPassed: true, bPassed: true }));

const seeded = () => 0.5;

describe("evaluateHarnessCandidate (PLAN-25 gate)", () => {
  it("accepts a minimal candidate that wins with 95% confidence", async () => {
    const v = await evaluateHarnessCandidate({
      live: defaultHarnessPolicy(),
      candidate: fragPolicy("f1", "route entity queries to the graph"),
      selectionSet: selection(12),
      scorePair: candidateAlwaysBetter,
      options: { random: seeded, bootstrapIterations: 500 },
    });
    expect(v.accepted).toBe(true);
    expect(v.reason).toBe("accepted");
    expect(v.statistical?.ci95Low).toBeGreaterThan(0);
  });

  it("rejects a no-op (identical policy)", async () => {
    const v = await evaluateHarnessCandidate({
      live: defaultHarnessPolicy(),
      candidate: defaultHarnessPolicy(),
      selectionSet: selection(12),
      scorePair: candidateAlwaysBetter,
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("no-op");
  });

  it("rejects when there is no measurable improvement", async () => {
    const v = await evaluateHarnessCandidate({
      live: defaultHarnessPolicy(),
      candidate: fragPolicy("f1", "x"),
      selectionSet: selection(12),
      scorePair: noDifference,
      options: { random: seeded },
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("no-improvement");
  });

  it("rejects with insufficient held-out data", async () => {
    const v = await evaluateHarnessCandidate({
      live: defaultHarnessPolicy(),
      candidate: fragPolicy("f1", "x"),
      selectionSet: selection(3),
      scorePair: candidateAlwaysBetter,
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("insufficient-data");
  });

  it("rejects removal of a protected fragment (faithfulness)", async () => {
    const live = fragPolicy("safety:cite", "always cite sources");
    const candidate = fragPolicy("other", "be terse"); // drops safety:cite
    const v = await evaluateHarnessCandidate({
      live,
      candidate,
      selectionSet: selection(12),
      scorePair: candidateAlwaysBetter,
      options: { protectedFragmentIds: new Set(["safety:cite"]) },
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("faithfulness-removed-protected");
  });

  it("rejects non-minimal candidates", async () => {
    const candidate = defaultHarnessPolicy();
    for (let i = 0; i < 10; i++)
      candidate.prompt.fragments.push({ id: `f${i}`, text: "x", order: i });
    const v = await evaluateHarnessCandidate({
      live: defaultHarnessPolicy(),
      candidate,
      selectionSet: selection(12),
      scorePair: candidateAlwaysBetter,
      options: { maxChanges: 3 },
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not-minimal");
  });
});
