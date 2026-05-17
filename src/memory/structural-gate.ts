/**
 * PLAN-18 Phase 3 — structural gate (SAGE Eq. structural gating).
 *
 * Implements `g_{uv} = 1 + δ · tanh(MLP_g(z_{uv}))` from SAGE Section 4.2.
 *
 * MLP shape: 8 → 16 → 1. ~145 parameters total.
 *
 * Phase 5 adds hormonal modulation: the effective δ becomes
 *   δ_eff = δ_base − 0.4·cortisol + 0.4·dopamine
 * and a per-relation-type oxytocin boost is applied to social edges.
 *
 * Parameters are serialized as a small JSON blob (the gate file). Both
 * forward pass and parameter perturbation must remain pure functions so
 * the gradient-free optimizer can evaluate many parameter sets quickly.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { TOPOLOGY_FEATURE_COUNT, type TopologyFeatures } from "./graph-topology.js";

const log = createSubsystemLogger("memory/structural-gate");

const INPUT_DIM = TOPOLOGY_FEATURE_COUNT; // 8
const HIDDEN_DIM = 16;
const OUTPUT_DIM = 1;

export const GATE_PARAM_COUNT =
  INPUT_DIM * HIDDEN_DIM + HIDDEN_DIM + HIDDEN_DIM * OUTPUT_DIM + OUTPUT_DIM + 1;
// +1 trailing scalar = δ_base

export type GateParameters = {
  /** Hidden weight matrix flattened row-major (INPUT_DIM × HIDDEN_DIM). */
  w1: Float32Array;
  /** Hidden bias (HIDDEN_DIM). */
  b1: Float32Array;
  /** Output weight (HIDDEN_DIM × OUTPUT_DIM). */
  w2: Float32Array;
  /** Output bias (OUTPUT_DIM). */
  b2: Float32Array;
  /** Static δ_base ∈ [0, 1]. Hormonal state shifts it at runtime. */
  delta: number;
  /** Version tag for the serialized form. */
  version: number;
};

export type SerializedGate = {
  version: number;
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number[];
  delta: number;
};

export type HormonalLevels = {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
};

const SOCIAL_RELATIONS = new Set(["knows", "manages", "prefers", "works_on"]);

/** Initialize a gate with small random weights (Xavier-ish). */
export function createDefaultGate(seed = 1): GateParameters {
  const rng = mulberry32(seed);
  const xavier = (fanIn: number, fanOut: number): number => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    return (rng() * 2 - 1) * limit;
  };
  const w1 = new Float32Array(INPUT_DIM * HIDDEN_DIM);
  for (let i = 0; i < w1.length; i++) {
    w1[i] = xavier(INPUT_DIM, HIDDEN_DIM);
  }
  const b1 = new Float32Array(HIDDEN_DIM);
  const w2 = new Float32Array(HIDDEN_DIM * OUTPUT_DIM);
  for (let i = 0; i < w2.length; i++) {
    w2[i] = xavier(HIDDEN_DIM, OUTPUT_DIM);
  }
  const b2 = new Float32Array(OUTPUT_DIM);
  return {
    w1,
    b1,
    w2,
    b2,
    delta: 0.3,
    version: 1,
  };
}

/** Mulberry32 PRNG (deterministic for reproducible inits). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flatten a gate to a single parameter vector (for the optimizer). */
export function flattenGate(g: GateParameters): Float32Array {
  const flat = new Float32Array(GATE_PARAM_COUNT);
  let off = 0;
  flat.set(g.w1, off);
  off += g.w1.length;
  flat.set(g.b1, off);
  off += g.b1.length;
  flat.set(g.w2, off);
  off += g.w2.length;
  flat.set(g.b2, off);
  off += g.b2.length;
  flat[off] = g.delta;
  return flat;
}

/** Inverse of `flattenGate`. */
export function unflattenGate(flat: Float32Array, version = 1): GateParameters {
  if (flat.length !== GATE_PARAM_COUNT) {
    throw new Error(`expected ${GATE_PARAM_COUNT} params, got ${flat.length}`);
  }
  let off = 0;
  const w1 = new Float32Array(INPUT_DIM * HIDDEN_DIM);
  w1.set(flat.subarray(off, off + w1.length));
  off += w1.length;
  const b1 = new Float32Array(HIDDEN_DIM);
  b1.set(flat.subarray(off, off + b1.length));
  off += b1.length;
  const w2 = new Float32Array(HIDDEN_DIM * OUTPUT_DIM);
  w2.set(flat.subarray(off, off + w2.length));
  off += w2.length;
  const b2 = new Float32Array(OUTPUT_DIM);
  b2.set(flat.subarray(off, off + b2.length));
  off += b2.length;
  // Clamp delta into [0, 1] defensively.
  const delta = Math.max(0, Math.min(1, flat[off] ?? 0.3));
  return { w1, b1, w2, b2, delta, version };
}

