import { describe, expect, it } from "vitest";
import { DEFAULT_DREAM_CONFIG, DEFAULT_MODE_CONFIGS } from "./dream-types.js";

describe("dream mode defaults (PLAN-34 Phase 0 containment)", () => {
  it("research mode is disabled by default (unfueled + ungated direct-write)", () => {
    expect(DEFAULT_MODE_CONFIGS.research.enabled).toBe(false);
    expect(DEFAULT_DREAM_CONFIG.modes.research.enabled).toBe(false);
  });

  it("every other mode stays enabled", () => {
    for (const [mode, cfg] of Object.entries(DEFAULT_MODE_CONFIGS)) {
      if (mode === "research") {
        continue;
      }
      expect(cfg.enabled, `mode ${mode} should stay enabled`).toBe(true);
    }
  });
});
