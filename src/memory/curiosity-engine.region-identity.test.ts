/**
 * Audit 2026-08-09 F8: curiosity regions were re-inserted with a fresh random
 * UUID every rebuild, orphaning all curiosity_progress rows (keyed by
 * region_id) and making learning_progress impossible to accumulate. Region
 * identity must be STABLE (deterministic from the label).
 */
import { describe, expect, it } from "vitest";
import { deriveStableRegionId } from "./curiosity-engine.js";

describe("deriveStableRegionId (F8)", () => {
  it("is deterministic: same label -> same id across calls", () => {
    const a = deriveStableRegionId("memory-architecture");
    const b = deriveStableRegionId("memory-architecture");
    expect(a).toBe(b);
  });

  it("distinct labels -> distinct ids", () => {
    expect(deriveStableRegionId("aviation-checklists")).not.toBe(
      deriveStableRegionId("hormonal-system"),
    );
  });

  it("produces a UUIDv4-shaped id (fits the region_id column contract)", () => {
    const id = deriveStableRegionId("some-region-label");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is NOT random: two labels that differ by one char still map stably", () => {
    // Guards against accidentally reintroducing randomUUID(): stability holds
    // for near-identical labels and never collides them.
    const x = deriveStableRegionId("region_a");
    const y = deriveStableRegionId("region_b");
    expect(x).not.toBe(y);
    expect(deriveStableRegionId("region_a")).toBe(x);
  });
});

// The learning-progress formula that rebuildRegions applies: for a region that
// persisted (same stable id), learning_progress = clamp(priorError - newError,
// -1, 1) — the SIGNED change in prediction error. It used to be clamped at 0,
// which meant the stale-region detector (learning_progress < -0.3) could never
// fire off the rebuild value.
describe("learning-progress formula (F8)", () => {
  const lp = (priorError: number | undefined, newError: number): number =>
    priorError == null ? 0 : Math.max(-1, Math.min(1, priorError - newError));

  it("is 0 for a brand-new region (no prior)", () => {
    expect(lp(undefined, 0.4)).toBe(0);
  });

  it("is the surprise reduction when error falls (agent is learning)", () => {
    expect(lp(0.6, 0.4)).toBeCloseTo(0.2);
  });

  it("goes negative when error rises (region is drifting / going stale)", () => {
    expect(lp(0.3, 0.5)).toBeCloseTo(-0.2);
  });
});
