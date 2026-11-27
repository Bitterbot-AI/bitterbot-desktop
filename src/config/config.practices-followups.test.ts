import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import {
  practiceAttributionEnabled,
  practiceFollowUpsEnabled,
  practiceOffersEnabled,
  practicesEnabled,
} from "./feature-switches.js";
import { FIELD_DEFAULTS } from "./schema.defaults.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";

/** PLAN-64 Phase 1b: memory.practices.followUps.enabled and memory.practices.offers.enabled. */
describe("memory.practices follow-up and offer switches", () => {
  it("are on by default and documented in every schema file", () => {
    for (const key of ["memory.practices.followUps.enabled", "memory.practices.offers.enabled"]) {
      expect(FIELD_DEFAULTS[key], key).toBe(true);
      expect(FIELD_LABELS[key], key).toBeTruthy();
      expect(FIELD_HELP[key], key).toBeTruthy();
      expect(FIELD_HELP[key], key).not.toContain("—");
    }
    expect(practiceFollowUpsEnabled(undefined)).toBe(true);
    expect(practiceOffersEnabled(undefined)).toBe(true);
    expect(practiceFollowUpsEnabled({})).toBe(true);
    expect(practiceOffersEnabled({ followUps: { enabled: false } })).toBe(true);
  });

  it("each turns off alone, and both go off with memory.practices.enabled", () => {
    expect(practiceFollowUpsEnabled({ followUps: { enabled: false } })).toBe(false);
    expect(practiceOffersEnabled({ offers: { enabled: false } })).toBe(false);
    expect(practiceFollowUpsEnabled({ offers: { enabled: false } })).toBe(true);
    const off = { enabled: false };
    expect(practicesEnabled(off)).toBe(false);
    expect(practiceFollowUpsEnabled(off)).toBe(false);
    expect(practiceOffersEnabled(off)).toBe(false);
  });

  it("the config schema accepts the keys", () => {
    expect(
      validateConfigObject({
        memory: {
          practices: { enabled: true, followUps: { enabled: false }, offers: { enabled: false } },
        },
      }).ok,
    ).toBe(true);
  });

  it("PLAN-64 Phase 3: memory.practices.attribution.enabled is on by default, documented and accepted", () => {
    const key = "memory.practices.attribution.enabled";
    expect(FIELD_DEFAULTS[key]).toBe(true);
    expect(FIELD_LABELS[key]).toBeTruthy();
    expect(FIELD_HELP[key]).toBeTruthy();
    expect(FIELD_HELP[key]).not.toContain("—");
    expect(practiceAttributionEnabled(undefined)).toBe(true);
    expect(practiceAttributionEnabled({ offers: { enabled: false } })).toBe(true);
    expect(practiceAttributionEnabled({ attribution: { enabled: false } })).toBe(false);
    expect(practiceAttributionEnabled({ enabled: false })).toBe(false);
    // The other switches do not depend on it.
    expect(practiceOffersEnabled({ attribution: { enabled: false } })).toBe(true);
    expect(
      validateConfigObject({ memory: { practices: { attribution: { enabled: false } } } }).ok,
    ).toBe(true);
  });
});
