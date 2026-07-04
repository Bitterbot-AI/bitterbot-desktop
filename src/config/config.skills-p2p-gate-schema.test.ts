import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

// PLAN-29 Phase 0.3 regression: the skills.p2p block is .strict(), so the
// loadTimeCapabilityGate kill switch must be a known key or setting it
// becomes a config validation error (which would make the gate
// effectively un-disableable).

describe("skills.p2p.loadTimeCapabilityGate schema", () => {
  it("accepts the kill switch", () => {
    const result = validateConfigObject({
      skills: { p2p: { loadTimeCapabilityGate: false } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-boolean values", () => {
    const result = validateConfigObject({
      skills: { p2p: { loadTimeCapabilityGate: "yes" } },
    });
    expect(result.ok).toBe(false);
  });
});
