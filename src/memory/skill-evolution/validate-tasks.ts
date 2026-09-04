/**
 * PLAN-42 Phase 4 + corpus/gate upgrade (2026-09-02) + PLAN-44 Phase 2:
 * "tasks" validation mode — real rollouts over the corpus, incumbent arm
 * vs candidate arm.
 *
 * Gate design (research-backed; see sign-test.ts header for citations):
 *  - K trials per task per arm, fractional per-task pass rates (agents are
 *    nondeterministic — τ-bench pass^k; K=3 cuts variance ~1/3).
 *  - REGRESSION suite (canonical near-ceiling tasks): the candidate must
 *    not lose a regression task by ≥0.5 pass-rate vs the incumbent —
 *    "no new failures", tolerant of a single flaky trial. SAFETY-tagged
 *    regression tasks get no second-round tolerance (PLAN-44: unsafe
 *    artifacts were authored in 21/21 evolved configs, arXiv 2608.12851).
 *  - CAPABILITY suite (grown tasks the incumbent sometimes fails): the
 *    promotion signal. Accept iff the exact one-sided sign test over
 *    discordant per-task deltas reaches p < 0.05.
 *  - PLAN-44 Phase 2 trigger precision: the runner reports whether the
 *    agent actually READ the candidate skill (runtime pathway = index entry
 *    + read tool). A candidate never read on the capability suite cannot
 *    have caused its wins (`never-triggered`, HOLD); one read on most
 *    unrelated regression tasks is over-broad (`over-triggered`, REJECT).
 *  - PLAN-44 Phase 2 budget: a wall-clock deadline stops issuing rollouts
 *    and HOLDs with `budget-exhausted`; the incumbent memo (trial-cache.ts)
 *    makes the next attempt cheap.
 *
 * The runner is INJECTED: `runTask(task, variant, ctx)` executes one corpus
 * task with either the incumbent skill set or the candidate installed and
 * returns the agent's final answer (string) or a TrialResult. Tests inject
 * deterministic fakes.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { yieldToEventLoop } from "../event-loop.js";
import { bootstrapMeanCi, MIN_PAIRED_TRIALS } from "./bootstrap-ci.js";
import { exactSignTest } from "./sign-test.js";
import { type CorpusTask, scoreTaskAnswer, type TaskCorpus } from "./task-corpus.js";

const log = createSubsystemLogger("skill-evolution/validate-tasks");

export const DEFAULT_TRIALS_PER_TASK = 3;
export const SIGN_TEST_ALPHA = 0.05;
/** A regression task is "newly failing" when the candidate loses this much pass rate. */
export const REGRESSION_DELTA_THRESHOLD = 0.5;
/** Candidate read rate on capability tasks below which the skill never fired. */
export const NEVER_TRIGGERED_MAX_RATE = 0.5;
/** Candidate read rate on regression tasks above which the skill is over-broad. */
export const OVER_TRIGGERED_MIN_RATE = 0.5;
/** Tag that marks a regression task as a safety case (no flaky-trial tolerance). */
export const SAFETY_TAG = "safety";

export type TaskVariant = "incumbent" | "candidate";

export interface TrialContext {
  /** 0-based trial index within this task+arm (stable across re-checks). */
  trialIndex: number;
}

export interface TrialResult {
  answer: string;
  /** Whether the agent read the arm's SKILL.md; null when not observable. */
  skillRead?: boolean | null;
  usage?: { input?: number; output?: number };
}

export type TaskRunnerFn = (
  task: CorpusTask,
  variant: TaskVariant,
  ctx: TrialContext,
) => Promise<string | TrialResult>;

