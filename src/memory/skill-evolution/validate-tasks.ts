/**
 * PLAN-42 Phase 4 + corpus/gate upgrade (2026-09-02) + PLAN-44 Phase 2 +
 * PLAN-45 Phase 2: "tasks" validation mode — real rollouts over the corpus,
 * incumbent arm vs candidate arm.
 *
 * Gate design (research-backed; see sign-test.ts header for citations):
 *  - K trials per task per arm, fractional per-task pass rates (agents are
 *    nondeterministic — τ-bench pass^k; K=3 cuts variance ~1/3).
 *  - REGRESSION suite first (canonical near-ceiling tasks): the candidate
 *    must not lose a regression task by ≥0.5 pass-rate vs the incumbent —
 *    "no new failures", tolerant of a single flaky trial (confirmed with a
 *    second round). SAFETY-tagged tasks get no tolerance. A confirmed
 *    regression rejects BEFORE any capability rollout is spent.
 *  - CAPABILITY suite (grown tasks the incumbent sometimes fails, plus the
 *    canonical capability families): the promotion signal. Accept iff the
 *    exact one-sided sign test over discordant per-task deltas reaches
 *    p < alpha, where alpha is spent across a lineage's attempts (2.4).
 *  - PLAN-45 2.7 (SkillTester rule): a candidate WIN on a capability task
 *    counts only when the agent actually read the skill in that trial;
 *    ambient model capability is never credited to the skill. Losses always
 *    count (the raw candidate rate also feeds the collapse rule).
 *  - PLAN-45 2.4: a Wald SPRT over the running discordant wins/losses stops
 *    the capability loop early on decisive evidence; at truncation the exact
 *    test decides. Regression tasks always run in full.
 *  - PLAN-45 2.5: token cost is a gate dimension. An accepted candidate whose
 *    capability-suite tokens exceed the incumbent's by more than
 *    `maxTokenDelta` HOLDs as `cost-exceeded`.
 *  - Trigger precision (PLAN-44 Phase 2), scoped by PLAN-45 2.1 to the tasks
 *    the skill was written for: the node's grown capability tasks when any
 *    exist, else the canonical families. A candidate never read there cannot
 *    have caused its wins (`never-triggered`, HOLD); reads on most unrelated
 *    regression tasks are over-broad (`over-triggered`, REJECT).
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
/** Candidate read rate on the relevant capability tasks below which the skill never fired. */
export const NEVER_TRIGGERED_MAX_RATE = 0.5;
/** Candidate read rate on regression tasks above which the skill is over-broad. */
export const OVER_TRIGGERED_MIN_RATE = 0.5;
/** Tag that marks a regression task as a safety case (no flaky-trial tolerance). */
export const SAFETY_TAG = "safety";
/** Tag on generator-produced canonical tasks (regression and capability). */
export const CANONICAL_TAG = "canonical";
/** PLAN-45 2.4: SPRT alternative win probability and type-II error. */
export const SPRT_P1 = 0.8;
export const SPRT_BETA = 0.2;
/** PLAN-45 2.5: default ceiling on candidate/incumbent token ratio minus one. */
export const DEFAULT_MAX_TOKEN_DELTA = 0.5;

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
  /** Wall time of the turn when the runner measured it (memo hits carry it). */
  wallMs?: number;
}

export type TaskRunnerFn = (
  task: CorpusTask,
  variant: TaskVariant,
  ctx: TrialContext,
) => Promise<string | TrialResult>;

/**
 * PLAN-45 Phase 2.1: per-model calibration. A CANONICAL capability task
 * whose incumbent pass rate for this model is outside [low, high] after
 * `minTrials` observed trials is dropped from the capability suite: a task
 * the model always passes or never passes cannot show improvement. Grown
 * (node-specific) tasks are never dropped. At least `keepAtLeast` canonical
 * capability tasks survive (the closest to 0.5), so the suite never empties.
 */
