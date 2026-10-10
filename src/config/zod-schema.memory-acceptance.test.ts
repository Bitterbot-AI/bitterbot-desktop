/**
 * PLAN-56 Phase 1 review item 1: typing the curiosity keys for the Settings
 * form must not reject any config shape that the passthrough `memory` object
 * accepted before. Every case here parsed on main a2bc220d and must keep
 * parsing (the typed branch is for the JSON schema only).
 */
import { describe, expect, it } from "vitest";
import { BitterbotSchema } from "./zod-schema.js";

const SHAPES: Array<[string, unknown]> = [
  ["string maxPerDay from ${ENV}", { curiosity: { research: { maxPerDay: "3" } } }],
  ["numeric enabled", { curiosity: { enabled: 1 } }],
  ["string enabled", { curiosity: { research: { enabled: "false" } } }],
  ["zero interval", { curiosity: { research: { intervalMinutes: 0 } } }],
  ["fractional maxPerDay", { curiosity: { research: { maxPerDay: 2.5 } } }],
  ["out-of-range minConfidence", { curiosity: { research: { minConfidence: 1.5 } } }],
  ["string blockedDomains", { curiosity: { research: { blockedDomains: "x.com" } } }],
  ["null curiosity", { curiosity: null }],
  ["false research", { curiosity: { research: false } }],
  ["string autoResearch", { curiosity: { autoResearch: "yes" } }],
  ["numeric architectEvolution.enabled", { architectEvolution: { enabled: 1 } }],
  ["null architectEvolution", { architectEvolution: null }],
  ["unknown sibling keys", { curiosity: { novelty: { threshold: 0.3 } }, dream: { x: 1 } }],
  [
    "well-typed",
    {
      curiosity: {
        enabled: true,
        research: { enabled: false, strictEgress: true, maxPerDay: 3 },
        autoResearch: { enabled: false },
      },
      architectEvolution: { enabled: true },
    },
  ],
];

describe("memory.* acceptance is unchanged by the typed curiosity leaves", () => {
  for (const [name, memory] of SHAPES) {
    it(`accepts ${name}`, () => {
      const res = BitterbotSchema.safeParse({ memory });
      expect(res.success, JSON.stringify(res.success ? null : res.error.issues)).toBe(true);
      // Values pass through untouched (no coercion, no stripping).
      expect((res.data as { memory?: unknown }).memory).toEqual(memory);
    });
  }

  it("still types the leaves the Settings form labels", () => {
    const json = BitterbotSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });
    const text = JSON.stringify(json);
    expect(text).toContain('"strictEgress":{"type":"boolean"}');
    expect(text).toContain(
      '"architectEvolution":{"anyOf":[{"type":"object","properties":{"enabled":{"type":"boolean"}}',
    );
  });
});
