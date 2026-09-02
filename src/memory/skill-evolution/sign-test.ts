/**
 * Corpus/gate upgrade (2026-09-02 research pass): the promotion gate's
 * statistic is an EXACT one-sided sign test on discordant paired deltas.
 *
 * Why not the bootstrap: at the corpus sizes a node actually has (n≈12-50),
 * the percentile bootstrap undercovers (nominal-95% intervals cover
 * ~81-91% at n<20 — Miller arXiv:2411.00640, Bowyer arXiv:2503.01747) and
 * degenerates to a zero-width interval when most deltas are ties, which is
 * exactly the near-ceiling regime a regression suite lives in. The exact
 * sign test is correct at ANY n, never degenerates, and its behavior is
 * legible: promotion needs enough discordant wins (5 clean wins with zero
 * losses ⇒ p = 0.5^5 ≈ 0.031). The bootstrap CI stays as a REPORTED
 * diagnostic (bootstrap-ci.ts), never the gate.
 */

export interface SignTestResult {
  /** Discordant pairs favoring the candidate (delta > 0). */
  wins: number;
  /** Discordant pairs favoring the incumbent (delta < 0). */
  losses: number;
  /** Ties (delta === 0) — carry no information for the sign test. */
  ties: number;
  /** wins + losses. */
  discordant: number;
  /**
   * One-sided exact binomial p-value: P(X >= wins | Binomial(discordant,
   * 0.5)). 1 when there are no discordant pairs (no evidence either way).
   */
  pValue: number;
}

/** Exact one-sided sign test over paired deltas (candidate minus incumbent). */
export function exactSignTest(deltas: readonly number[]): SignTestResult {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const d of deltas) {
    if (d > 0) {
      wins += 1;
    } else if (d < 0) {
      losses += 1;
    } else {
      ties += 1;
    }
  }
  const discordant = wins + losses;
  if (discordant === 0) {
    return { wins, losses, ties, discordant, pValue: 1 };
  }
  // Upper binomial tail at p=0.5, computed exactly. discordant is bounded
  // by the corpus size (<=50), so direct summation is fine; use log-space
  // binomials to stay stable anyway.
  let tail = 0;
  for (let k = wins; k <= discordant; k++) {
    tail += Math.exp(logChoose(discordant, k) - discordant * Math.LN2);
  }
  return { wins, losses, ties, discordant, pValue: Math.min(1, tail) };
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const logFactorialCache: number[] = [0, 0];

function logFactorial(n: number): number {
  for (let i = logFactorialCache.length; i <= n; i++) {
    logFactorialCache[i] = (logFactorialCache[i - 1] as number) + Math.log(i);
  }
  return logFactorialCache[n] as number;
}