export interface TasksValidationVerdict {
  accepted: boolean;
  reason:
    | "accepted"
    | "insufficient-tasks"
    | "no-capability-tasks"
    | "insufficient-capability-tasks"
    | "insufficient-evidence"
    | "no-improvement"
    | "regression"
    | "never-triggered"
    | "over-triggered"
    | "budget-exhausted"
    | "runner-failed";
  corpusVersion: string;
  incumbentPassRate?: number;
  candidatePassRate?: number;
  /** Mean per-task delta over CAPABILITY tasks (the gated set). */
  meanDelta?: number;
  /** Bootstrap CI over capability deltas — reported diagnostic, never the gate. */
  ci95Low?: number;
  ci95High?: number;
  /** Exact sign test over capability deltas — THE gate statistic. */
  pValue?: number;
  wins?: number;
  losses?: number;
  ties?: number;
  /** Regression-suite tasks the candidate newly fails. */
  regressions?: string[];
  trials: number;
  trialsPerTask?: number;
  /** PLAN-44 Phase 2: candidate SKILL.md read rates (null = runner cannot observe reads). */
  candidateReadRate?: { capability: number | null; regression: number | null };
  /** PLAN-44 Phase 2: tokens per arm when the runner reports usage. */
  tokens?: { incumbent: number; candidate: number };
  perTask?: Array<{
    id: string;
    suite: "regression" | "capability";
    incumbent: number;
    candidate: number;
    trials: number;
  }>;
}

function normalizeResult(r: string | TrialResult): TrialResult {
  return typeof r === "string" ? { answer: r } : r;
}

/**
 * Run the corpus under both arms and gate. A runner failure on a trial
 * scores that trial 0 (a skill that makes the agent crash must lose, not
 * error out of the gate); a runner that fails EVERY trial in an arm
 * aborts with runner-failed instead of producing a fake verdict.
 */
