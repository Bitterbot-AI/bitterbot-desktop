/**
 * Auto-initiation of goal-oriented workflows (PLAN-22 Phase 2).
 *
 * `maybeInitiateGoal` is the single mutating caller of the complexity gate.
 * It runs the pure Stage-1 appraisal (Phase 1), resolves the gray band via
 * the temp=0 Judge LLM only when the heuristic is ambiguous, applies the
 * hormonal concurrency backstop, derives a done-criteria oracle, and (when
 * warranted) creates the durable Task. It returns a discriminated decision
 * the gateway hook (Phase 3) consumes: either stay inline, or escalate and
 * thread an ack + first slice into the run.
 *
 * Everything external is injectable so this stays unit-testable without a
 * live gateway: the task store, the Judge call, the concurrency evaluator,
 * the affective modulators, and the clock are all seams that default to the
 * real singletons.
 *
 * Failure policy: any error degrades to inline. Auto-initiation must never
 * block or break a turn (PLAN-22 Addendum item 1).
 */

import type { TaskSource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { acquireTaskSlot, releaseTaskSlot } from "./active-task-tracker.js";
import {
  appraiseComplexity,
  type ComplexityModulators,
  type ComplexityVerdict,
} from "./complexity.js";
import { getJudgeLlmCall, type LlmCall } from "./judge.js";
import { getActiveTaskStore, type TaskStore } from "./store.js";

const log = createSubsystemLogger("tasks/auto-initiate");

export interface GoalInitiationContext {
  /** The inbound user prompt (post attachment normalization). */
  prompt: string;
  /** Owning agent session key, pinned onto the created task. */
  agentSessionKey?: string | null;
  /** Defaults to "user". */
  source?: TaskSource;
}

export interface GoalInitiationDeps {
  /** Affective modulators for threshold modulation. Defaults to neutral. */
  modulators?: ComplexityModulators;
  /** Task store seam. Defaults to the registered singleton. */
  store?: TaskStore | null;
  /** Judge LLM call for gray-band resolution. Defaults to the registered call. */
  judgeCall?: LlmCall | null;
  /** Capacity backstop. Defaults to the hormonal-gated task-slot probe. */
  capacity?: () => { ok: boolean; reason?: string };
}

export type OracleKind = "mechanical" | "judged";

export type GoalDecision =
  | { mode: "inline"; reason: string; verdict: ComplexityVerdict }
  | {
      mode: "task";
      taskId: string;
      ack: string;
      firstSlice: string;
      oracleKind: OracleKind;
      verdict: ComplexityVerdict;
    };

const JUDGE_SYSTEM =
  "You triage whether a user request warrants a structured, multi-step goal " +
  "workflow (a durable task with checkpoints) versus a single inline answer. " +
  'Answer with exactly one word: "GOAL" if it is a substantial multi-step ' +
  'piece of work, or "INLINE" if a single response suffices.';

/** Collapse a prompt into a short goal title (first sentence, bounded). */
export function summarizeGoal(prompt: string): string {
  const firstLine = prompt.trim().split(/\n+/)[0] ?? prompt.trim();
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const clean = sentence.trim();
  return clean.length > 200 ? `${clean.slice(0, 197).trimEnd()}...` : clean;
}

/**
 * Derive a done-criteria oracle, preferring a mechanical/observable check
 * over an LLM-judged one. Never returns a vacuous criterion.
 */
export function deriveOracle(
  prompt: string,
  goal: string,
): { doneCriteria: string; kind: OracleKind } {
  if (/\bopen(?:ing)? a (?:pr|pull request)\b/i.test(prompt)) {
    return {
      doneCriteria: "A pull request is opened containing the requested changes.",
      kind: "mechanical",
    };
  }
  if (
    /\b(?:add|write|with|run)\s+(?:the\s+)?tests?\b/i.test(prompt) ||
    /tests?\s+pass/i.test(prompt)
  ) {
    return { doneCriteria: "The new or updated tests pass.", kind: "mechanical" };
  }
  if (/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|sql|css|swift)\b/.test(prompt)) {
    return {
      doneCriteria:
        "The referenced files are updated and the project still builds (typecheck + lint clean).",
      kind: "mechanical",
    };
  }
  return { doneCriteria: `The stated goal is fully satisfied: ${goal}`, kind: "judged" };
}

