import { describe, expect, it } from "vitest";
import { DEFAULT_DREAM_CONFIG, DEFAULT_MODE_CONFIGS } from "./dream-types.js";

/**
 * PLAN-34 Phase 0 established containment (research off); PLAN-40 extended
 * it: mutation is retired (paraphrase treadmill, evaluation E2) and the
 * three structurally-unfueled modes are HELD disabled behind doctor-visible
 * wake counters. The three utility lanes are the enabled replacements.
 */
describe("dream mode defaults (PLAN-34 containment + PLAN-40 retarget)", () => {
  const DISABLED = [
    "research", // PLAN-34: unfueled + ungated direct-write; PLAN-40 retires it
    "mutation", // PLAN-40 E2: 206 unread paraphrases of one skill
    "interceptor_harvest", // hold: wake at >=10 outcome-tagged records
    "harness_evolve", // hold: wake at >=25 attributed executions
    "relationship_reconsolidation", // hold: wake at >=100 active relationships
  ] as const;

  it("retired + held modes are disabled by default", () => {
    for (const mode of DISABLED) {
      expect(DEFAULT_MODE_CONFIGS[mode].enabled, `mode ${mode} should be disabled`).toBe(false);
      expect(DEFAULT_DREAM_CONFIG.modes[mode].enabled, `merged ${mode} should be disabled`).toBe(
        false,
      );
    }
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