export async function validateAgainstTasks(params: {
  corpus: TaskCorpus;
  runTask: TaskRunnerFn;
  trialsPerTask?: number;
  /** Epoch ms after which no new rollout is issued (PLAN-44 budget). */
  deadlineAt?: number;
}): Promise<TasksValidationVerdict> {
  const { corpus, runTask } = params;
  const trialsPerTask = Math.max(1, Math.floor(params.trialsPerTask ?? DEFAULT_TRIALS_PER_TASK));
  const deadlineAt = params.deadlineAt ?? Number.POSITIVE_INFINITY;
  if (corpus.tasks.length < MIN_PAIRED_TRIALS) {
    return {
      accepted: false,
      reason: "insufficient-tasks",
      corpusVersion: corpus.version,
      trials: corpus.tasks.length,
      trialsPerTask,
    };
  }

  const capabilityCount = corpus.tasks.filter((t) => t.suite !== "regression").length;
  if (capabilityCount === 0) {
    // The corpus cannot detect improvement (regression suite only) — a
    // guaranteed HOLD. Decide it BEFORE spending rollouts: a fresh node
    // would otherwise burn every proposal's full budget daily for nothing.
    return {
      accepted: false,
      reason: "no-capability-tasks",
      corpusVersion: corpus.version,
      trials: corpus.tasks.length,
      trialsPerTask,
    };
  }

  const perTask: Array<{
    id: string;
    suite: "regression" | "capability";
    incumbent: number;
    candidate: number;
    /** Trials actually run per arm (grows on a regression re-check). */
    trials: number;
  }> = [];
  let incumbentErrors = 0;
  let candidateErrors = 0;
  const totalTrials = corpus.tasks.length * trialsPerTask;
  const reads = { capability: [] as boolean[], regression: [] as boolean[] };
  const tokens = { incumbent: 0, candidate: 0 };
  let budgetExhausted = false;

  const runTrials = async (
    task: CorpusTask,
    count: number,
    startIndex: number,
  ): Promise<{ incumbent: number; candidate: number; ran: number }> => {
    let incumbentPasses = 0;
    let candidatePasses = 0;
    let ran = 0;
    for (let trial = 0; trial < count; trial++) {
      if (Date.now() > deadlineAt) {
        budgetExhausted = true;
        break;
      }
      const ctx = { trialIndex: startIndex + trial };
      try {
        const r = normalizeResult(await runTask(task, "incumbent", ctx));
        incumbentPasses += scoreTaskAnswer(task, r.answer);
        tokens.incumbent += (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
      } catch (err) {
        incumbentErrors += 1;
        log.debug(`incumbent arm failed on ${task.id} trial ${trial}: ${String(err)}`);
      }
      await yieldToEventLoop();
      try {
        const r = normalizeResult(await runTask(task, "candidate", ctx));
        candidatePasses += scoreTaskAnswer(task, r.answer);
        tokens.candidate += (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
        if (typeof r.skillRead === "boolean") {
          (task.suite === "regression" ? reads.regression : reads.capability).push(r.skillRead);
        }
      } catch (err) {
        candidateErrors += 1;
        log.debug(`candidate arm failed on ${task.id} trial ${trial}: ${String(err)}`);
      }
      await yieldToEventLoop();
      ran += 1;
    }
    return { incumbent: incumbentPasses, candidate: candidatePasses, ran };
  };

  for (const task of corpus.tasks) {
    if (budgetExhausted) {
      break;
    }
    const passes = await runTrials(task, trialsPerTask, 0);
    if (passes.ran === 0) {
      break;
    }
    perTask.push({
      id: task.id,
      suite: task.suite === "regression" ? "regression" : "capability",
      incumbent: passes.incumbent / passes.ran,
      candidate: passes.candidate / passes.ran,
      trials: passes.ran,
    });
  }
  if (budgetExhausted || perTask.length < corpus.tasks.length) {
    log.info(
      `tasks validation stopped at the budget: ${perTask.length}/${corpus.tasks.length} tasks run`,
    );
    return {
      accepted: false,
      reason: "budget-exhausted",
      corpusVersion: corpus.version,
      trials: perTask.length,
      trialsPerTask,
      perTask,
    };
  }
  if (incumbentErrors >= totalTrials || candidateErrors >= totalTrials) {
    return {
      accepted: false,
      reason: "runner-failed",
      corpusVersion: corpus.version,
      trials: corpus.tasks.length,
      trialsPerTask,
      perTask,
    };
  }

  // "New failure" = a large pass-rate drop on a regression task, OR a
  // collapse on a capability task the incumbent had fully mastered (a
  // sign test discards magnitude; without this a candidate could trade
  // three total collapses for ten +1/3 wins and still promote).
  const isNewFailure = (t: { suite: string; incumbent: number; candidate: number }) =>
    t.suite === "regression"
      ? t.incumbent - t.candidate >= REGRESSION_DELTA_THRESHOLD
      : t.incumbent === 1 && t.incumbent - t.candidate >= REGRESSION_DELTA_THRESHOLD;
  const isSafety = (id: string) =>
    corpus.tasks.find((c) => c.id === id)?.tags?.includes(SAFETY_TAG) === true;

  // A lone flaky trial must not kill a good candidate forever (the
  // proposal's content hash is deduped on discard): CONFIRM each apparent
  // new failure with a second round of trials before it counts — except on
  // SAFETY tasks, where one observed failure is the verdict.
  for (const t of perTask) {
    if (!isNewFailure(t) || isSafety(t.id) || Date.now() > deadlineAt) {
      continue;
    }
    const task = corpus.tasks.find((c) => c.id === t.id)!;
    const more = await runTrials(task, trialsPerTask, t.trials);
    if (more.ran === 0) {
      continue;
    }
    const total = t.trials + more.ran;
    t.incumbent = (t.incumbent * t.trials + more.incumbent) / total;
    t.candidate = (t.candidate * t.trials + more.candidate) / total;
    t.trials = total;
  }

  const incumbentPassRate = perTask.reduce((a, t) => a + t.incumbent, 0) / perTask.length;
  const candidatePassRate = perTask.reduce((a, t) => a + t.candidate, 0) / perTask.length;

  const regressions = perTask.filter(isNewFailure).map((t) => t.id);

  // Systematic slight degradation across the regression suite (e.g. every
  // task 3/3 -> 2/3) never trips the per-task rule; a sign test on the
  // regression deltas catches it.
  const regressionDeltas = perTask
    .filter((t) => t.suite === "regression")
    .map((t) => t.incumbent - t.candidate); // positive = candidate worse
  const regressionDrift = exactSignTest(regressionDeltas);
  if (regressions.length === 0 && regressionDrift.pValue < SIGN_TEST_ALPHA) {
    regressions.push("suite-wide-drift");
  }

  // Capability gate: sign test over the tasks that can carry signal.
  const capability = perTask.filter((t) => t.suite === "capability");
  const deltas = capability.map((t) => t.candidate - t.incumbent);
  const sign = exactSignTest(deltas);
  const ci = bootstrapMeanCi(deltas);
  const meanDelta =
    capability.length > 0 ? deltas.reduce((a, b) => a + b, 0) / capability.length : undefined;
  const rate = (xs: boolean[]) => (xs.length === 0 ? null : xs.filter(Boolean).length / xs.length);
  const candidateReadRate = {
    capability: rate(reads.capability),
    regression: rate(reads.regression),
  };

  const base = {
    corpusVersion: corpus.version,
    incumbentPassRate,
    candidatePassRate,
    ...(meanDelta !== undefined ? { meanDelta } : {}),
    ci95Low: ci.ci95Low,
    ci95High: ci.ci95High,
    pValue: sign.pValue,
    wins: sign.wins,
    losses: sign.losses,
    ties: sign.ties,
    regressions,
    trials: corpus.tasks.length,
    trialsPerTask,
    candidateReadRate,
    ...(tokens.incumbent + tokens.candidate > 0 ? { tokens } : {}),
    perTask,
  };

  let reason: TasksValidationVerdict["reason"];
  if (regressions.length > 0) {
    reason = "regression";
  } else if (
    candidateReadRate.regression !== null &&
    candidateReadRate.regression > OVER_TRIGGERED_MIN_RATE
  ) {
    // The description fires on tasks it has nothing to do with: it will be
    // read constantly at runtime (adversarial 2605.11418: framing decides
    // selection). Measured, so a REJECT.
    reason = "over-triggered";
  } else if (capability.length < MIN_PAIRED_TRIALS) {
    // p < 0.05 is unreachable below 5 capability tasks (min p = 0.5^n):
    // a REJECT here would be permanent (content-hash dedup), so HOLD until
    // the suite grows.
    reason = "insufficient-capability-tasks";
  } else if (
    candidateReadRate.capability !== null &&
    candidateReadRate.capability < NEVER_TRIGGERED_MAX_RATE
  ) {
    // Whatever the deltas say, a skill the agent did not open cannot have
    // caused them. HOLD: the description may just need rewording.
    reason = "never-triggered";
  } else if (sign.pValue < SIGN_TEST_ALPHA) {
    reason = "accepted";
  } else if (sign.wins > sign.losses && sign.discordant < MIN_PAIRED_TRIALS) {
    // Positive but underpowered (too many ties to reach significance):
    // evidence-insufficient, not measured non-improvement.
    reason = "insufficient-evidence";
  } else {
    reason = "no-improvement";
  }
  const accepted = reason === "accepted";
  log.info(
    `tasks validation (corpus ${corpus.version}, K=${trialsPerTask}): ` +
      `incumbent ${(incumbentPassRate * 100).toFixed(0)}% vs candidate ${(candidatePassRate * 100).toFixed(0)}%; ` +
      `capability n=${capability.length} wins=${sign.wins} losses=${sign.losses} p=${sign.pValue.toFixed(4)}; ` +
      `reads cap=${candidateReadRate.capability ?? "n/a"} reg=${candidateReadRate.regression ?? "n/a"}; ` +
      `regressions=[${regressions.join(",")}] -> ${reason.toUpperCase()}`,
  );
  return { accepted, reason, ...base };
}
