/**
 * PLAN-45 Phase 3.3: the post-promotion monitor's statistics.
 *
 * A canary skill is shown to a hash-bucketed share of eligible runs. The
 * monitor compares the runs that saw AND read it (exposed, credited) with
 * the eligible runs that did not see it (unexposed) on the same window,
 * using the run labels the labeler already produces. Two cohorts, binary
 * outcomes, small n: a one-sided Fisher exact test on the 2x2 table is the
 * right tool (no normal approximation at n=8), asking "is the exposed pass
 * rate LOWER than the unexposed one?". Graduation is non-inferiority over a
 * window, not a proof of improvement: the gate already proved improvement
 * on held-out tasks; the monitor's job is to catch what the gate missed in
 * production.
 *
 * Pure functions; the monitor module wires them to the ledgers.
 */

export const MONITOR_MIN_EXPOSED = 8;
export const MONITOR_MIN_UNEXPOSED = 8;
/** Family-wise alpha over the whole canary window. */
export const MONITOR_ALPHA = 0.05;
/**
 * Adversarial 3-5: the regression test is a LOOK, not a poll. It runs only
 * when the exposed cohort first crosses one of these sizes, each look at
 * MONITOR_ALPHA / looks (Bonferroni), so repeated housekeeping passes do
 * not inflate the false-rollback rate.
 */
export const MONITOR_CHECKPOINTS = [8, 16, 32, 64] as const;
export const MONITOR_ALPHA_PER_LOOK = MONITOR_ALPHA / MONITOR_CHECKPOINTS.length;
/** Exposed eligible runs after which a non-regressing canary graduates. */
export const CANARY_GRADUATE_RUNS = 20;
/** Days after which a non-regressing canary graduates regardless of run count (with evidence). */
export const CANARY_GRADUATE_DAYS = 14;
/** Hard ceiling: past this age the window closes on whatever evidence exists. */
export const CANARY_MAX_DAYS = 28;
/** Eligible exposed runs with zero reads after which a canary is retired (never fires). */
export const CANARY_RETIRE_ZERO_READS_RUNS = 20;

export interface Cohort {
  /** Runs with a determinate label. */
  n: number;
  pass: number;
}

export interface FisherResult {
  /** P(exposed passes <= observed | margins), one-sided "exposed worse". */
  pValue: number;
  exposedRate: number | null;
  unexposedRate: number | null;
  /** exposedRate - unexposedRate when both exist. */
  gap: number | null;
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return Number.NEGATIVE_INFINITY;
  }
  let s = 0;
  for (let i = 1; i <= k; i++) {
    s += Math.log(n - k + i) - Math.log(i);
  }
  return s;
}

/**
 * One-sided Fisher exact test on
 *   exposed:   pass a, fail b
 *   unexposed: pass c, fail d
 * H1: the exposed pass rate is lower. p = sum over tables with exposed
 * passes <= a, hypergeometric with fixed margins.
 */
export function fisherExposedWorse(exposed: Cohort, unexposed: Cohort): FisherResult {
  const a = exposed.pass;
  const rowE = exposed.n;
  const rowU = unexposed.n;
  const colPass = exposed.pass + unexposed.pass;
  const total = rowE + rowU;
  const exposedRate = rowE > 0 ? exposed.pass / rowE : null;
  const unexposedRate = rowU > 0 ? unexposed.pass / rowU : null;
  const gap = exposedRate !== null && unexposedRate !== null ? exposedRate - unexposedRate : null;
  if (rowE === 0 || rowU === 0) {
    return { pValue: 1, exposedRate, unexposedRate, gap };
  }
  const denom = logChoose(total, colPass);
  let p = 0;
  const lo = Math.max(0, colPass - rowU);
  for (let x = lo; x <= a; x++) {
    const num = logChoose(rowE, x) + logChoose(rowU, colPass - x);
    if (Number.isFinite(num)) {
      p += Math.exp(num - denom);
    }
  }
  return { pValue: Math.min(1, p), exposedRate, unexposedRate, gap };
}

export type CanaryDecision =
  | { action: "continue"; reason: string; checkpoint?: number }
  | { action: "rollback"; reason: string; pValue: number; gap: number; checkpoint: number }
  | { action: "retire"; reason: string }
  | { action: "graduate"; reason: string };

