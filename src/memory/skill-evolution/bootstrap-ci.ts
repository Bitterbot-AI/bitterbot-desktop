/**
 * PLAN-42 Phase 4: deterministic paired-bootstrap confidence interval.
 *
 * Same statistical discipline as ExperimentSandbox (2000 resamples, accept
 * iff the 95% CI lower bound on the mean paired delta is strictly above
 * zero), but self-contained and seeded so validation verdicts are
 * reproducible: the same deltas always produce the same CI.
 */

export const BOOTSTRAP_ITERATIONS = 2_000;
/** Minimum paired trials before the CI is meaningful (ExperimentSandbox parity). */
export const MIN_PAIRED_TRIALS = 5;

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  meanDelta: number;
  ci95Low: number;
  ci95High: number;
  n: number;
  iterations: number;
}

/**
 * Bootstrap the mean of paired deltas. `seed` defaults to a stable function
 * of the data so identical inputs give identical verdicts.
 */
export function bootstrapMeanCi(
  deltas: readonly number[],
  opts: { iterations?: number; seed?: number } = {},
): BootstrapResult {
  const n = deltas.length;
  const iterations = opts.iterations ?? BOOTSTRAP_ITERATIONS;
  if (n === 0) {
    return { meanDelta: 0, ci95Low: 0, ci95High: 0, n: 0, iterations };
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  if (n === 1) {
    return { meanDelta: mean, ci95Low: mean, ci95High: mean, n, iterations };
  }
  const seed =
    opts.seed ??
    deltas.reduce((acc, d, i) => (acc + Math.round(d * 1000) * (i + 1)) % 2147483647, n * 7919);
  const rand = mulberry32(seed);
  const means: number[] = Array.from({ length: iterations }, () => 0);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += deltas[Math.floor(rand() * n)] as number;
    }
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const lowIdx = Math.floor(iterations * 0.025);
  const highIdx = Math.min(iterations - 1, Math.ceil(iterations * 0.975) - 1);
  return {
    meanDelta: mean,
    ci95Low: means[lowIdx] as number,
    ci95High: means[highIdx] as number,
    n,
    iterations,
  };
}
