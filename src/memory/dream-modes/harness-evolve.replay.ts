// PLAN-64 Phase 6 (gap G5): judge a candidate harness policy by what it DOES.
//
// The predicted judge (ExperimentSandbox.scoreVersionPair) asks one model call
// to guess pass or fail for both policies. Nothing runs. This module is the
// replacement: an implementation of the same `ScorePairFn` contract that
// re-runs a verifiable task twice, once under each policy, in the skill task
// gate's scratch-workspace trial runner, and decides pass or fail with the
// task's deterministic checker (`scoreTaskAnswer`), the same verifier the skill
// task gate uses. No model's opinion of a transcript is consulted.
//
// What is replayed. A `skill_executions` row holds no prompt and no outcome
// check, so a past execution cannot be re-run from its row alone. It is
// replayable only when the node's reviewed task corpus carries a task that was
// drafted from that execution's run (`CorpusTask.sourceRunId`): a hermetic,
// self-contained restatement of what the run was doing, with a deterministic
// checker. The corpus task is what runs; the literal user message does not.
//
// Eligibility fails closed (see `selectReplayableExecutions`). Everything that
// cannot be run inside the scratch workspace with a verifier is excluded, not
// guessed. Trial turns run in a skill-evolution validation session: restricted
// tool allow-list, no messaging, wallet or browser tools, workspace-scoped
// files, undeclared network egress refused at the tool chokepoint.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearTrialHarnessPolicy,
  registerTrialHarnessPolicy,
} from "../../agents/embedded-runner/harness-policy-trial.js";
import type { HarnessPolicy } from "../../agents/embedded-runner/harness-policy.js";
import { SKILL_VALIDATION_TOOL_ALLOW } from "../../agents/skill-validation-policy.js";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import {
  collectTrialEgress,
  registerTrialDeclaredHosts,
} from "../../agents/skills/validation-egress.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ScorePairFn } from "../experiment-sandbox.js";
import { LearningDispatchStopped } from "../learning-dispatch-stopped.js";
import { NETWORK_VERB_RE } from "../skill-evolution/corpus-miner.js";
import { type CorpusTask, scoreTaskAnswer } from "../skill-evolution/task-corpus.js";
import {
  type AgentTurnFn,
  consumeTrialWorkspace,
  registerTrialWorkspace,
  trialsRoot,
  writeTaskFiles,
} from "../skill-evolution/task-runner.js";
import { type HeldOutExecution, MIN_PAIRED_FOR_BOOTSTRAP } from "../skill-execution-selection.js";
import type { HarnessReplayLedger, ReplayArm } from "./harness-evolve.replay-ledger.js";

const log = createSubsystemLogger("memory/dream/harness-evolve-replay");

export type HarnessEvaluationKind = "replay" | "predicted";

/** Default ceiling on trial agent turns per harness-evolve cycle. */
export const DEFAULT_MAX_TRIAL_TURNS_PER_CYCLE = 40;
/** Pairs one comparison may run, so one candidate cannot spend the whole cycle. */
export const DEFAULT_MAX_PAIRS_PER_COMPARISON = 10;
/** Wall-clock ceiling for one cycle's trials, checked between dispatches. */
export const DEFAULT_MAX_REPLAY_WALL_MS = 30 * 60_000;
/** Consecutive errored pairs after which the executor is treated as down. */
export const MAX_CONSECUTIVE_TRIAL_ERRORS = 3;

// ── Eligibility ─────────────────────────────────────────────────────────────

export type ReplayExclusionReason =
  /** The row has no journal run id, so no recorded task can be linked to it. */
  | "no-run-id"
  /** The tool the execution was recorded from is unknown. */
  | "unknown-tool"
  /** The recorded tool is not one the scratch runner offers (messaging, wallet, browser, ...). */
  | "tool-outside-scratch-runner"
  /** No reviewed corpus task with a deterministic checker was drafted from the run. */
  | "no-verifier"
  /** The linked task reaches for the network or a path outside the workspace. */
  | "not-hermetic"
  /** Another, newer execution already covers the same task. */
  | "duplicate-task";

export interface ReplayableExecution {
  execution: HeldOutExecution;
  task: CorpusTask;
}

export interface ReplayEligibility {
  replayable: ReplayableExecution[];
  excluded: Array<{ id: string; reason: ReplayExclusionReason }>;
}