export interface CanaryWindowState {
  startedAt: number;
  now: number;
  /** Eligible runs that had the skill in their index (read or not). */
  exposedEligible: number;
  /**
   * Intention-to-treat: eligible runs that had the skill in their index,
   * read or not, with a determinate label. Whether the agent opened the
   * skill is a post-treatment choice and must not select the cohort
   * (adversarial 3-2).
   */
  exposed: Cohort;
  /** Eligible runs that did not have the skill in their index (and did not read it), determinate labels. */
  unexposed: Cohort;
  /** Credited reads over the whole window (any label). */
  reads: number;
  /** Checkpoints already looked at (persisted on the meta between passes). */
  checkpointsDone?: readonly number[];
}

/**
 * The monitor's decision for one canary skill.
 *   1. At a fresh checkpoint with enough control runs, the exposed cohort is
 *      significantly worse -> rollback (the gate missed a regression).
 *   2. Many eligible exposures (or the max age) and not a single read ->
 *      retire (the skill never fires where it should; D-5).
 *   3. Window elapsed (runs or days) WITH evidence (reads, >= minExposed
 *      determinate exposed runs) and no regression -> graduate to stable;
 *      at the max age any read evidence graduates (thin, said so).
 *   4. Otherwise keep watching.
 */
export function decideCanary(
  s: CanaryWindowState,
  opts: {
    alphaPerLook?: number;
    checkpoints?: readonly number[];
    minExposed?: number;
    minUnexposed?: number;
    graduateRuns?: number;
    graduateDays?: number;
    maxDays?: number;
    retireZeroReadsRuns?: number;
  } = {},
): CanaryDecision {
  const alpha = opts.alphaPerLook ?? MONITOR_ALPHA_PER_LOOK;
  const checkpoints = opts.checkpoints ?? MONITOR_CHECKPOINTS;
  const minExposed = opts.minExposed ?? MONITOR_MIN_EXPOSED;
  const minUnexposed = opts.minUnexposed ?? MONITOR_MIN_UNEXPOSED;
  const graduateRuns = opts.graduateRuns ?? CANARY_GRADUATE_RUNS;
  const graduateDays = opts.graduateDays ?? CANARY_GRADUATE_DAYS;
  const maxDays = opts.maxDays ?? CANARY_MAX_DAYS;
  const retireZeroReads = opts.retireZeroReadsRuns ?? CANARY_RETIRE_ZERO_READS_RUNS;
  const ageDays = (s.now - s.startedAt) / (24 * 60 * 60 * 1000);
  const done = new Set(s.checkpointsDone ?? []);
  const due = checkpoints.filter((c) => c <= s.exposed.n && !done.has(c));
  const look = due.length > 0 ? Math.max(...due) : null;
  const pct = (x: number | null) => `${((x ?? 0) * 100).toFixed(0)}%`;

  let looked: number | undefined;
  if (look !== null && s.unexposed.n >= minUnexposed) {
    looked = look;
    const f = fisherExposedWorse(s.exposed, s.unexposed);
    if (f.pValue < alpha && (f.gap ?? 0) < 0) {
      return {
        action: "rollback",
        reason: `exposed pass rate ${pct(f.exposedRate)} vs unexposed ${pct(f.unexposedRate)} (n=${s.exposed.n}/${s.unexposed.n}, p=${f.pValue.toFixed(4)} at look ${look}, alpha ${alpha.toFixed(4)})`,
        pValue: f.pValue,
        gap: f.gap ?? 0,
        checkpoint: look,
      };
    }
  }
  if (s.reads === 0 && (s.exposedEligible >= retireZeroReads || ageDays >= maxDays)) {
    return {
      action: "retire",
      reason: `never read in ${s.exposedEligible} eligible exposed runs over ${ageDays.toFixed(1)} days`,
    };
  }
  const windowElapsed = s.exposedEligible >= graduateRuns || ageDays >= graduateDays;
  const hasEvidence = s.reads > 0 && s.exposed.n >= minExposed;
  if ((windowElapsed && hasEvidence) || (ageDays >= maxDays && s.reads > 0)) {
    const f =
      s.exposed.n > 0 && s.unexposed.n > 0 ? fisherExposedWorse(s.exposed, s.unexposed) : null;
    return {
      action: "graduate",
      reason:
        `window complete (${s.exposedEligible} exposed eligible runs, ${ageDays.toFixed(1)} days, ${s.reads} reads${hasEvidence ? "" : "; thin evidence at max age"})` +
        (f
          ? `; exposed ${pct(f.exposedRate)} vs unexposed ${pct(f.unexposedRate)} p=${f.pValue.toFixed(3)}`
          : ""),
    };
  }
  return {
    action: "continue",
    reason: `${s.exposedEligible} exposed eligible runs, ${s.exposed.n}/${s.unexposed.n} determinate, ${s.reads} reads, ${ageDays.toFixed(1)} days`,
    ...(looked !== undefined ? { checkpoint: looked } : {}),
  };
}
