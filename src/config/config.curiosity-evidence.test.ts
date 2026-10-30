/**
 * PLAN-59 Phase 0: `memory.curiosity.evidence` in the config schema.
 *
 * The typed branch accepts the three keys (and, since PLAN-59 Phase 2, the
 * `surfacingTrial` block) and rejects a bad mode or an unknown key. Inside the full config the curiosity block sits in a union with
 * `z.unknown()` (acceptance of `memory` was never narrowed), so a bad mode there
 * still validates and is handled by `resolveEvidenceConfig` at the read site.
 */

import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import { CuriosityEvidenceSchema, CuriositySurfacingTrialSchema } from "./zod-schema.js";

describe("memory.curiosity.evidence (PLAN-59 Phase 0)", () => {
  it("accepts the three keys in a full config", () => {
    const res = validateConfigObject({
      memory: {
        curiosity: { enabled: true, evidence: { mode: "shadow", retentionDays: 30, topK: 5 } },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const curiosity = (res.config.memory as { curiosity?: { evidence?: unknown } }).curiosity;
      expect(curiosity?.evidence).toEqual({ mode: "shadow", retentionDays: 30, topK: 5 });
    }
  });

  it("accepts an absent evidence block", () => {
    expect(validateConfigObject({ memory: { curiosity: { enabled: true } } }).ok).toBe(true);
  });

  it("the typed branch accepts each mode and rejects a bad mode or an unknown key", () => {
    for (const mode of ["off", "observe", "shadow"]) {
      expect(CuriosityEvidenceSchema.safeParse({ mode }).success).toBe(true);
    }
    expect(CuriosityEvidenceSchema.safeParse({}).success).toBe(true);
    expect(CuriosityEvidenceSchema.safeParse({ mode: "shadwo" }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ mode: 3 }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ topK: 0 }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ topK: 2.5 }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ modes: "off" }).success).toBe(false);
  });

  it("accepts the Phase 2 surfacingTrial block and rejects a live mode or an unknown key", () => {
    const res = validateConfigObject({
      memory: {
        curiosity: {
          evidence: {
            mode: "shadow",
            surfacingTrial: { mode: "shadow", blockMinutes: 240, carryOverDays: 7, seed: "node-a" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const curiosity = (res.config.memory as { curiosity?: { evidence?: unknown } }).curiosity;
      expect(curiosity?.evidence).toEqual({
        mode: "shadow",
        surfacingTrial: { mode: "shadow", blockMinutes: 240, carryOverDays: 7, seed: "node-a" },
      });
    }
    for (const mode of ["off", "shadow"]) {
      expect(CuriositySurfacingTrialSchema.safeParse({ mode }).success).toBe(true);
    }
    expect(CuriositySurfacingTrialSchema.safeParse({}).success).toBe(true);
    // the withhold condition is a separate exposure decision and PR
    expect(CuriositySurfacingTrialSchema.safeParse({ mode: "live" }).success).toBe(false);
    expect(CuriositySurfacingTrialSchema.safeParse({ blockMinutes: 0 }).success).toBe(false);
    expect(CuriositySurfacingTrialSchema.safeParse({ carryOverDays: -1 }).success).toBe(false);
    expect(CuriositySurfacingTrialSchema.safeParse({ seed: "" }).success).toBe(false);
    expect(CuriositySurfacingTrialSchema.safeParse({ blocks: 3 }).success).toBe(false);
    expect(CuriosityEvidenceSchema.safeParse({ surfacingTrial: { mode: "shadow" } }).success).toBe(
      true,
    );
    expect(CuriosityEvidenceSchema.safeParse({ surfacingTrial: { mode: "live" } }).success).toBe(
      false,
    );
  });

  it("a bad surfacingTrial mode in the full config falls to the unknown branch like the evidence mode", () => {
    expect(
      validateConfigObject({
        memory: { curiosity: { evidence: { surfacingTrial: { mode: "live" } } } },
      }).ok,
    ).toBe(true);
  });

  it("a bad mode in the full config falls to the unknown branch and is left to the read site", () => {
    // Documented behaviour of MemorySchema: the curiosity union's fallback is z.unknown().
    const res = validateConfigObject({ memory: { curiosity: { evidence: { mode: "shadwo" } } } });
    expect(res.ok).toBe(true);
  });
});
