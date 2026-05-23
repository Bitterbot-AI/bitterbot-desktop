/**
 * PLAN-20 Phase 2: derive frozen hormonal + GCCRF snapshots from the
 * runtime managers. Interceptors read these via setInterceptorContextProviders.
 *
 * Snapshots are computed lazily once per agent step; the runner builds the
 * StepContext once and shares it across all interceptors evaluating that
 * step, so a 10-interceptor session pays the snapshot cost once, not 10×.
 */

import type { HormonalStateManager } from "../../memory/hormonal.js";
import type { GCCRFSnapshot, HormonalSnapshot } from "./interceptor.js";

interface GCCRFLastSample {
  ts: number;
  empowerment: number;
  strategicAlignment: number;
}

let lastGCCRFSample: GCCRFLastSample | null = null;

/**
 * Build a HormonalSnapshot from the live HormonalStateManager. Returns
 * null if the manager isn't initialized (caller falls back to the neutral
 * default in interceptor-context).
 */
export function buildHormonalSnapshot(
  manager: HormonalStateManager | null | undefined,
): HormonalSnapshot | null {
  if (!manager) return null;
  const state = manager.getState();
  const response = manager.responseModulation();
  return Object.freeze({
    dopamine: state.dopamine,
    cortisol: state.cortisol,
    oxytocin: state.oxytocin,
    response: Object.freeze({
      warmth: response.warmth,
      energy: response.energy,
      focus: response.focus,
      playfulness: response.playfulness,
      verbosity: response.verbosity,
      curiosity: response.curiosityExpression,
      assertiveness: response.assertiveness,
      empathy: response.empathyExpression,
    }),
  });
}

/**
 * GCCRF state is more loosely coupled — the reward function lives inside
 * the dream engine and is sampled less frequently than hormonal state.
 * We compute a derived `certaintyDelta` from successive samples so an
 * interceptor can ask "is my certainty falling?" without having to plumb
 * a multi-sample history through itself.
 *
 * The shape we read from GCCRFState (see src/memory/gccrf-state.ts):
 *   { normalizers: { eta, deltaEta, iAlpha, empowerment, strategic }, ... }
 * Each normalizer carries `value: number`. We dereference defensively.
 */
type GCCRFLike = {
  normalizers?: Partial<{
    eta: { value?: number };
    deltaEta: { value?: number };
    iAlpha: { value?: number };
    empowerment: { value?: number };
    strategic: { value?: number };
  }>;
};

export function buildGCCRFSnapshot(state: GCCRFLike | null | undefined): GCCRFSnapshot | null {
  if (!state) return null;
  const n = state.normalizers ?? {};
  const predictionError = Number(n.eta?.value ?? 0) || 0;
  const learningProgress = Number(n.deltaEta?.value ?? 0) || 0;
  const novelty = Number(n.iAlpha?.value ?? 0) || 0;
  const empowerment = clamp01(Number(n.empowerment?.value ?? 0.5) || 0.5);
  const strategicAlignment = clamp01(Number(n.strategic?.value ?? 0.5) || 0.5);

  let certaintyDelta = 0;
  const now = Date.now();
  if (lastGCCRFSample && now - lastGCCRFSample.ts < 5 * 60_000) {
    // Certainty proxy: high empowerment + low predictionError = certain.
    const prevCertainty = lastGCCRFSample.empowerment - 0;
    const curCertainty = empowerment - predictionError * 0.5;
    certaintyDelta = curCertainty - prevCertainty;
  }
  lastGCCRFSample = { ts: now, empowerment, strategicAlignment };

  return Object.freeze({
    predictionError,
    learningProgress,
    novelty,
    empowerment,
    strategicAlignment,
    certaintyDelta,
  });
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export const __testing = {
  resetGCCRFSampleForTest(): void {
    lastGCCRFSample = null;
  },
};