export interface GateCalibration {
  incumbentStats: ReadonlyMap<string, { trials: number; passes: number }>;
  minTrials?: number;
  low?: number;
  high?: number;
  keepAtLeast?: number;
}
export const CALIBRATION_MIN_TRIALS = 6;
export const CALIBRATION_LOW = 0.2;
export const CALIBRATION_HIGH = 0.8;
export const CALIBRATION_KEEP_AT_LEAST = 5;

export function isCanonicalTask(t: CorpusTask): boolean {
  return (t.tags ?? []).includes(CANONICAL_TAG);
}

/**
 * The capability tasks a skill is judged for trigger precision against: the
 * node's own grown tasks when any exist (they came from this node's
 * failures), else the canonical families.
 */
export function relevantCapabilityTasks(tasks: readonly CorpusTask[]): CorpusTask[] {
  const capability = tasks.filter((t) => t.suite !== "regression");
  const grown = capability.filter((t) => !isCanonicalTask(t));
  return grown.length > 0 ? grown : capability;
}

export function applyGateCalibration(
  tasks: readonly CorpusTask[],
  cal: GateCalibration | undefined,
): { tasks: CorpusTask[]; dropped: Array<{ id: string; rate: number }> } {
  if (!cal) {
    return { tasks: [...tasks], dropped: [] };
  }
  const minTrials = cal.minTrials ?? CALIBRATION_MIN_TRIALS;
  const low = cal.low ?? CALIBRATION_LOW;
  const high = cal.high ?? CALIBRATION_HIGH;
  const keepAtLeast = cal.keepAtLeast ?? CALIBRATION_KEEP_AT_LEAST;
  const rated = tasks
    .filter((t) => t.suite !== "regression" && isCanonicalTask(t))
    .map((t) => {
      const s = cal.incumbentStats.get(t.id);
      const rate = s && s.trials >= minTrials ? s.passes / s.trials : null;
      return { t, rate };
    });
  const uninformative = rated.filter((r) => r.rate !== null && (r.rate < low || r.rate > high));
  const survivors = rated.length - uninformative.length;
  const dropSet = new Set(uninformative.map((r) => r.t.id));
  if (survivors < keepAtLeast) {
    // Keep the closest-to-0.5 ones until the floor is met.
    const ranked = uninformative.toSorted(
      (a, b) => Math.abs((a.rate ?? 0.5) - 0.5) - Math.abs((b.rate ?? 0.5) - 0.5),
    );
    for (const r of ranked.slice(0, keepAtLeast - survivors)) {
      dropSet.delete(r.t.id);
    }
  }
  const dropped = uninformative
    .filter((r) => dropSet.has(r.t.id))
    .map((r) => ({ id: r.t.id, rate: r.rate as number }));
  return { tasks: tasks.filter((t) => !dropSet.has(t.id)), dropped };
}

// ---------------------------------------------------------------------------
// PLAN-45 2.4: Wald SPRT over paired discordant outcomes
// ---------------------------------------------------------------------------

export interface SprtState {
  wins: number;
  losses: number;
  /** Log-likelihood ratio H1 (p = p1) vs H0 (p = 0.5). */
  llr: number;
  decision: "accept" | "reject" | "continue";
}

/** H0: P(win | discordant) = 0.5; H1: p1. Boundaries A = ln((1-beta)/alpha), B = ln(beta/(1-alpha)). */
export function sprtDecision(
  wins: number,
  losses: number,
  opts: { alpha?: number; beta?: number; p1?: number } = {},
): SprtState {
  const alpha = opts.alpha ?? SIGN_TEST_ALPHA;
  const beta = opts.beta ?? SPRT_BETA;
  const p1 = opts.p1 ?? SPRT_P1;
  const llr = wins * Math.log(p1 / 0.5) + losses * Math.log((1 - p1) / 0.5);
  const upper = Math.log((1 - beta) / alpha);
  const lower = Math.log(beta / (1 - alpha));
  const decision = llr >= upper ? "accept" : llr <= lower ? "reject" : "continue";
  return { wins, losses, llr, decision };
}

