/**
 * Fractional Stuart-Landau Hopf Oscillator (FSHO) for dream mode selection.
 * Plan 6, Phase 1: Neuroscience Harvest.
 *
 * Maps memory salience to oscillator phases, runs Kuramoto coupling dynamics,
 * and outputs an order parameter R ∈ [0,1] that determines which dream modes
 * to favor:
 *
 *   R high (>0.7)  → coherent memories → compression/replay
 *   R mid (0.3-0.7) → edge of sync → mutation/simulation (creative zone)
 *   R low (<0.3)   → scattered → exploration/extrapolation
 *
 * Scientific basis:
 * - Kuramoto model: coupled oscillator synchronization (Kuramoto, 1984)
 * - Fractional Gaussian noise provides long-range memory (Hurst parameter H)
 * - Order parameter R = |⟨e^{iθ}⟩| measures phase coherence
 */

import type { DreamMode } from "./dream-types.js";

export interface FSHOConfig {
  N: number; // Number of oscillators (= number of memory samples)
  K: number; // Coupling strength (default: 1.0)
  gamma: number; // Damping coefficient (default: 0.1)
  eta: number; // Noise strength (default: 0.3)
  H: number; // Hurst parameter — 0.5 = no memory, >0.5 = persistence (default: 0.7)
  T: number; // Simulation time (default: 50)
  dt: number; // Time step (default: 0.05)
}

export const DEFAULT_FSHO_CONFIG: FSHOConfig = {
  N: 10,
  K: 1.0,
  gamma: 0.1,
  eta: 0.3,
  H: 0.7,
  T: 50,
  dt: 0.05,
};

export interface FSHOResult {
  orderParameter: number; // R ∈ [0,1] — mean field coherence
  meanPhase: number; // ψ — mean phase angle
  phases: number[]; // Final oscillator phases
}

/**
 * Generate approximate fractional Gaussian noise using the Cholesky method.
 * For N≤20 oscillators, Cholesky is fast enough and more robust than FFT-based
 * Davies-Harte (which the prototype used via numpy).
 *
 * Autocovariance: γ(k) = 0.5 * (|k+1|^{2H} - 2|k|^{2H} + |k-1|^{2H})
 */
function generateFGN(steps: number, H: number): number[] {
  // For H≈0.5, this is just white noise (standard Gaussian)
  if (Math.abs(H - 0.5) < 0.01) {
    return Array.from({ length: steps }, () => gaussianRandom());
  }

  // Build autocovariance vector
  const windowSize = Math.min(steps, 50); // Truncate correlation window
  const gamma = new Float64Array(windowSize);
  for (let k = 0; k < windowSize; k++) {
    gamma[k] =
      0.5 *
      (Math.pow(Math.abs(k + 1), 2 * H) -
        2 * Math.pow(Math.abs(k), 2 * H) +
        Math.pow(Math.abs(k - 1), 2 * H));
  }

  // Cholesky decomposition of Toeplitz autocovariance matrix
  const L = new Float64Array(windowSize * windowSize);

  for (let i = 0; i < windowSize; i++) {
    let sum = 0;
    for (let k = 0; k < i; k++) {
      sum += L[i * windowSize + k]! * L[i * windowSize + k]!;
    }
    L[i * windowSize + i] = Math.sqrt(Math.max(0, gamma[0]! - sum));

    for (let j = i + 1; j < windowSize; j++) {
      let s = 0;
      for (let k = 0; k < i; k++) {
        s += L[j * windowSize + k]! * L[i * windowSize + k]!;
      }
      const diag = L[i * windowSize + i]!;
      L[j * windowSize + i] = diag > 1e-10 ? (gamma[Math.abs(j - i)]! - s) / diag : 0;
    }
  }

  // Generate correlated noise
  const white = Array.from({ length: steps }, () => gaussianRandom());
  const result = new Array<number>(steps).fill(0);

  for (let t = 0; t < steps; t++) {
    for (let k = 0; k < Math.min(windowSize, t + 1); k++) {
      const lIdx = t < windowSize ? t * windowSize + k : k;
      result[t]! += L[lIdx]! * white[Math.max(0, t - k)]!;
    }
  }

  return result;
}

