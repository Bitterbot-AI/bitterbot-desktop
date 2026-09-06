import { describe, expect, it } from "vitest";
import { DEFAULT_DREAM_CONFIG, DEFAULT_MODE_CONFIGS } from "./dream-types.js";

/**
 * PLAN-40 HELD the three structurally-unfueled modes disabled behind
 * doctor-visible wake counters; the three utility lanes are the enabled
 * replacements. (`research` and `mutation`, formerly on this list, were
 * deleted outright in PLAN-45 Phase 1.)
 */
describe("dream mode defaults (PLAN-40 holds + PLAN-45 retirement)", () => {
  const DISABLED = [
    "interceptor_harvest", // hold: wake at >=10 outcome-tagged records
    "harness_evolve", // hold: wake at >=25 attributed executions
    "relationship_reconsolidation", // hold: wake at >=100 active relationships
  ] as const;

  it("held modes are disabled by default", () => {
    for (const mode of DISABLED) {
      expect(DEFAULT_MODE_CONFIGS[mode].enabled, `mode ${mode} should be disabled`).toBe(false);
      expect(DEFAULT_DREAM_CONFIG.modes[mode].enabled, `merged ${mode} should be disabled`).toBe(
        false,
      );
    }
  });

  it("the retired producers are gone from the mode table", () => {
    expect("mutation" in DEFAULT_MODE_CONFIGS).toBe(false);
    expect("research" in DEFAULT_MODE_CONFIGS).toBe(false);
  });

  it("every other mode - including the three PLAN-40 lanes - stays enabled", () => {
    for (const [mode, cfg] of Object.entries(DEFAULT_MODE_CONFIGS)) {
      if ((DISABLED as readonly string[]).includes(mode)) {
        continue;
      }
      expect(cfg.enabled, `mode ${mode} should stay enabled`).toBe(true);
    }
    expect(DEFAULT_MODE_CONFIGS.hygiene.enabled).toBe(true);
    expect(DEFAULT_MODE_CONFIGS.distillation.enabled).toBe(true);
    expect(DEFAULT_MODE_CONFIGS.anticipation.enabled).toBe(true);
  });
});
