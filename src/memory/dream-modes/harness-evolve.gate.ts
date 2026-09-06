// PLAN-25 Phase 2/5: the Proposal Validation gate for harness-policy edits.
// Reuses the PLAN-21 statistical spine (bootstrapPairedCI) verbatim, applied to
// a GLOBAL held-out trace set. A candidate is accepted only if it is minimal,
// faithful (removes no protected surface), and statistically beats the live
// policy with 95% confidence (ci95Low > 0) — the same acceptance bar the skill
// gate uses, which is strictly stronger than Self-Harness's point Δ>0 rule.

import {
  type HarnessPolicy,
  policyDiffSummary,
  serializePolicyForJudge,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import {
  bootstrapPairedCI,
  type ScorePairFn,
  type StatisticalResult,
} from "../experiment-sandbox.js";
import { type HeldOutExecution, MIN_PAIRED_FOR_BOOTSTRAP } from "../skill-execution-selection.js";

export interface HarnessGateOptions {
  /** Minimality cap: reject candidates that touch more than this many fields. */
  maxChanges?: number;
  bootstrapIterations?: number;
  random?: () => number;
  /** Fragment ids that must never be removed by an autonomous edit. */
  protectedFragmentIds?: ReadonlySet<string>;
}

export interface HarnessGateVerdict {
  accepted: boolean;
  reason:
    | "accepted"
    | "no-op"
    | "not-minimal"
    | "faithfulness-removed-protected"
    | "insufficient-data"
    | "no-improvement"
    | "ci-includes-zero";
  changeCount: number;
  surfacesTouched: string[];
  delta?: number;
  statistical?: StatisticalResult;
}

const DEFAULT_MAX_CHANGES = 6;

/**
 * Evaluate one candidate harness policy against the live policy. Pure with
 * respect to its inputs (scorePair is injected), so it is fully unit-testable
 * with a deterministic scorer and a seeded RNG.
 */
export async function evaluateHarnessCandidate(args: {
  live: HarnessPolicy;
  candidate: HarnessPolicy;
  selectionSet: ReadonlyArray<HeldOutExecution>;
  scorePair: ScorePairFn;
  options?: HarnessGateOptions;
}): Promise<HarnessGateVerdict> {
  const { live, candidate, selectionSet, scorePair } = args;
  const opts = args.options ?? {};
  const diff = policyDiffSummary(live, candidate);
  const base = { changeCount: diff.changeCount, surfacesTouched: diff.surfacesTouched };

  // 1. Minimality (Self-Harness: modify only the necessary surfaces).
  if (diff.changeCount === 0) return { accepted: false, reason: "no-op", ...base };
  if (diff.changeCount > (opts.maxChanges ?? DEFAULT_MAX_CHANGES))
    return { accepted: false, reason: "not-minimal", ...base };

  // 2. Faithfulness: never silently strip a protected instruction.
  const protectedIds = opts.protectedFragmentIds;
  if (protectedIds && protectedIds.size > 0) {
    const candFragIds = new Set(candidate.prompt.fragments.map((f) => f.id));
    for (const f of live.prompt.fragments) {
      if (protectedIds.has(f.id) && !candFragIds.has(f.id))
        return { accepted: false, reason: "faithfulness-removed-protected", ...base };
    }
  }

  // 3. Performance gate: need enough held-out trials to validate at all.
  if (selectionSet.length < MIN_PAIRED_FOR_BOOTSTRAP)
    return { accepted: false, reason: "insufficient-data", ...base };

  const paired = await scorePair(
    serializePolicyForJudge(live),
    serializePolicyForJudge(candidate),
    selectionSet,
  );
  // Map to the spine's PairedOutcome shape (structural) and reuse its bootstrap.
  const outcomes = paired.map((p) => ({
    executionId: p.taskId,
    originalPassed: p.aPassed,
    mutatedPassed: p.bPassed,
  }));
  const statistical = bootstrapPairedCI(
    outcomes,
    opts.bootstrapIterations,
    opts.random ?? Math.random,
  );

  // 4. Acceptance: candidate strictly better with 95% confidence.
  if (statistical.ci95Low > 0)
    return { accepted: true, reason: "accepted", delta: statistical.delta, statistical, ...base };
  return {
    accepted: false,
    reason: statistical.delta <= 0 ? "no-improvement" : "ci-includes-zero",
    delta: statistical.delta,
    statistical,
    ...base,
  };
}
