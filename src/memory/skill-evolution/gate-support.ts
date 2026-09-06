/**
 * PLAN-44 Phase 2: validation-gate support — the trial memo wrapper, the
 * hold backoff policy, and the stale trial sweep. Split out of
 * validation-gate.ts (500-line cap).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import type { TaskRunnerFn } from "./validate-tasks.js";
import { CANONICAL_GENERATOR_VERSION } from "./canonical-corpus.js";
import { trialsRoot } from "./task-runner.js";
import { promptHash, type TrialCache } from "./trial-cache.js";

/**
 * PLAN-44 Phase 2: serve trials from the memo. Both arms are keyed by the
 * ARM's content hash (a create's incumbent is "none"), so a budget-
 * exhausted retry resumes instead of restarting (adversarial H2) and every
 * create on a model shares the no-skill incumbent. Only non-empty answers
 * are cached (adversarial H4: a provider hiccup must not freeze a 0 for 30
 * days). Read failures fall through to a real run.
 */
export function memoizeTrials(
  runTask: TaskRunnerFn,
  params: {
    cache: TrialCache | null;
    candidateHash: string;
    incumbentHash: string;
    modelTag: string;
    onHit: (variant: "incumbent" | "candidate") => void;
  },
): TaskRunnerFn {
  return async (task, variant, ctx) => {
    const key = {
      taskId: task.id,
      promptHash: promptHash(task.prompt),
      incumbentHash: variant === "candidate" ? params.candidateHash : params.incumbentHash,
      modelTag: params.modelTag,
      generatorVersion: CANONICAL_GENERATOR_VERSION,
      trialIndex: ctx.trialIndex,
      profile: RUNNER_PROFILE,
    };
    const hit = params.cache?.get(key);
    if (hit) {
      params.onHit(variant);
      // PLAN-45 2.5: a memo hit carries the original cost so the token /
      // wall-time comparison is not biased toward the cached arm.
      return {
        answer: hit.answer,
        skillRead: hit.skillRead,
        ...(hit.usage ? { usage: hit.usage } : {}),
        ...(hit.wallMs !== null ? { wallMs: hit.wallMs } : {}),
      };
    }
    const started = Date.now();
    const result = await runTask(task, variant, ctx);
    const r = typeof result === "string" ? { answer: result } : result;
    if (r.answer.trim().length > 0) {
      params.cache?.put(key, {
        score: 0, // the validator re-scores from the answer
        answer: r.answer,
        skillRead: typeof r.skillRead === "boolean" ? r.skillRead : null,
        usage: r.usage ?? null,
        wallMs: r.wallMs ?? Date.now() - started,
      });
    }
    return result;
  };
}

/** Hold verdicts that are retried only after HOLD_BACKOFF_MS unless content or corpus changed. */
export const HOLD_BACKOFF_MS = 24 * 60 * 60 * 1000;
// budget-exhausted is deliberately NOT here: the memo makes its retry a
// resume, so it runs again next pass.
export const HOLD_BACKOFF_VERDICTS = new Set([
  "never-triggered",
  "insufficient-evidence",
  "insufficient-trials",
]);
/** PLAN-45 2.5 (adversarial M1): the same body costs the same tokens tomorrow; only a content change re-measures. */
export const CONTENT_CHANGE_VERDICTS = new Set(["cost-exceeded"]);
/**
 * PLAN-45 2.3 (adversarial M6): part of the memo key. Bump when the trial
 * runner or the validation prompt shape changes so cached trials from the
 * previous shape are never replayed against fresh ones.
 */
export const RUNNER_PROFILE = "runtime-pathway/full-prompt/v2";

/** Remove trial dirs left behind by a crash (older than a day). */
export async function sweepStaleTrials(trailOpts: ImpactTrailOptions): Promise<void> {
  const root = trialsRoot(trailOpts);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - HOLD_BACKOFF_MS;
  for (const name of entries) {
    const p = path.join(root, name);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
