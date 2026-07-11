import { describe, expect, it } from "vitest";
import { BitterbotSchema } from "./zod-schema.js";

// PLAN-31: the circles config block. Strict objects — unknown keys are
// config typos and must fail loudly: every key here is a connection-surface
// switch (the master kill switch, the mailbox host opt-in, the practice
// partner). Money has NO config here at all by design; a settlement flag
// appearing in this block should be impossible, not ignored.

describe("circles config schema", () => {
  it("accepts the full PLAN-31 v1 circles block", () => {
    const result = BitterbotSchema.safeParse({
      circles: {
        enabled: true,
        a2aPublicUrl: "https://a2a.example.com",
        displayName: "Ana's agent",
        mailbox: { enabled: true, url: "https://relay.example.com", serve: false },
        briefing: { enabled: true },
        practicePartner: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty circles block and a missing one (defaults filled by applyCirclesDefaults)", () => {
    expect(BitterbotSchema.safeParse({ circles: {} }).success).toBe(true);
    expect(BitterbotSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys in every circles sub-object (strict)", () => {
    for (const bad of [
      { circles: { enable: true } }, // typo of enabled
      { circles: { mailbox: { host: "https://x" } } },
      { circles: { briefing: { enabled: true, cadenceDays: 3 } } },
      { circles: { practicePartner: { persona: "friendly" } } },
      // Money must be structurally impossible in v1, not merely off.
      { circles: { settlement: { enabled: true } } },
    ]) {
      const result = BitterbotSchema.safeParse(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects wrong types on the switches", () => {
    expect(BitterbotSchema.safeParse({ circles: { enabled: "yes" } }).success).toBe(false);
    expect(BitterbotSchema.safeParse({ circles: { mailbox: { serve: "true" } } }).success).toBe(
      false,
    );
  });
});
