import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { harnessEvolveEnabled } from "./feature-switches.js";
import { FIELD_DEFAULTS, UNSET_MEANS_FALSE } from "./schema.defaults.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";

/** PLAN-64 Phase 6: agents.defaults.harnessEvolve.evaluation and maxTrialTurnsPerCycle. */
describe("agents.defaults.harnessEvolve replay settings", () => {
  it("the mode stays off by default", () => {
    expect(harnessEvolveEnabled(undefined)).toBe(false);
    expect(harnessEvolveEnabled({})).toBe(false);
    expect(harnessEvolveEnabled({ evaluation: "replay", maxTrialTurnsPerCycle: 40 })).toBe(false);
    expect(UNSET_MEANS_FALSE["agents.defaults.harnessEvolve.enabled"]).toBeTruthy();
  });

  it("defaults to replay with 40 trial turns, documented in every schema file", () => {
    expect(FIELD_DEFAULTS["agents.defaults.harnessEvolve.evaluation"]).toBe("replay");
    expect(FIELD_DEFAULTS["agents.defaults.harnessEvolve.maxTrialTurnsPerCycle"]).toBe(40);
    for (const key of [
      "agents.defaults.harnessEvolve.evaluation",
      "agents.defaults.harnessEvolve.maxTrialTurnsPerCycle",
    ]) {
      expect(FIELD_LABELS[key], key).toBeTruthy();
      expect(FIELD_HELP[key], key).toBeTruthy();
      expect(FIELD_HELP[key], key).not.toContain("—");
    }
  });

  it("the config schema accepts the keys and rejects unknown evaluations", () => {
    const ok = (harnessEvolve: Record<string, unknown>) =>
      validateConfigObject({ agents: { defaults: { harnessEvolve } } }).ok;
    expect(ok({ enabled: true, evaluation: "replay", maxTrialTurnsPerCycle: 40 })).toBe(true);
    expect(ok({ evaluation: "predicted" })).toBe(true);
    expect(ok({ maxTrialTurnsPerCycle: 0 })).toBe(true);
    expect(ok({ evaluation: "guess" })).toBe(false);
    expect(ok({ maxTrialTurnsPerCycle: -1 })).toBe(false);
    expect(ok({ maxTrialTurnsPerCycle: 2.5 })).toBe(false);
  });
});
