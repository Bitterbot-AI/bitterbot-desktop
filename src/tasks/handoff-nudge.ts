/**
 * Multi-signal handoff nudge (PLAN-17 Phase 3).
 *
 * Fires a system-event hint into a task-correlated agent's session when
 * resource pressure suggests the model should suspend cleanly via
 * `task_write_handoff` + `task_schedule_wakeup`. This is **additive**
 * to the existing overflow-compaction loop (`pi-embedded-runner/run.ts`)
 * and the mid-turn-budget guard (`mid-turn-budget.ts`); it does not
 * replace them. The runner's 80% compaction stays as the safety net.
 *
 * SOTA-aligned multi-signal trigger (per Augment Code's handoff-pattern
 * guide and Claude Code's token-budget design): the nudge fires when
 * ANY of:
 *   - token usage exceeds {tokenPctThreshold}  (default 65%)
 *   - tool calls since last handoff exceed {toolCallThreshold}  (default 30)
 *   - ms since last progress event exceed {msSinceProgressThreshold}  (default 25 min)
 *
 * Throttled to one nudge per {nudgeThrottleMs} per run (default 5 min)
 * so the agent isn't pestered. Only fires for runs where the
 * AgentRunContext has a `taskId` set.
 *
 * Disable globally with `BITTERBOT_TASKS_NUDGE=0`.
 */

import type { TaskHandoff } from "./types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveTaskStore } from "./store.js";

const log = createSubsystemLogger("tasks/handoff-nudge");

export type NudgeThresholds = {
  tokenPctThreshold: number;
  toolCallThreshold: number;
  msSinceProgressThreshold: number;
  nudgeThrottleMs: number;
  /**
   * PLAN-17 follow-up: when token usage exceeds this AND the run has
   * already received {@link escalationNudgeCount} nudges without a
   * handoff being written, the nudge module auto-writes a fallback
   * handoff so the task state isn't lost. Default 0.78 — sits 2 points
   * below the runner's 80% compaction safety net so we land before
   * compaction obliterates the working messages.
   */
  escalationTokenThreshold: number;
  /** Number of nudges before escalation fires. Default 3. */
  escalationNudgeCount: number;
};

export const DEFAULT_THRESHOLDS: NudgeThresholds = {
  tokenPctThreshold: 0.65,
  toolCallThreshold: 30,
  msSinceProgressThreshold: 25 * 60_000,
  nudgeThrottleMs: 5 * 60_000,
  escalationTokenThreshold: 0.78,
  escalationNudgeCount: 3,
};

type RunState = {
  toolCallsSinceHandoff: number;
  lastProgressMs: number;
  lastNudgeMs: number;
  /** Total nudges fired this run. Reset by resetNudgeStateAfterHandoff. */
  nudgeCount: number;
  /** True once escalation has auto-written a fallback handoff. Single-shot per run. */
  escalated: boolean;
};

const stateByRun = new Map<string, RunState>();

export type NudgeArgs = {
  runId: string;
  /** Estimated current token usage of session messages. Optional. */
  estimatedTokens?: number;
  /** Total context window in tokens, for the percentage trigger. */
  contextWindowTokens?: number;
  /** Override thresholds for tests. */
  thresholds?: Partial<NudgeThresholds>;
  /** Test seam: clock. */
  now?: () => number;
  /** Test seam: bypass the in-context AgentRunContext lookup. */
  taskIdOverride?: string;
  /** Test seam: bypass the session-key lookup. */
  sessionKeyOverride?: string;
  /** Test seam: enqueue function. */
  enqueue?: (text: string, opts: { sessionKey: string; contextKey?: string }) => void;
  /** Test seam: writer for the escalation salvage handoff. */
  writeHandoff?: (args: EscalationHandoffArgs) => TaskHandoff | null;
};