// ---------------------------------------------------------------------------

export interface PerTaskResult {
  id: string;
  suite: "regression" | "capability";
  /** Fractional pass rates over the trials run. */
  incumbent: number;
  candidate: number;
  /** PLAN-45 2.7: candidate passes in trials where the skill was read (or reads unobservable). */
  credited: number;
  /** Trials actually run per arm (grows on a regression re-check). */
  trials: number;
  tokens?: { incumbent: number; candidate: number };
  wallMs?: { incumbent: number; candidate: number };
}

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
    | "cost-exceeded"
    | "budget-exhausted"
    | "runner-failed";
  corpusVersion: string;
  incumbentPassRate?: number;
  candidatePassRate?: number;
  /** Mean per-task (credited) delta over CAPABILITY tasks (the gated set). */
  meanDelta?: number;
  /** Bootstrap CI over capability deltas — reported diagnostic, never the gate. */
  ci95Low?: number;
  ci95High?: number;
  /** Exact sign test over capability deltas — THE gate statistic. */
  pValue?: number;
  /** Alpha the verdict was judged at (spent across lineage attempts, PLAN-45 2.4). */
  alpha?: number;
  wins?: number;
  losses?: number;
  ties?: number;
  /** PLAN-45 2.4: the sequential test state when the capability loop ended. */
  sequential?: SprtState & { stoppedEarly: boolean; tasksRun: number; tasksPlanned: number };
  /** Regression-suite tasks the candidate newly fails. */
  regressions?: string[];
  trials: number;
  trialsPerTask?: number;
  /** PLAN-44 Phase 2: candidate SKILL.md read rates (null = runner cannot observe reads). */
  candidateReadRate?: { capability: number | null; regression: number | null };
  /** PLAN-44 Phase 2: tokens per arm when the runner reports usage. */
  tokens?: { incumbent: number; candidate: number };
  /** PLAN-45 2.5: candidate/incumbent capability-suite token ratio minus one, when measurable. */
  tokenDelta?: number;
  maxTokenDelta?: number;
  wallMs?: { incumbent: number; candidate: number };
  /** PLAN-45 Phase 2.1: canonical capability tasks dropped by per-model calibration. */
  calibrationDropped?: Array<{ id: string; rate: number }>;
  perTask?: PerTaskResult[];
}

function normalizeResult(r: string | TrialResult): TrialResult {
  return typeof r === "string" ? { answer: r } : r;
}

/**
 * PLAN-45 2.7 (adversarial C1): the paired outcome of one task. A WIN needs
 * the candidate to beat the incumbent WITH the skill read (credited); a
 * LOSS needs the raw candidate to do worse than the incumbent; a candidate
 * that passed without opening the skill is a TIE, never a loss.
 */
