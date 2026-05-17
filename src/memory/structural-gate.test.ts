import { describe, expect, it } from "vitest";
import { computeEdgeFeatures } from "./graph-topology.js";
import {
  GATE_PARAM_COUNT,
  createDefaultGate,
  describeGate,
  deserializeGate,
  effectiveDelta,
  flattenGate,
  forward,
  gateValue,
  mulberry32,
  perturbGate,
  serializeGate,
  unflattenGate,
} from "./structural-gate.js";

function fixtureFeatures() {
  return computeEdgeFeatures({
    sourceDegree: 5,
    targetDegree: 3,
    sourceNeighbors: new Set(["a", "b", "c"]),
    targetNeighbors: new Set(["b", "c"]),
    sourceMentions: 2,
    targetMentions: 1,
    ageDays: 3,
  });
}

describe("structural-gate forward pass", () => {
  it("createDefaultGate produces a valid parameter pack", () => {
    const g = createDefaultGate(42);
    expect(g.w1.length).toBeGreaterThan(0);
    expect(g.b1.length).toBeGreaterThan(0);
    expect(g.w2.length).toBeGreaterThan(0);
    expect(g.b2.length).toBeGreaterThan(0);
    expect(g.delta).toBeGreaterThanOrEqual(0);
    expect(g.delta).toBeLessThanOrEqual(1);
    expect(describeGate(g)).toMatch(/Gate/);
  });

  it("forward output is bounded in [-1, 1]", () => {
    const g = createDefaultGate(1);
    const feats = fixtureFeatures();
    const v = forward(g, feats);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("forward is deterministic for fixed weights and inputs", () => {
    const g = createDefaultGate(7);
    const feats = fixtureFeatures();
    const a = forward(g, feats);
    const b = forward(g, feats);
    expect(a).toBe(b);
  });

  it("gateValue stays in [0, 2.5] across random perturbations", () => {
    const g = createDefaultGate(123);
    const rng = mulberry32(99);
    const feats = fixtureFeatures();
    for (let i = 0; i < 50; i++) {
      const gp = perturbGate(g, 0.5, rng);
      const v = gateValue(gp, feats);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(2.5);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("structural-gate serialization", () => {
  it("flatten / unflatten round-trips exactly", () => {
    const g = createDefaultGate(11);
    const flat = flattenGate(g);
    expect(flat.length).toBe(GATE_PARAM_COUNT);
    const r = unflattenGate(flat, g.version);
    expect(r.delta).toBeCloseTo(g.delta, 6);
    for (let i = 0; i < g.w1.length; i++) {
      expect(r.w1[i]).toBeCloseTo(g.w1[i], 6);
    }
    for (let i = 0; i < g.b1.length; i++) {
      expect(r.b1[i]).toBeCloseTo(g.b1[i], 6);
    }
  });

  it("serialize / deserialize is identity", () => {
    const g = createDefaultGate(33);
    const s = serializeGate(g);
    const back = deserializeGate(s);
    expect(back).not.toBeNull();
    expect(back!.delta).toBeCloseTo(g.delta, 6);
  });

  it("deserialize returns null for missing/bogus fields", () => {
    expect(deserializeGate(null)).toBeNull();
    expect(deserializeGate({})).toBeNull();
    expect(deserializeGate({ w1: [], b1: [], w2: [], b2: [] })).toBeNull();
    expect(deserializeGate("string")).toBeNull();
  });
});

describe("structural-gate hormonal modulation (Phase 5)", () => {
  it("cortisol narrows the effective delta", () => {
    expect(effectiveDelta(0.5, { dopamine: 0, cortisol: 1, oxytocin: 0 })).toBeLessThan(0.5);
  });

  it("dopamine widens the effective delta", () => {
    expect(effectiveDelta(0.3, { dopamine: 1, cortisol: 0, oxytocin: 0 })).toBeGreaterThan(0.3);
  });

  it("effective delta is clamped to [0, 1]", () => {
    expect(effectiveDelta(0.9, { dopamine: 1, cortisol: 0, oxytocin: 0 })).toBeLessThanOrEqual(1);
    expect(effectiveDelta(0.1, { dopamine: 0, cortisol: 1, oxytocin: 0 })).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("oxytocin boosts social-relation edges", () => {
    const g = createDefaultGate(2);
    const feats = fixtureFeatures();
    const social = gateValue(g, feats, {
      relationType: "manages",
      hormonalState: { dopamine: 0, cortisol: 0, oxytocin: 1 },
    });
    const nonSocial = gateValue(g, feats, {
      relationType: "depends_on",
      hormonalState: { dopamine: 0, cortisol: 0, oxytocin: 1 },
    });
    expect(social).toBeGreaterThan(nonSocial);
  });

  it("non-social relation does not get oxytocin boost", () => {
    const g = createDefaultGate(2);
    const feats = fixtureFeatures();
    const base = gateValue(g, feats, {
      relationType: "depends_on",
      hormonalState: { dopamine: 0, cortisol: 0, oxytocin: 0 },
    });
    const boosted = gateValue(g, feats, {
      relationType: "depends_on",
      hormonalState: { dopamine: 0, cortisol: 0, oxytocin: 1 },
    });
    expect(boosted).toBeCloseTo(base, 5);
  });
});