export type NudgeResult = {
  fired: boolean;
  reason?: "throttled" | "not_task" | "no_session_key" | "disabled" | "below_thresholds";
  triggers?: string[];
  /** True when escalation fired (fallback handoff was auto-written). */
  escalated?: boolean;
  /** Handoff id that escalation wrote, when escalated=true. */
  escalationHandoffId?: number;
};

export function maybeNudgeTaskHandoff(args: NudgeArgs): NudgeResult {
  if (process.env.BITTERBOT_TASKS_NUDGE === "0") {
    return { fired: false, reason: "disabled" };
  }
  const thresholds: NudgeThresholds = { ...DEFAULT_THRESHOLDS, ...args.thresholds };
  const now = (args.now ?? Date.now)();
  const ctx = getAgentRunContext(args.runId);
  const taskId = args.taskIdOverride ?? ctx?.taskId;
  if (!taskId) {
    return { fired: false, reason: "not_task" };
  }

  const state =
    stateByRun.get(args.runId) ??
    ({
      toolCallsSinceHandoff: 0,
      lastProgressMs: now,
      lastNudgeMs: 0,
      nudgeCount: 0,
      escalated: false,
    } satisfies RunState);
  state.toolCallsSinceHandoff += 1;
  stateByRun.set(args.runId, state);

  if (now - state.lastNudgeMs < thresholds.nudgeThrottleMs) {
    return { fired: false, reason: "throttled" };
  }

  const triggers: string[] = [];
  const tokenPct =
    args.estimatedTokens && args.contextWindowTokens && args.contextWindowTokens > 0
      ? args.estimatedTokens / args.contextWindowTokens
      : 0;
  if (tokenPct >= thresholds.tokenPctThreshold) {
    triggers.push(`tokens=${(tokenPct * 100).toFixed(0)}%`);
  }
  if (state.toolCallsSinceHandoff >= thresholds.toolCallThreshold) {
    triggers.push(`toolCalls=${state.toolCallsSinceHandoff}`);
  }
  const msSinceProgress = now - state.lastProgressMs;
  if (msSinceProgress >= thresholds.msSinceProgressThreshold) {
    triggers.push(`msSinceProgress=${(msSinceProgress / 60_000).toFixed(0)}min`);
  }
  if (triggers.length === 0) {
    return { fired: false, reason: "below_thresholds" };
  }

  const sessionKey = args.sessionKeyOverride ?? ctx?.sessionKey;
  if (!sessionKey) {
    return { fired: false, reason: "no_session_key" };
  }

  const text =
    `[long-horizon nudge] Task ${taskId} is approaching a suspend boundary ` +
    `(${triggers.join(", ")}). Consider: (1) call task_write_handoff to capture ` +
    `intent / decisions / pending; (2) call task_schedule_wakeup to schedule a ` +
    `resume. The runner's overflow-compaction at 80% remains as a safety net.`;

  const enqueue = args.enqueue ?? enqueueSystemEvent;
  enqueue(text, { sessionKey, contextKey: `task-handoff-nudge:${taskId}` });
  state.lastNudgeMs = now;
  state.nudgeCount += 1;
  log.debug(
    `task handoff nudge fired runId=${args.runId} taskId=${taskId} triggers=${triggers.join(",")}`,
  );

  // Escalation: when the model has ignored enough nudges AND we're near the
  // 80% compaction safety net, auto-write a fallback handoff so the task
  // state survives even if the agent never calls task_write_handoff.
  // Single-shot per run — once we've written a salvage handoff we trust
  // the next normal nudge (post-reset) to do the rest.
  let escalated = false;
  let escalationHandoffId: number | undefined;
  if (
    !state.escalated &&
    state.nudgeCount >= thresholds.escalationNudgeCount &&
    tokenPct >= thresholds.escalationTokenThreshold
  ) {
    const writer = args.writeHandoff ?? defaultEscalationHandoffWriter;
    try {
      const handoff = writer({
        taskId,
        runId: args.runId,
        tokenPct,
        nudgeCount: state.nudgeCount,
        toolCallsSinceHandoff: state.toolCallsSinceHandoff,
        msSinceProgress,
      });
      if (handoff) {
        escalated = true;
        escalationHandoffId = handoff.id;
        state.escalated = true;
        enqueue(
          `[long-horizon ESCALATION] Task ${taskId}: auto-wrote a salvage handoff (id ${handoff.id}) ` +
            `because ${state.nudgeCount} prior nudges produced no task_write_handoff and tokens are at ` +
            `${(tokenPct * 100).toFixed(0)}%. Read it with task_read_handoff and continue, or write your ` +
            `own handoff to override.`,
          { sessionKey, contextKey: `task-handoff-escalation:${taskId}` },
        );
        log.warn(
          `escalation fired runId=${args.runId} taskId=${taskId} handoffId=${handoff.id} nudges=${state.nudgeCount}`,
        );
      }
    } catch (err) {
      log.warn(`escalation writer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    fired: true,
    triggers,
    ...(escalated ? { escalated: true } : {}),
    ...(typeof escalationHandoffId === "number" ? { escalationHandoffId } : {}),
  };
}

export type EscalationHandoffArgs = {
  taskId: string;
  runId: string;
  tokenPct: number;
  nudgeCount: number;
  toolCallsSinceHandoff: number;
  msSinceProgress: number;
};

function defaultEscalationHandoffWriter(args: EscalationHandoffArgs): TaskHandoff | null {
  const store = getActiveTaskStore();
  if (!store) return null;
  try {
    return store.writeHandoff({
      taskId: args.taskId,
      runId: args.runId,
      intent:
        `[auto-escalation] agent ignored ${args.nudgeCount} prior nudges; tokens at ` +
        `${(args.tokenPct * 100).toFixed(0)}%. Salvage handoff so task state survives ` +
        `the impending compaction or context overflow.`,
      decisions: [
        `auto-written by handoff-nudge escalation`,
        `tool-calls-since-last-handoff: ${args.toolCallsSinceHandoff}`,
        `ms-since-last-progress: ${args.msSinceProgress}`,
      ],
      pending: [
        "AGENT: review the worker's recent tool calls and write a richer handoff",
        "AGENT: call task_schedule_wakeup or task_resume_inline to actually continue",
      ],
      context:
        "This handoff was auto-written because the long-horizon nudge fired " +
        `${args.nudgeCount} times without the agent calling task_write_handoff. ` +
        "Treat it as a placeholder — the real intent/decisions/pending are lost " +
        "unless the agent fills them in by writing a follow-up handoff.",
      contextTokens: undefined,
    });
  } catch (err) {
    log.warn(
      `defaultEscalationHandoffWriter failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Reset a run's nudge-state counters after the agent successfully
 * writes a handoff. Call this from `task_write_handoff`'s execute path
 * so the multi-signal triggers re-arm cleanly.
 */
export function resetNudgeStateAfterHandoff(runId: string): void {
  const state = stateByRun.get(runId);
  if (!state) return;
  state.toolCallsSinceHandoff = 0;
  state.lastProgressMs = Date.now();
  state.nudgeCount = 0;
  state.escalated = false;
}

/**
 * Mark progress (e.g., on task_update / step_update) so the
 * time-since-progress trigger resets.
 */
export function recordTaskProgress(runId: string): void {
  const state = stateByRun.get(runId);
  if (state) {
    state.lastProgressMs = Date.now();
  }
}

/** Clean up state for a finished run so the map doesn't leak memory. */
export function clearNudgeState(runId: string): void {
  stateByRun.delete(runId);
}

/** Test helper. */
export function resetNudgeStateForTests(): void {
  stateByRun.clear();
}

/** Test helper: inspect current state for a run. */
export function inspectNudgeState(runId: string): RunState | undefined {
  return stateByRun.get(runId);
}
