import { describe, expect, it, vi } from "vitest";
import type { PolicyVersionRef } from "../../agents/pi-embedded-runner/harness-policy-store.js";
import type { ScorePairFn } from "../experiment-sandbox.js";
import type { HeldOutExecution } from "../skill-execution-selection.js";
import {
  defaultHarnessPolicy,
  type HarnessPolicy,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import { runHarnessSlowUpdate } from "./harness-evolve.slow-update.js";

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

function frag(id: string): HarnessPolicy {
  const p = defaultHarnessPolicy();
  p.prompt.fragments.push({ id, text: id, order: 0 });
  return p;
}

const seeded = () => 0.5;
// a = archived, b = live. Live always WORSE → triggers rollback.
const liveWorse: ScorePairFn = async (_a, _b, sel) =>
  sel.map((e) => ({ taskId: e.id, aPassed: true, bPassed: false }));
const liveBetter: ScorePairFn = async (_a, _b, sel) =>
  sel.map((e) => ({ taskId: e.id, aPassed: false, bPassed: true }));

describe("runHarnessSlowUpdate (PLAN-25 auto-quarantine)", () => {
  it("rolls back to an archived version when live is significantly worse", async () => {
    const rollback = vi.fn(async (_v: number, _r: string) => frag("v3"));
    const history: PolicyVersionRef[] = [{ version: 3, policy: frag("v3") }];
    const res = await runHarnessSlowUpdate({
      live: frag("live"),
      history,
      selectionSet: selection(12),
      scorePair: liveWorse,
      rollback,
      options: { random: seeded, bootstrapIterations: 500 },
    });
    expect(res.rolledBackTo).toBe(3);
    expect(rollback).toHaveBeenCalledWith(3, expect.stringContaining("regression"));
  });

  it("does not roll back when live is better/equal", async () => {
    const rollback = vi.fn(async () => null);
    const res = await runHarnessSlowUpdate({
      live: frag("live"),
      history: [{ version: 3, policy: frag("v3") }],
      selectionSet: selection(12),
      scorePair: liveBetter,
      rollback,
      options: { random: seeded, bootstrapIterations: 500 },
    });
    expect(res.rolledBackTo).toBeNull();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("is inert with insufficient data or empty history", async () => {
    const rollback = vi.fn(async () => null);
    const res = await runHarnessSlowUpdate({
      live: frag("live"),
      history: [],
      selectionSet: selection(12),
      scorePair: liveWorse,
      rollback,
    });
    expect(res.rolledBackTo).toBeNull();
    expect(rollback).not.toHaveBeenCalled();
  });
});