/**
 * Run FSHO simulation and return order parameter.
 *
 * Core dynamics per timestep:
 *   coupling_i = (K/N) * Σ_j sin(θ_j - θ_i)
 *   dv_i = (ω_i + coupling_i - γ*v_i) * dt + η * noise * √dt
 *   θ_i += v_i * dt  (mod 2π)
 *   R = |⟨exp(i*θ)⟩|
 */
export function simulateFSHO(salienceValues: number[], config?: Partial<FSHOConfig>): FSHOResult {
  const cfg = { ...DEFAULT_FSHO_CONFIG, ...config };
  const N = Math.min(salienceValues.length, cfg.N);
  const steps = Math.floor(cfg.T / cfg.dt);

  // Map salience [0,1] → initial phase [0, 2π]
  const theta = salienceValues.slice(0, N).map((s) => s * 2 * Math.PI);
  const v = new Array<number>(N).fill(0);
  // Natural frequencies drawn from uniform [-1, 1]
  const omega = Array.from({ length: N }, () => Math.random() * 2 - 1);

  // Pre-generate noise for each oscillator
  const noise: number[][] = [];
  for (let i = 0; i < N; i++) {
    noise.push(generateFGN(steps, cfg.H));
  }

  const sqrtDt = Math.sqrt(cfg.dt);

  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < N; i++) {
      // Kuramoto coupling
      let coupling = 0;
      for (let j = 0; j < N; j++) {
        if (i !== j) coupling += Math.sin(theta[j]! - theta[i]!);
      }
      coupling *= cfg.K / N;

      // Velocity update: deterministic + stochastic
      v[i]! +=
        (omega[i]! + coupling - cfg.gamma * v[i]!) * cfg.dt + cfg.eta * noise[i]![t]! * sqrtDt;

      // Phase update
      theta[i] = (theta[i]! + v[i]! * cfg.dt) % (2 * Math.PI);
      if (theta[i]! < 0) theta[i]! += 2 * Math.PI;
    }
  }

  // Kuramoto order parameter: R = |⟨exp(iθ)⟩|
  let realSum = 0;
  let imagSum = 0;
  for (let i = 0; i < N; i++) {
    realSum += Math.cos(theta[i]!);
    imagSum += Math.sin(theta[i]!);
  }
  const R = Math.sqrt(realSum * realSum + imagSum * imagSum) / N;
  const psi = Math.atan2(imagSum, realSum);

  return { orderParameter: R, meanPhase: psi, phases: theta };
}

/**
 * Map FSHO order parameter to dream mode weight adjustments.
 * These are UNNORMALIZED — the caller must normalize across all sources.
 */
export function fshoModeAdjustments(
  R: number,
  hormones?: { dopamine: number; cortisol: number; oxytocin: number } | null,
): Partial<Record<DreamMode, number>> {
  const adj: Partial<Record<DreamMode, number>> = {};

  if (R > 0.7) {
    // High coherence: consolidate and strengthen
    adj.compression = 0.15;
    adj.replay = 0.1;
    adj.research = 0.05;
  } else if (R > 0.3) {
    // Edge of synchronization: creative zone (criticality)
    adj.mutation = 0.15;
    adj.simulation = 0.1;
    // Hormonal modulation at criticality
    if (hormones) {
      if (hormones.dopamine > 0.5) adj.mutation = (adj.mutation ?? 0) + 0.05;
      if (hormones.oxytocin > 0.5) adj.simulation = (adj.simulation ?? 0) + 0.05;
    }
  } else {
    // Low coherence: explore and discover
    adj.exploration = 0.15;
    adj.extrapolation = 0.1;
    // High cortisol + low coherence → replay for grounding
    if (hormones && hormones.cortisol > 0.6) {
      adj.replay = 0.1;
    }
  }

  return adj;
}

/** Box-Muller transform for Gaussian random (no external deps). */
function gaussianRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
