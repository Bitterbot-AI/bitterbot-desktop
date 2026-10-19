/**
 * PLAN-57 Phase 6: the default-on flip on upgrade. A node whose config has
 * no `compute` key behaves as enabled, and on an idle node (no backend, no
 * pool, nothing routed) that must cost nothing: no tool, no prompt section,
 * no state block, no compute block in working memory, no nudges.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { createComputeTool } from "../../agents/tools/compute-tool.js";
import { FIELD_DEFAULTS } from "../../config/schema.defaults.js";
import { buildWorkingMemorySynthesisPrompt } from "../../memory/working-memory-prompt.js";
import { resetComputeBackendForTest } from "./backend.js";
import { nudgeCompute, resetComputeNudgesForTest } from "./nudges.js";
import { resetComputeRuntimeForTest } from "./runtime.js";
import { resetComputeStateForTest, resolveComputeStateBlockFromConfig } from "./state.js";

const upgradedConfig = {} as Record<string, never>;

describe("upgrade to compute awareness on an idle node", () => {
  afterEach(() => {
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    resetComputeStateForTest();
    resetComputeNudgesForTest();
  });

  it("is on by default and costs nothing without a backend", () => {
    expect(FIELD_DEFAULTS["compute.enabled"]).toBe(true);
    expect(FIELD_DEFAULTS["compute.awareness.nudges"]).toBe(true);
    // No backend registered: the tool does not exist, so the prompt section does not either.
    expect(createComputeTool({ config: upgradedConfig })).toBeUndefined();
    const toolNames = ["wallet", "exec", "memory_search"];
    const before = buildAgentSystemPrompt({ workspaceDir: "/tmp/bitterbot", toolNames });
    expect(before).not.toContain("## Compute Pools");
    // The state block needs a snapshot; an upgraded config and no snapshot render nothing.
    expect(resolveComputeStateBlockFromConfig(upgradedConfig)).toBeFalsy();
    expect(resolveComputeStateBlockFromConfig({ compute: { enabled: true } })).toBeFalsy();
    // Working memory synthesis carries no compute block without facts.
    const synthesis = buildWorkingMemorySynthesisPrompt({
      oldState: "",
      scratchNotes: "",
      recentCrystals: [],
      dreamInsights: [],
      curiosityTargets: [],
      emergingSkills: [],
      hormonalState: { dopamine: 0.5, cortisol: 0.2, oxytocin: 0.4, mood: "calm" },
      timestamp: "2026-10-18T00:00:00Z",
    });
    expect(synthesis).not.toContain("## Input: Compute");
    // Nudges have no sink and no effect.
    expect(nudgeCompute({ kind: "success", reason: "x" })).toBe(false);
  });

  it("turns everything off with the one kill switch", () => {
    expect(createComputeTool({ config: { compute: { enabled: false } } })).toBeUndefined();
    expect(resolveComputeStateBlockFromConfig({ compute: { enabled: false } })).toBeFalsy();
  });
});