/** Absolute or home-relative paths: a task that names one is not confined to the scratch dir. */
const OUTSIDE_PATH_RE = /(^|[\s"'`=(])(~\/|\/(?:home|tmp|etc|var|usr|root|mnt|Users)\/|\$HOME\b)/;

function isHermeticTask(task: CorpusTask): boolean {
  return !NETWORK_VERB_RE.test(task.prompt) && !OUTSIDE_PATH_RE.test(task.prompt);
}

/**
 * Decide which held-out executions can be replayed. Fail closed: an execution
 * is in only when every check passes, and each exclusion carries its reason.
 * `allowedTools` is the scratch runner's tool allow-list (the validation
 * session policy); the default is the always-allowed file tools.
 */
export function selectReplayableExecutions(params: {
  executions: ReadonlyArray<HeldOutExecution>;
  tasks: ReadonlyArray<CorpusTask>;
  allowedTools?: ReadonlyArray<string>;
}): ReplayEligibility {
  const allowed = new Set(
    (params.allowedTools ?? SKILL_VALIDATION_TOOL_ALLOW).map((t) => t.toLowerCase()),
  );
  const taskByRun = new Map<string, CorpusTask>();
  for (const task of params.tasks) {
    if (task.sourceRunId && !taskByRun.has(task.sourceRunId)) {
      taskByRun.set(task.sourceRunId, task);
    }
  }
  const replayable: ReplayableExecution[] = [];
  const excluded: ReplayEligibility["excluded"] = [];
  const usedTasks = new Set<string>();
  for (const execution of params.executions) {
    const exclude = (reason: ReplayExclusionReason) => excluded.push({ id: execution.id, reason });
    if (!execution.runId) {
      exclude("no-run-id");
      continue;
    }
    if (!execution.toolName) {
      exclude("unknown-tool");
      continue;
    }
    if (!allowed.has(execution.toolName.toLowerCase())) {
      exclude("tool-outside-scratch-runner");
      continue;
    }
    const task = taskByRun.get(execution.runId);
    if (!task) {
      exclude("no-verifier");
      continue;
    }
    if (!isHermeticTask(task)) {
      exclude("not-hermetic");
      continue;
    }
    if (usedTasks.has(task.id)) {
      exclude("duplicate-task");
      continue;
    }
    usedTasks.add(task.id);
    replayable.push({ execution, task });
  }
  return { replayable, excluded };
}

const EXCLUSION_LABELS: Record<ReplayExclusionReason, string> = {
  "no-run-id": "no recorded run",
  "unknown-tool": "recorded tool unknown",
  "tool-outside-scratch-runner": "tool not available in the scratch runner",
  "no-verifier": "no reviewed task with a checker",
  "not-hermetic": "task reaches outside the scratch workspace",
  "duplicate-task": "same task as a newer execution",
};

/** "12 no reviewed task with a checker, 3 no recorded run" (empty string when nothing was excluded). */
export function summarizeExclusions(excluded: ReplayEligibility["excluded"]): string {
  const counts = new Map<ReplayExclusionReason, number>();
  for (const e of excluded) {
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${EXCLUSION_LABELS[reason]}`)
    .join(", ");
}

// ── Evaluator ───────────────────────────────────────────────────────────────

/** What one `scorePair` call actually did. Feeds provenance and insights. */
export interface HarnessEvaluationReceipt {
  evaluation: HarnessEvaluationKind;
  /** Paired trials where BOTH arms were executed and verified. 0 for a prediction. */
  nExecuted: number;
  /** Ledger ids of every trial turn dispatched for this comparison. */
  trialIds: string[];
  /** Pairs dropped because an arm errored (never counted as a pass or a fail). */
  nErrored: number;
  /** Why the comparison ended early, when it did. */
  stopped?: string;
}

/** A judge plus an honest account of how it judged. */
export interface HarnessEvaluator {
  readonly evaluation: HarnessEvaluationKind;
  readonly scorePair: ScorePairFn;
  /** The receipt of the most recent `scorePair` call; cleared by reading it. */
  takeReceipt(): HarnessEvaluationReceipt | null;
}

/**
 * Wrap a judge that executes nothing (the ExperimentSandbox prediction, or a
 * scorer injected by a test). Its receipts always say `predicted` and report
 * zero executed trials.
 */
export function createPredictedEvaluator(scorePair: ScorePairFn): HarnessEvaluator {
  let receipt: HarnessEvaluationReceipt | null = null;
  return {
    evaluation: "predicted",
    scorePair: async (a, b, sel) => {
      const out = await scorePair(a, b, sel);
      receipt = { evaluation: "predicted", nExecuted: 0, trialIds: [], nErrored: 0 };
      return out;
    },
    takeReceipt: () => {
      const r = receipt;
      receipt = null;
      return r;
    },
  };
}

export interface ReplayEvaluatorDeps {
  cycleId: string;
  ledger: HarnessReplayLedger;
  /** Ceiling on trial agent turns for this cycle (`maxTrialTurnsPerCycle`). */
  maxTrialTurns: number;
  /** The eligible set. Executions not in it are never run, whatever the caller passes. */
  replayable: ReadonlyArray<ReplayableExecution>;
  /** Map a serialized policy text (the `ScorePairFn` argument) back to the policy. */
  resolvePolicy: (text: string) => HarnessPolicy | undefined;
  /** One real agent turn in a validation session. Both arms use this same executor. */
  agentTurn: AgentTurnFn;
  /** False pauses dispatch (usage budget in enforce mode, shutdown, index sync). */
  canDispatch?: () => boolean;
  random?: () => number;
  maxPairsPerComparison?: number;
  /** Wall-clock ceiling from evaluator creation. Default 30 minutes. */
  maxWallMs?: number;
  now?: () => number;
  storeOpts?: ImpactTrailOptions;
  keepTrialDirs?: boolean;
}

function policyHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
}

function isOperationalStop(error: unknown): string | null {
  if (error instanceof LearningDispatchStopped) {
    return error.reason;
  }
  if (error instanceof Error && error.name === "UsageBudgetPausedError") {
    return "usage-budget";
  }
  return null;
}

/**
 * The real-execution judge. For each replayable execution in the selection it
 * runs the linked task under policy A and under policy B (order drawn per task
 * from `random`), each in a fresh scratch workspace with the policy bound to
 * that workspace, and scores the answers with the task's checker.
 *
 * A pair enters the result only when both arms ran and were verified. An arm
 * that errors drops its pair; an operational stop (trial budget, usage budget,
 * pause) ends the comparison. Neither is ever turned into a pass or a fail.
 */
export function createReplayEvaluator(deps: ReplayEvaluatorDeps): HarnessEvaluator {
  const random = deps.random ?? Math.random;
  const byExecution = new Map(deps.replayable.map((r) => [r.execution.id, r]));
  const maxPairs = Math.max(1, deps.maxPairsPerComparison ?? DEFAULT_MAX_PAIRS_PER_COMPARISON);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const maxWallMs = deps.maxWallMs ?? DEFAULT_MAX_REPLAY_WALL_MS;
  let receipt: HarnessEvaluationReceipt | null = null;
  let comparisons = 0;

  const runTrial = async (args: {
    comparison: string;
    item: ReplayableExecution;
    arm: ReplayArm;
    policy: HarnessPolicy;
    hash: string;
    trialIds: string[];
  }): Promise<boolean> => {
    // Durable reservation BEFORE dispatch. Throws when the ceiling is reached.
    const trialId = deps.ledger.reserve(deps.cycleId, deps.maxTrialTurns, {
      comparison: args.comparison,
      executionId: args.item.execution.id,
      taskId: args.item.task.id,
      arm: args.arm,
      policyHash: args.hash,
    });
    args.trialIds.push(trialId);
    const trialDir = path.join(
      trialsRoot(deps.storeOpts),
      safeSegment(`harness-${deps.cycleId}`),
      safeSegment(args.item.task.id),
      safeSegment(trialId),
    );
    const workspaceDir = path.join(trialDir, "workspace");
    try {
      await fs.rm(trialDir, { recursive: true, force: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeTaskFiles(workspaceDir, args.item.task);
      registerTrialWorkspace(workspaceDir);
      // Hermetic tasks declare no hosts: every egress attempt is refused.
      registerTrialDeclaredHosts(workspaceDir, []);
      registerTrialHarnessPolicy(workspaceDir, args.policy);
      const raw = await deps.agentTurn(args.item.task.prompt, {
        workspaceDir,
        ...(args.item.task.timeoutMs ? { timeoutMs: args.item.task.timeoutMs } : {}),
      });
      const outcome = typeof raw === "string" ? { text: raw } : raw;
      const passed = scoreTaskAnswer(args.item.task, outcome.text) === 1;
      deps.ledger.settle(trialId, passed ? "passed" : "failed", outcome.runId);
      return passed;
    } catch (error) {
      deps.ledger.settle(trialId, isOperationalStop(error) ? "held" : "error");
      throw error;
    } finally {
      consumeTrialWorkspace(workspaceDir); // in case the executor never consumed it
      clearTrialHarnessPolicy(workspaceDir);
      collectTrialEgress(workspaceDir);
      if (!deps.keepTrialDirs) {
        await fs.rm(trialDir, { recursive: true, force: true }).catch(() => undefined);
        for (const dir of [path.dirname(trialDir), path.dirname(path.dirname(trialDir))]) {
          await fs.rmdir(dir).catch(() => undefined);
        }
      }
    }
  };

  const scorePair: ScorePairFn = async (textA, textB, selectionSet) => {
    const current: HarnessEvaluationReceipt = {
      evaluation: "replay",
      nExecuted: 0,
      trialIds: [],
      nErrored: 0,
    };
    receipt = current;
    const policyA = deps.resolvePolicy(textA);
    const policyB = deps.resolvePolicy(textB);
    if (!policyA || !policyB) {
      // Never guess which policy a text stands for.
      current.stopped = "unknown-policy";
      return [];
    }
    // Only eligible executions run, whatever selection the caller hands over.
    const items = selectionSet
      .map((e) => byExecution.get(e.id))
      .filter((r): r is ReplayableExecution => r !== undefined);
    const affordable = Math.floor(deps.ledger.remaining(deps.cycleId, deps.maxTrialTurns) / 2);
    const pairs = Math.min(items.length, maxPairs, affordable);
    if (pairs < MIN_PAIRED_FOR_BOOTSTRAP) {
      // Spending turns on a sample that cannot reach a verdict would be waste.
      current.stopped =
        items.length < MIN_PAIRED_FOR_BOOTSTRAP ? "insufficient-replayable" : "agent_turns-budget";
      return [];
    }
    comparisons += 1;
    const comparison = `${comparisons}:${policyHash(textA)}>${policyHash(textB)}`;
    const arms: Record<ReplayArm, { policy: HarnessPolicy; hash: string }> = {
      baseline: { policy: policyA, hash: policyHash(textA) },
      candidate: { policy: policyB, hash: policyHash(textB) },
    };
    const out: Array<{ taskId: string; aPassed: boolean; bPassed: boolean }> = [];
    let consecutiveErrors = 0;
    for (const item of items.slice(0, pairs)) {
      if (deps.canDispatch && !deps.canDispatch()) {
        current.stopped = "paused";
        break;
      }
      if (now() - startedAt >= maxWallMs) {
        current.stopped = "wall-budget";
        break;
      }
      const order: ReplayArm[] =
        random() < 0.5 ? ["candidate", "baseline"] : ["baseline", "candidate"];
      const passed: Partial<Record<ReplayArm, boolean>> = {};
      try {
        for (const arm of order) {
          passed[arm] = await runTrial({
            comparison,
            item,
            arm,
            policy: arms[arm].policy,
            hash: arms[arm].hash,
            trialIds: current.trialIds,
          });
        }
      } catch (error) {
        const stop = isOperationalStop(error);
        if (stop) {
          current.stopped = stop;
          break;
        }
        current.nErrored += 1;
        consecutiveErrors += 1;
        log.debug(`replay trial errored for task ${item.task.id}: ${String(error)}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_TRIAL_ERRORS) {
          // The executor is down (for example no gateway to loop back to):
          // stop spending turns on trials that cannot produce evidence.
          current.stopped = "executor-failing";
          break;
        }
        continue;
      }
      if (passed.baseline === undefined || passed.candidate === undefined) {
        continue;
      }
      consecutiveErrors = 0;
      current.nExecuted += 1;
      out.push({
        taskId: item.execution.id,
        aPassed: passed.baseline,
        bPassed: passed.candidate,
      });
    }
    return out;
  };

  return {
    evaluation: "replay",
    scorePair,
    takeReceipt: () => {
      const r = receipt;
      receipt = null;
      return r;
    },
  };
}