/** Serialize to JSON-safe form. */
export function serializeGate(g: GateParameters): SerializedGate {
  return {
    version: g.version,
    w1: Array.from(g.w1),
    b1: Array.from(g.b1),
    w2: Array.from(g.w2),
    b2: Array.from(g.b2),
    delta: g.delta,
  };
}

/** Deserialize from JSON-safe form. Returns null on any structural mismatch. */
export function deserializeGate(s: unknown): GateParameters | null {
  if (!s || typeof s !== "object") {
    return null;
  }
  const obj = s as Record<string, unknown>;
  const checkArray = (v: unknown, len: number): Float32Array | null => {
    if (!Array.isArray(v) || v.length !== len) {
      return null;
    }
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const n = v[i];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return null;
      }
      out[i] = n;
    }
    return out;
  };
  const w1 = checkArray(obj.w1, INPUT_DIM * HIDDEN_DIM);
  const b1 = checkArray(obj.b1, HIDDEN_DIM);
  const w2 = checkArray(obj.w2, HIDDEN_DIM * OUTPUT_DIM);
  const b2 = checkArray(obj.b2, OUTPUT_DIM);
  if (!w1 || !b1 || !w2 || !b2) {
    return null;
  }
  const delta = typeof obj.delta === "number" ? Math.max(0, Math.min(1, obj.delta)) : 0.3;
  const version = typeof obj.version === "number" ? obj.version : 1;
  return { w1, b1, w2, b2, delta, version };
}

/** Forward pass: features → scalar logit in [-1, 1] via final tanh. */
export function forward(g: GateParameters, features: TopologyFeatures): number {
  if (features.length !== INPUT_DIM) {
    throw new Error(`expected ${INPUT_DIM} features, got ${features.length}`);
  }
  // Hidden = ReLU(W1 · x + b1)
  const hidden = new Float32Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) {
    let sum = g.b1[j];
    const colOff = j;
    for (let i = 0; i < INPUT_DIM; i++) {
      sum += features[i] * g.w1[i * HIDDEN_DIM + colOff];
    }
    hidden[j] = sum > 0 ? sum : 0; // ReLU
  }
  // Output = W2 · hidden + b2
  let out = g.b2[0];
  for (let j = 0; j < HIDDEN_DIM; j++) {
    out += hidden[j] * g.w2[j];
  }
  // Final tanh squash → [-1, 1]
  return Math.tanh(out);
}

/**
 * Compute the effective δ given a base δ and current hormonal state.
 * Cortisol narrows, dopamine widens; both bounded.
 */
export function effectiveDelta(base: number, h?: HormonalLevels): number {
  if (!h) {
    return base;
  }
  const c = clamp01(h.cortisol);
  const d = clamp01(h.dopamine);
  const shifted = base - 0.4 * c + 0.4 * d;
  return Math.max(0, Math.min(1, shifted));
}

/**
 * Compute the gate value for an edge given its features and (optionally)
 * the relation type for the social-relation oxytocin boost.
 *
 * Returns a multiplier in roughly [0, 2] applied to the edge's base weight
 * during propagation.
 */
export function gateValue(
  g: GateParameters,
  features: TopologyFeatures,
  opts: {
    relationType?: string;
    hormonalState?: HormonalLevels;
  } = {},
): number {
  const raw = forward(g, features);
  const delta = effectiveDelta(g.delta, opts.hormonalState);
  let v = 1 + delta * raw;

  // Phase 5: oxytocin boosts social relations.
  if (opts.hormonalState && opts.relationType && SOCIAL_RELATIONS.has(opts.relationType)) {
    const o = clamp01(opts.hormonalState.oxytocin);
    v *= 1 + 0.3 * o;
  }

  // Clamp into a safe range so a misbehaved MLP never inverts weights.
  if (!Number.isFinite(v)) {
    return 1;
  }
  return Math.max(0, Math.min(2.5, v));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(1, n));
}

/** Perturb every parameter by a Gaussian noise scaled by `sigma`. */
export function perturbGate(g: GateParameters, sigma: number, rng: () => number): GateParameters {
  const flat = flattenGate(g);
  const next = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    // Box-Muller for a unit normal.
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    next[i] = flat[i] + sigma * z;
  }
  // Clamp delta in-place at the end.
  next[next.length - 1] = Math.max(0, Math.min(1, next[next.length - 1]));
  return unflattenGate(next, g.version);
}

/** Convenience helper to log a one-line gate summary. */
export function describeGate(g: GateParameters): string {
  return `Gate(v${g.version} δ=${g.delta.toFixed(3)} params=${GATE_PARAM_COUNT})`;
}

if (log.debug) {
  log.debug("structural-gate module loaded", { params: GATE_PARAM_COUNT });
}