export function pairedDelta(t: { incumbent: number; candidate: number; credited: number }): number {
  if (t.credited > t.incumbent) {
    return t.credited - t.incumbent;
  }
  if (t.candidate < t.incumbent) {
    return t.candidate - t.incumbent;
  }
  return 0;
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
  /** PLAN-45 Phase 2.1: drop canonical capability tasks this model cannot show improvement on. */
  calibration?: GateCalibration;
  /** PLAN-45 2.4: significance level for this attempt (alpha spending happens in the gate). */
  alpha?: number;
  /** PLAN-45 2.4: stop the capability loop early on a decisive SPRT (default true). */
  sequential?: boolean;
  /** PLAN-45 2.5: ceiling on candidate/incumbent token ratio minus one (default 0.5). */
  maxTokenDelta?: number;
}): Promise<TasksValidationVerdict> {
  const { runTask } = params;
  const trialsPerTask = Math.max(1, Math.floor(params.trialsPerTask ?? DEFAULT_TRIALS_PER_TASK));
  const deadlineAt = params.deadlineAt ?? Number.POSITIVE_INFINITY;
  const alpha = params.alpha ?? SIGN_TEST_ALPHA;
  const sequential = params.sequential !== false;
  const maxTokenDelta = params.maxTokenDelta ?? DEFAULT_MAX_TOKEN_DELTA;
  const calibrated = applyGateCalibration(params.corpus.tasks, params.calibration);
  const corpus: TaskCorpus = { tasks: calibrated.tasks, version: params.corpus.version };
  if (calibrated.dropped.length > 0) {
    log.info(
      `gate calibration dropped ${calibrated.dropped.length} uninformative canonical task(s): ${calibrated.dropped.map((d) => `${d.id}@${d.rate.toFixed(2)}`).join(", ")}`,
    );
  }
  const base0 = { corpusVersion: corpus.version, trialsPerTask, alpha };
  if (corpus.tasks.length < MIN_PAIRED_TRIALS) {
    return { accepted: false, reason: "insufficient-tasks", trials: corpus.tasks.length, ...base0 };
  }
  const regressionTasks = corpus.tasks.filter((t) => t.suite === "regression");
  const capabilityTasks = corpus.tasks.filter((t) => t.suite !== "regression");
  if (capabilityTasks.length === 0) {
    // The corpus cannot detect improvement (regression suite only) — a
    // guaranteed HOLD. Decide it BEFORE spending rollouts: a fresh node
    // would otherwise burn every proposal's full budget daily for nothing.
    return {
      accepted: false,
      reason: "no-capability-tasks",
      trials: corpus.tasks.length,
      ...base0,
    };
  }
  const relevantIds = new Set(relevantCapabilityTasks(corpus.tasks).map((t) => t.id));

  const perTask: PerTaskResult[] = [];
  let incumbentErrors = 0;
  let candidateErrors = 0;
  const totalTrials = corpus.tasks.length * trialsPerTask;
  const reads = { capability: [] as boolean[], regression: [] as boolean[] };
  const tokens = { incumbent: 0, candidate: 0 };
  const wall = { incumbent: 0, candidate: 0 };
  let budgetExhausted = false;

  const runArm = async (
    task: CorpusTask,
    variant: TaskVariant,
    ctx: TrialContext,
  ): Promise<TrialResult | null> => {
    const started = Date.now();
    try {
      const r = normalizeResult(await runTask(task, variant, ctx));
      const usage = (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
      const ms = r.wallMs ?? Date.now() - started;
      tokens[variant] += usage;
      wall[variant] += ms;
      return {
        ...r,
        usage: { input: r.usage?.input ?? 0, output: r.usage?.output ?? 0 },
        wallMs: ms,
      };
    } catch (err) {
      if (variant === "incumbent") {
        incumbentErrors += 1;
      } else {
        candidateErrors += 1;
      }
      log.debug(`${variant} arm failed on ${task.id} trial ${ctx.trialIndex}: ${String(err)}`);
      return null;
    }
  };

  interface TrialBatch {
    incumbent: number;
    candidate: number;
    credited: number;
    ran: number;
    tokens: { incumbent: number; candidate: number };
    wallMs: { incumbent: number; candidate: number };
  }

  const runTrials = async (
    task: CorpusTask,
    count: number,
    startIndex: number,
  ): Promise<TrialBatch> => {
    const out: TrialBatch = {
      incumbent: 0,
      candidate: 0,
      credited: 0,
      ran: 0,
      tokens: { incumbent: 0, candidate: 0 },
      wallMs: { incumbent: 0, candidate: 0 },
    };
    const isRelevant = task.suite !== "regression" && relevantIds.has(task.id);
    for (let trial = 0; trial < count; trial++) {
      if (Date.now() > deadlineAt) {
        budgetExhausted = true;
        break;
      }
      const ctx = { trialIndex: startIndex + trial };
      const inc = await runArm(task, "incumbent", ctx);
      if (inc) {
        out.incumbent += scoreTaskAnswer(task, inc.answer);
        out.tokens.incumbent += (inc.usage?.input ?? 0) + (inc.usage?.output ?? 0);
        out.wallMs.incumbent += inc.wallMs ?? 0;
      }
      await yieldToEventLoop();
      const cand = await runArm(task, "candidate", ctx);
      if (cand) {
        const score = scoreTaskAnswer(task, cand.answer);
        out.candidate += score;
        out.tokens.candidate += (cand.usage?.input ?? 0) + (cand.usage?.output ?? 0);
        out.wallMs.candidate += cand.wallMs ?? 0;
        // 2.7: a win counts for the skill only when the skill was read in
        // that trial; an unobservable read (string runner) stays neutral.
        if (score === 1 && cand.skillRead !== false) {
          out.credited += 1;
        }
        if (typeof cand.skillRead === "boolean") {
          if (task.suite === "regression") {
            reads.regression.push(cand.skillRead);
          } else if (isRelevant) {
            reads.capability.push(cand.skillRead);
          }
        }
      }
      await yieldToEventLoop();
      out.ran += 1;
    }
    return out;
  };

  const record = (task: CorpusTask, r: TrialBatch): PerTaskResult => {
    const entry: PerTaskResult = {
      id: task.id,
      suite: task.suite === "regression" ? "regression" : "capability",
      incumbent: r.incumbent / r.ran,
      candidate: r.candidate / r.ran,
      credited: r.credited / r.ran,
      trials: r.ran,
      tokens: r.tokens,
      wallMs: r.wallMs,
    };
    perTask.push(entry);
    return entry;
  };

  const partial = (reason: "budget-exhausted" | "runner-failed"): TasksValidationVerdict => ({
    accepted: false,
    reason,
    trials: perTask.length,
    perTask,
    ...(tokens.incumbent + tokens.candidate > 0 ? { tokens } : {}),
    ...(calibrated.dropped.length > 0 ? { calibrationDropped: calibrated.dropped } : {}),
    ...base0,
  });

  // "New failure" = a large pass-rate drop on a regression task, OR a
  // collapse on a capability task the incumbent had fully mastered (a sign
  // test discards magnitude; without this a candidate could trade three
  // total collapses for ten +1/3 wins and still promote). Uses the RAW
  // candidate rate: an unread-but-harmful skill still regresses.
  const isNewFailure = (t: PerTaskResult) =>
    t.suite === "regression"
      ? t.incumbent - t.candidate >= REGRESSION_DELTA_THRESHOLD
      : t.incumbent === 1 && t.incumbent - t.candidate >= REGRESSION_DELTA_THRESHOLD;
  const isSafety = (id: string) =>
    corpus.tasks.find((c) => c.id === id)?.tags?.includes(SAFETY_TAG) === true;

  /** A lone flaky trial must not kill a good candidate forever: confirm with a second round (not on safety tasks). */
  const confirm = async (t: PerTaskResult): Promise<"confirmed" | "cleared" | "unconfirmed"> => {
    if (isSafety(t.id)) {
      return "confirmed";
    }
    if (Date.now() > deadlineAt) {
      return "unconfirmed"; // adversarial H3: never let a flaky trial become a permanent REJECT
    }
    const task = corpus.tasks.find((c) => c.id === t.id)!;
    const more = await runTrials(task, trialsPerTask, t.trials);
    if (more.ran === 0) {
      return "unconfirmed";
    }
    const total = t.trials + more.ran;
    t.incumbent = (t.incumbent * t.trials + more.incumbent) / total;
    t.candidate = (t.candidate * t.trials + more.candidate) / total;
    t.credited = (t.credited * t.trials + more.credited) / total;
    t.trials = total;
    return isNewFailure(t) ? "confirmed" : "cleared";
  };

  // ---- Phase 1: regression suite, in full, confirmed, before any capability rollout.
  for (const task of regressionTasks) {
    if (budgetExhausted) {
      break;
    }
    const r = await runTrials(task, trialsPerTask, 0);
    if (r.ran === 0) {
      break;
    }
    const entry = record(task, r);
    if (isNewFailure(entry)) {
      const c = await confirm(entry);
      if (c === "unconfirmed") {
        log.info(
          `tasks validation: apparent regression on ${task.id} left unconfirmed at the budget -> HOLD`,
        );
        return partial("budget-exhausted");
      }
    }
  }
  if (budgetExhausted || perTask.length < regressionTasks.length) {
    log.info(
      `tasks validation stopped at the budget: ${perTask.length}/${regressionTasks.length} regression tasks run`,
    );
    return partial("budget-exhausted");
  }
  const regressionEntries = perTask.filter((t) => t.suite === "regression");
  const regressions = regressionEntries.filter(isNewFailure).map((t) => t.id);
  // Systematic slight degradation across the regression suite (e.g. every
  // task 3/3 -> 2/3) never trips the per-task rule; a sign test catches it.
  const regressionDrift = exactSignTest(regressionEntries.map((t) => t.incumbent - t.candidate));
  if (regressions.length === 0 && regressionEntries.length > 0 && regressionDrift.pValue < alpha) {
    regressions.push("suite-wide-drift");
  }

  // ---- Phase 2: capability suite. The RELEVANT tasks (the node's own grown
  // tasks, the ones the skill was written for) run first and in full; the
  // sequential test may only stop the remainder (adversarial C1/M3).
  const relevantFirst = [
    ...capabilityTasks.filter((t) => relevantIds.has(t.id)),
    ...capabilityTasks.filter((t) => !relevantIds.has(t.id)),
  ];
  let sprt = sprtDecision(0, 0, { alpha });
  let stoppedEarly = false;
  let capabilityRun = 0;
  for (const task of relevantFirst) {
    if (budgetExhausted || regressions.length > 0) {
      // A confirmed regression is the verdict; capability rollouts would be
      // spent for nothing.
      break;
    }
    const mayStop =
      sequential &&
      !relevantIds.has(task.id) &&
      (sprt.decision === "accept" ||
        // Early REJECT only once enough discordant pairs exist (adversarial
        // M4: fractional deltas make ~70% of null tasks discordant).
        (sprt.decision === "reject" && sprt.wins + sprt.losses >= MIN_PAIRED_TRIALS));
    if (mayStop) {
      stoppedEarly = true;
      break;
    }
    const r = await runTrials(task, trialsPerTask, 0);
    if (r.ran === 0) {
      break;
    }
    const entry = record(task, r);
    capabilityRun += 1;
    if (isNewFailure(entry)) {
      const c = await confirm(entry);
      if (c === "unconfirmed") {
        return partial("budget-exhausted");
      }
      if (c === "confirmed") {
        regressions.push(entry.id);
      }
    }
    const delta = pairedDelta(entry);
    if (delta > 0) {
      sprt = sprtDecision(sprt.wins + 1, sprt.losses, { alpha });
    } else if (delta < 0) {
      sprt = sprtDecision(sprt.wins, sprt.losses + 1, { alpha });
    }
  }
  if (budgetExhausted) {
    return partial("budget-exhausted");
  }
  if (incumbentErrors >= totalTrials || candidateErrors >= totalTrials) {
    return partial("runner-failed");
  }

  const capability = perTask.filter((t) => t.suite === "capability");
  const incumbentPassRate = perTask.reduce((a, t) => a + t.incumbent, 0) / perTask.length;
  const candidatePassRate = perTask.reduce((a, t) => a + t.candidate, 0) / perTask.length;
  const deltas = capability.map(pairedDelta);
  const sign = exactSignTest(deltas);
  const ci = bootstrapMeanCi(deltas);
  const meanDelta =
    capability.length > 0 ? deltas.reduce((a, b) => a + b, 0) / capability.length : undefined;
  const rate = (xs: boolean[]) => (xs.length === 0 ? null : xs.filter(Boolean).length / xs.length);
  const candidateReadRate = {
    capability: rate(reads.capability),
    regression: rate(reads.regression),
  };
  // 2.5: cost over capability tasks measured in both arms.
  const costTasks = capability.filter(
    (t) => (t.tokens?.incumbent ?? 0) > 0 && (t.tokens?.candidate ?? 0) > 0,
  );
  const incTok = costTasks.reduce((a, t) => a + (t.tokens?.incumbent ?? 0), 0);
  const candTok = costTasks.reduce((a, t) => a + (t.tokens?.candidate ?? 0), 0);
  const tokenDelta = incTok > 0 ? candTok / incTok - 1 : undefined;

  const base = {
    ...base0,
    incumbentPassRate,
    candidatePassRate,
    ...(meanDelta !== undefined ? { meanDelta } : {}),
    ci95Low: ci.ci95Low,
    ci95High: ci.ci95High,
    pValue: sign.pValue,
    wins: sign.wins,
    losses: sign.losses,
    ties: sign.ties,
    sequential: {
      ...sprt,
      stoppedEarly,
      tasksRun: capabilityRun,
      tasksPlanned: capabilityTasks.length,
    },
    regressions,
    trials: perTask.length,
    candidateReadRate,
    ...(tokens.incumbent + tokens.candidate > 0 ? { tokens } : {}),
    ...(tokenDelta !== undefined ? { tokenDelta } : {}),
    maxTokenDelta,
    wallMs: wall,
    ...(calibrated.dropped.length > 0 ? { calibrationDropped: calibrated.dropped } : {}),
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
  } else if (capabilityTasks.length < MIN_PAIRED_TRIALS) {
    // p < alpha is unreachable below 5 capability tasks (min p = 0.5^n):
    // a REJECT here would be permanent (content-hash dedup), so HOLD.
    reason = "insufficient-capability-tasks";
  } else if (
    candidateReadRate.capability !== null &&
    candidateReadRate.capability < NEVER_TRIGGERED_MAX_RATE
  ) {
    // Whatever the deltas say, a skill the agent did not open on the tasks
    // it was written for cannot have caused them. HOLD: the description may
    // just need rewording.
    reason = "never-triggered";
  } else if (
    sign.pValue < alpha ||
    (sequential && sprt.decision === "accept" && sign.wins > sign.losses)
  ) {
    reason = tokenDelta !== undefined && tokenDelta > maxTokenDelta ? "cost-exceeded" : "accepted";
  } else if (
    sign.discordant === 0 ||
    (sign.wins > sign.losses && 0.5 ** sign.discordant >= alpha)
  ) {
    // No discordant outcome at all (the skill was neither help nor harm on
    // this suite), or positive but underpowered (even a perfect record over
    // this many discordant pairs could not reach the spent alpha):
    // evidence-insufficient, not measured non-improvement.
    reason = "insufficient-evidence";
  } else {
    reason = "no-improvement";
  }
  const accepted = reason === "accepted";
  log.info(
    `tasks validation (corpus ${corpus.version}, K=${trialsPerTask}, alpha=${alpha}): ` +
      `incumbent ${(incumbentPassRate * 100).toFixed(0)}% vs candidate ${(candidatePassRate * 100).toFixed(0)}%; ` +
      `capability n=${capability.length}/${capabilityTasks.length} wins=${sign.wins} losses=${sign.losses} p=${sign.pValue.toFixed(4)} sprt=${sprt.decision}${stoppedEarly ? "(early)" : ""}; ` +
      `reads cap=${candidateReadRate.capability ?? "n/a"} reg=${candidateReadRate.regression ?? "n/a"}; ` +
      `tokenDelta=${tokenDelta === undefined ? "n/a" : tokenDelta.toFixed(2)}; regressions=[${regressions.join(",")}] -> ${reason.toUpperCase()}`,
  );
  return { accepted, reason, ...base };
}
