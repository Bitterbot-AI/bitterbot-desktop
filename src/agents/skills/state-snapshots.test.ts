import { describe, expect, it, beforeEach } from "vitest";
import { buildGCCRFSnapshot, buildHormonalSnapshot, __testing } from "./state-snapshots.js";

describe("buildHormonalSnapshot", () => {
  it("returns null when no manager is provided", () => {
    expect(buildHormonalSnapshot(null)).toBeNull();
    expect(buildHormonalSnapshot(undefined)).toBeNull();
  });

  it("freezes the 8-dim response profile from a stub manager", () => {
    const stub = {
      getState: () => ({ dopamine: 0.5, cortisol: 0.1, oxytocin: 0.3, lastDecay: Date.now() }),
      responseModulation: () => ({
        warmth: 0.4,
        energy: 0.6,
        focus: 0.2,
        playfulness: 0.3,
        verbosity: 0.5,
        curiosityExpression: 0.7,
        assertiveness: 0.4,
        empathyExpression: 0.5,
        briefing: "stub",
      }),
    } as never;
    const snap = buildHormonalSnapshot(stub);
    expect(snap).not.toBeNull();
    expect(snap?.dopamine).toBe(0.5);
    expect(snap?.response.curiosity).toBe(0.7);
    expect(Object.isFrozen(snap?.response)).toBe(true);
  });
});

describe("buildGCCRFSnapshot", () => {
  beforeEach(() => __testing.resetGCCRFSampleForTest());

  it("returns null when no state is provided", () => {
    expect(buildGCCRFSnapshot(null)).toBeNull();
    expect(buildGCCRFSnapshot(undefined)).toBeNull();
  });

  it("clamps invalid empowerment to [0,1]", () => {
    const snap = buildGCCRFSnapshot({
      normalizers: {
        empowerment: { value: 1.7 },
        strategic: { value: -0.4 },
      },
    });
    expect(snap?.empowerment).toBeLessThanOrEqual(1);
    expect(snap?.strategicAlignment).toBeGreaterThanOrEqual(0);
  });

  it("computes certaintyDelta across successive samples", () => {
    const a = buildGCCRFSnapshot({ normalizers: { empowerment: { value: 0.2 } } });
    const b = buildGCCRFSnapshot({ normalizers: { empowerment: { value: 0.5 } } });
    expect(a?.certaintyDelta).toBe(0); // no prior sample
    expect(b?.certaintyDelta).not.toBe(0); // delta from previous
  });

  it("first sample has certaintyDelta of 0", () => {
    const snap = buildGCCRFSnapshot({
      normalizers: { empowerment: { value: 0.5 } },
    });
    expect(snap?.certaintyDelta).toBe(0);
  });
});