function buildAck(taskId: string, goal: string): string {
  return (
    `I've started a goal-oriented task for this (id ${taskId}) because it looks multi-step: "${goal}". ` +
    `I'll work it in checkpoints and report progress. Reply "just answer" if you'd rather I skip the plan and respond inline.`
  );
}

function buildFirstSlice(taskId: string, goal: string, doneCriteria: string): string {
  return (
    `You are now working on long-horizon task ${taskId}.\n` +
    `Goal: ${goal}\n` +
    `Done criteria: ${doneCriteria}\n` +
    `Begin with the first concrete step. Use the task_* tools to record a handoff and schedule a wakeup ` +
    `before you run low on context, so the work survives across turns.`
  );
}

/**
 * Resolve a gray-band prompt via the Judge. Returns true to escalate.
 * Conservative on every failure path: no judge, malformed answer, or a
 * thrown error all degrade to "do not escalate".
 */
async function resolveGrayBand(prompt: string, judgeCall: LlmCall | null): Promise<boolean> {
  if (!judgeCall) {
    log.debug("gray band but no judge call registered -> inline");
    return false;
  }
  try {
    const answer = await judgeCall(
      `${JUDGE_SYSTEM}\n\nRequest:\n${prompt}\n\nAnswer with one word:`,
    );
    const escalate = /\bgoal\b/i.test(answer) && !/\binline\b/i.test(answer);
    log.debug(`gray band judged -> ${escalate ? "goal" : "inline"}`);
    return escalate;
  } catch (err) {
    log.debug(
      `gray-band judge failed (degrading to inline): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Default capacity backstop: probe the hormonal-gated task-slot tracker and
 * release immediately. Returns whether a new task wakeup could currently run.
 */
function defaultCapacity(): { ok: boolean; reason?: string } {
  const probeId = "auto-initiate:probe";
  const res = acquireTaskSlot({ jobId: probeId });
  if (res.ok) {
    releaseTaskSlot(probeId);
  }
  return { ok: res.ok, reason: res.reason };
}

/**
 * The single mutating entry point. Appraise the prompt and, when warranted,
 * create a Task and return the escalation payload; otherwise return inline.
 */
export async function maybeInitiateGoal(
  ctx: GoalInitiationContext,
  deps: GoalInitiationDeps = {},
): Promise<GoalDecision> {
  const verdict = appraiseComplexity(ctx.prompt, deps.modulators ?? {});

  if (verdict.tier === "inline") {
    return { mode: "inline", reason: "below complexity threshold", verdict };
  }

  if (verdict.tier === "gray") {
    const escalate = await resolveGrayBand(ctx.prompt, deps.judgeCall ?? getJudgeLlmCall());
    if (!escalate) {
      return { mode: "inline", reason: "gray band resolved to inline", verdict };
    }
  }

  // Escalating: apply the hormonal concurrency backstop.
  const capacity = (deps.capacity ?? defaultCapacity)();
  if (!capacity.ok) {
    log.info(`auto-initiation deferred at capacity: ${capacity.reason ?? "at_capacity"}`);
    return {
      mode: "inline",
      reason: `at task capacity (${capacity.reason ?? "at_capacity"})`,
      verdict,
    };
  }

  const store = deps.store ?? getActiveTaskStore();
  if (!store) {
    return { mode: "inline", reason: "no task store available", verdict };
  }

  const goal = summarizeGoal(ctx.prompt);
  const oracle = deriveOracle(ctx.prompt, goal);

  let taskId: string;
  try {
    const task = store.create({
      goal,
      doneCriteria: oracle.doneCriteria,
      source: ctx.source ?? "user",
      agentSessionKey: ctx.agentSessionKey ?? null,
      metadata: {
        autoInitiated: true,
        oracleKind: oracle.kind,
        complexity: {
          score: verdict.score,
          tier: verdict.tier,
          thresholds: verdict.thresholds,
          signals: verdict.signals,
          reasons: verdict.reasons,
        },
        modulators: deps.modulators ?? {},
      },
    });
    taskId = task.id;
  } catch (err) {
    log.debug(
      `task creation failed (degrading to inline): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { mode: "inline", reason: "task creation failed", verdict };
  }

  log.info(
    `auto-initiated task ${taskId} (score=${verdict.score.toFixed(3)} tier=${verdict.tier} oracle=${oracle.kind})`,
  );

  return {
    mode: "task",
    taskId,
    ack: buildAck(taskId, goal),
    firstSlice: buildFirstSlice(taskId, goal, oracle.doneCriteria),
    oracleKind: oracle.kind,
    verdict,
  };
}
