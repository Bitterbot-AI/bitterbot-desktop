// PLAN-25 Phase 6: longitudinal slow update + auto-quarantine for harness
// policies. Periodically re-scores the live policy against recent archived
// versions on the held-out set; if the live policy is SIGNIFICANTLY WORSE than
// an archived one (ci95High < 0), it auto-rolls-back. This is the safety net
// that makes "on by default" safe: a promotion that looked good but regresses
// in the longer run is reverted without a human.

import type { PolicyVersionRef } from "../../agents/pi-embedded-runner/harness-policy-store.js";
import {
  type HarnessPolicy,
  serializePolicyForJudge,
} from "../../agents/pi-embedded-runner/harness-policy.js";
import { bootstrapPairedCI, type ScorePairFn } from "../experiment-sandbox.js";
import { type HeldOutExecution, MIN_PAIRED_FOR_BOOTSTRAP } from "../skill-execution-selection.js";

export interface HarnessSlowUpdateResult {
  rolledBackTo: number | null;
  comparisons: Array<{ version: number; delta: number; ci95Low: number; ci95High: number }>;
}

/**
 * Compare the live policy against archived versions (newest first). Rolls back to
 * the first archived version that the live policy is significantly worse than.
 */
export async function runHarnessSlowUpdate(args: {
  live: HarnessPolicy;
  history: PolicyVersionRef[];
  selectionSet: ReadonlyArray<HeldOutExecution>;
  scorePair: ScorePairFn;
  rollback: (version: number, reason: string) => Promise<HarnessPolicy | null>;
  options?: { bootstrapIterations?: number; random?: () => number };
}): Promise<HarnessSlowUpdateResult> {
  const comparisons: HarnessSlowUpdateResult["comparisons"] = [];
  if (args.selectionSet.length < MIN_PAIRED_FOR_BOOTSTRAP || args.history.length === 0)
    return { rolledBackTo: null, comparisons };

  const liveText = serializePolicyForJudge(args.live);
  for (const ref of args.history) {
    // a = archived version, b = live → delta = live - archived.
    const paired = await args.scorePair(
      serializePolicyForJudge(ref.policy),
      liveText,
      args.selectionSet,
    );
    const stat = bootstrapPairedCI(
      paired.map((p) => ({
        executionId: p.taskId,
        originalPassed: p.aPassed,
        mutatedPassed: p.bPassed,
      })),
      args.options?.bootstrapIterations,
      args.options?.random ?? Math.random,
    );
    comparisons.push({
      version: ref.version,
      delta: stat.delta,
      ci95Low: stat.ci95Low,
      ci95High: stat.ci95High,
    });
    // Live significantly worse than this archived version → quarantine.
    if (stat.ci95High < 0) {
      const restored = await args.rollback(
        ref.version,
        `slow-update regression: live worse than v${ref.version} (delta=${stat.delta.toFixed(3)})`,
      );
      return { rolledBackTo: restored ? ref.version : null, comparisons };
    }
  }
  return { rolledBackTo: null, comparisons };
}
