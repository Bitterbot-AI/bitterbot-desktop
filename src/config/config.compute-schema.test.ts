import { describe, expect, it } from "vitest";
import { FIELD_DEFAULTS } from "./schema.defaults.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { validateConfigObject } from "./validation.js";

describe("compute config (PLAN-57)", () => {
  it("accepts compute.enabled", () => {
    const res = validateConfigObject({ compute: { enabled: false } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.compute?.enabled).toBe(false);
    }
  });

  it("accepts an absent compute block", () => {
    expect(validateConfigObject({}).ok).toBe(true);
  });

  it("rejects unknown keys under compute (keys land with the code that reads them)", () => {
    const res = validateConfigObject({
      compute: { enabled: true, awareness: { stateBlock: true } },
    });
    expect(res.ok).toBe(false);
  });

  it("is labelled and catalogued as default-on for the settings form", () => {
    expect(FIELD_LABELS["compute.enabled"]).toBe("Compute: Enabled");
    expect(FIELD_DEFAULTS["compute.enabled"]).toBe(true);
  });
});
