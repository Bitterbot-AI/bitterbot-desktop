/**
 * Agent tools for long-horizon Task management (PLAN-16).
 *
 * Phase A — `task_monitor` (event journal stream).
 * Phase B — `task_create`, `task_update`, `task_get`, `task_list`,
 *           `task_stop`, `task_output`.
 * Phase C — `task_schedule_wakeup` (self-resume via cron).
 * Phase D — `task_judge` (operator-initiated re-verification).
 *
 * Tools are exposed through `bitterbot-tools.ts`. They share a runtime
 * dependency on the singleton `TaskStore` (started in `server.impl.ts`)
 * and `EventJournal` (Phase A). When either is missing the tool returns
 * a structured error rather than throwing.
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { CronJob } from "../../cron/types.js";
import type {
  PlanStep,
  PlanStepStatus,
  Task,
  TaskPlan,
  TaskSource,
  TaskStatus,
} from "../../tasks/types.js";
import type { AnyAgentTool } from "./common.js";
import { getCronEngine } from "../../cron/active.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getActiveEventJournal } from "../../infra/event-journal.js";
import {
  DEFAULT_MAX_JUDGE_ROUNDS,
  getJudgeLlmCall,
  runTaskJudge,
  type TaskJudgeDecision,
} from "../../tasks/judge.js";
import { getActiveTaskStore, type TaskStore } from "../../tasks/store.js";
import { isTerminal } from "../../tasks/types.js";

/** Hard cap on per-task scheduled wakeups to prevent runaway loops. */
const DEFAULT_MAX_WAKEUPS = 50;
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<AgentToolResult<unknown>>;

/**
 * Wrap a tool's execute body in a uniform error catch. Converts
 * ToolInputError (thrown by readStringParam/readNumberParam when
 * required:true is missing) into a structured `{ok:false,error}`
 * response so callers see a consistent shape.
 */
function safeExecute(fn: ExecuteFn): ExecuteFn {
  return async (toolCallId, params) => {
    try {
      return await fn(toolCallId, params);
    } catch (err) {
      if (err instanceof ToolInputError) {
        return jsonResult({ ok: false, error: err.message });
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// task_monitor (Phase A).
// ---------------------------------------------------------------------------

const MonitorSchema = Type.Object({
  task_id: Type.String({
    description: "Task id to monitor. Required.",
    minLength: 1,
  }),
  since_seq: Type.Optional(
    Type.Integer({
      description:
        "Return only events with journal seq strictly greater than this cursor. Use the " +
        "seq of the last event you saw to poll incrementally. Omit on first call.",
      minimum: 0,
    }),
  ),
  streams: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter to specific event streams (e.g. ['tool', 'assistant', 'lifecycle', 'error']). " +
        "Omit to receive all streams.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Max events to return. Defaults to 200; capped at 2000.",
      minimum: 1,
      maximum: 2000,
    }),
  ),
});

export function createTaskMonitorTool(): AnyAgentTool {
  return {
    label: "Monitor Task",
    name: "task_monitor",
    description:
      "Stream events from a running or completed long-horizon task. Returns durable " +
      "events from the event journal (tool calls, lifecycle frames, assistant messages, " +
      "errors) so you can watch a background task's progress without blocking. Poll " +
      "incrementally using the `since_seq` cursor from the previous response. Use this " +
      "after starting a task via task_create or after spawning a background subagent.",
    parameters: MonitorSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const taskId = readStringParam(params, "task_id", { required: true });
      const sinceSeq = readNumberParam(params, "since_seq", { integer: true });
      const streams = readStringArrayParam(params, "streams");
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 200;

      const journal = getActiveEventJournal();
      if (!journal) {
        return jsonResult({
          ok: false,
          error:
            "event journal is not active. Set BITTERBOT_EVENT_JOURNAL=1 (default) and " +
            "ensure the gateway is up.",
        });
      }

      const events = journal.query({
        taskId,
        ...(typeof sinceSeq === "number" ? { sinceSeq } : {}),
        ...(streams && streams.length > 0 ? { streams } : {}),
        limit,
      });
      const last = events.length > 0 ? events[events.length - 1].seq : (sinceSeq ?? 0);
      return jsonResult({
        ok: true,
        taskId,
        count: events.length,
        nextSinceSeq: last,
        events,
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_create (Phase B).
// ---------------------------------------------------------------------------

const PlanStepSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("skipped"),
      Type.Literal("failed"),
    ]),
  ),
});

const CreateSchema = Type.Object({
  goal: Type.String({
    description:
      "What the task is trying to accomplish, in one or two sentences. This is the " +
      "high-level intent — the Judge uses it together with done_criteria to decide " +
      "whether the task is complete.",
    minLength: 1,
    maxLength: 2000,
  }),
  done_criteria: Type.String({
    description:
      "Falsifiable acceptance criteria. The Judge will pass/fail based on these — be " +
      "specific (e.g. 'docs/x.md updated AND pnpm test passes AND no new TODOs added').",
    minLength: 1,
    maxLength: 2000,
  }),
  plan: Type.Optional(
    Type.Array(PlanStepSchema, {
      description:
        "Optional initial plan as ordered steps. Each step has id, title, optional " +
        "description, and optional status (defaults to 'pending'). Use task_update with " +
        "step_update to advance step states as you work.",
    }),
  ),
  parent_task_id: Type.Optional(
    Type.String({
      description:
        "Parent task id when this task was spawned by another task. Used for hierarchy " +
        "tracking in task_list.",
    }),
  ),
  source: Type.Optional(
    Type.Union(
      [
        Type.Literal("user"),
        Type.Literal("curiosity"),
        Type.Literal("subagent"),
        Type.Literal("judge"),
        Type.Literal("operator"),
      ],
      {
        description:
          "Where the task originated. Defaults to 'user'. Use 'curiosity' for tasks " +
          "auto-generated from frontier gaps; 'subagent' when one task spawns another.",
      },
    ),
  ),
  bounty: Type.Optional(
    Type.Integer({
      description: "Optional bounty in cents. Tasks with bounty > 0 are eligible for P2P bidding.",
      minimum: 0,
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Free-form key/value metadata to attach to the task.",
    }),
  ),
});

export function createTaskCreateTool(options: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Create Task",
    name: "task_create",
    description:
      "Register a new long-horizon Task. Use this when the user gives you work that " +
      "will take more than a few minutes, requires multiple steps, or should survive " +
      "this conversation. The Task becomes a durable coordination object: it persists " +
      "across restarts, can be monitored via task_monitor, and is the substrate for " +
      "auto-handoff (Phase C) and Judge verification (Phase D). Write specific, " +
      "falsifiable done_criteria — the Judge will refuse to mark the task complete " +
      "without them.",
    parameters: CreateSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();

      const goal = readStringParam(params, "goal", { required: true });
      const doneCriteria = readStringParam(params, "done_criteria", { required: true });
      const source = (readStringParam(params, "source") as TaskSource | undefined) ?? "user";
      const parentTaskId = readStringParam(params, "parent_task_id");
      const bounty = readNumberParam(params, "bounty", { integer: true });
      const rawPlan = params.plan;
      const rawMeta = params.metadata;

      const plan = parsePlanArray(rawPlan);
      const metadata =
        rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
          ? (rawMeta as Record<string, unknown>)
          : null;

      let task: Task;
      try {
        task = store.create({
          goal,
          doneCriteria,
          source,
          parentTaskId: parentTaskId ?? null,
          bounty: typeof bounty === "number" ? bounty : null,
          plan,
          metadata,
          agentSessionKey: options.agentSessionKey ?? null,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Emit a `task` lifecycle event so task_monitor returns at least one
      // row even before any worker run starts.
      emitTaskEvent(task.id, "created", { task });
      return jsonResult({ ok: true, task });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_update (Phase B).
// ---------------------------------------------------------------------------

const StatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("planning"),
  Type.Literal("running"),
  Type.Literal("waiting_external"),
  Type.Literal("judging"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
]);

const UpdateSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  status: Type.Optional(StatusSchema),
  goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  done_criteria: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  plan: Type.Optional(
    Type.Array(PlanStepSchema, {
      description: "Replace the entire plan. Use step_update for single-step transitions.",
    }),
  ),
  step_update: Type.Optional(
    Type.Object(
      {
        step_id: Type.String({ minLength: 1 }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
          Type.Literal("skipped"),
          Type.Literal("failed"),
        ]),
        output: Type.Optional(Type.String()),
      },
      { description: "Mutate one step's status (and optional output)." },
    ),
  ),
  output: Type.Optional(Type.String()),
  current_run_id: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function createTaskUpdateTool(): AnyAgentTool {
  return {
    label: "Update Task",
    name: "task_update",
    description:
      "Mutate a Task's status, plan, current_run_id, or output reference. Use this " +
      "to advance through plan steps (`step_update`), to mark a task as running / " +
      "judging / completed, or to attach a final artifact reference. Status " +
      "transitions out of completed/failed/stopped are blocked — those are terminal.",
    parameters: UpdateSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });

      const rawStepUpdate = params.step_update;
      if (rawStepUpdate && typeof rawStepUpdate === "object") {
        const su = rawStepUpdate as Record<string, unknown>;
        const stepId = readStringParam(su, "step_id", { required: true });
        const status = readStringParam(su, "status", { required: true }) as PlanStepStatus;
        const output = readStringParam(su, "output");
        try {
          const task = store.setStepStatus(taskId, stepId, status, output);
          emitTaskEvent(taskId, "step_update", { stepId, status, output });
          return jsonResult({ ok: true, task });
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const status = readStringParam(params, "status") as TaskStatus | undefined;
      const goal = readStringParam(params, "goal");
      const doneCriteria = readStringParam(params, "done_criteria");
      const output = readStringParam(params, "output");
      const currentRunId = readStringParam(params, "current_run_id");
      const rawPlan = params.plan;
      const rawMeta = params.metadata;
      const plan = parsePlanArray(rawPlan);
      const metadata =
        rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
          ? (rawMeta as Record<string, unknown>)
          : undefined;

      try {
        const task = store.update(taskId, {
          ...(status !== undefined ? { status } : {}),
          ...(goal !== undefined ? { goal } : {}),
          ...(doneCriteria !== undefined ? { doneCriteria } : {}),
          ...(rawPlan !== undefined ? { plan } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(currentRunId !== undefined ? { currentRunId } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        emitTaskEvent(taskId, "updated", { status: task.status });
        return jsonResult({ ok: true, task });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// task_get (Phase B).
// ---------------------------------------------------------------------------

const GetSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  include_recent_events: Type.Optional(
    Type.Boolean({
      description:
        "When true (default), include the most recent N events from the journal in the response.",
    }),
  ),
  recent_events_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

export function createTaskGetTool(): AnyAgentTool {
  return {
    label: "Get Task",
    name: "task_get",
    description:
      "Fetch a single Task by id with its status, plan, checkpoint pointer, and (by " +
      "default) its most recent event-journal entries. Use this to inspect a task " +
      "without subscribing to the live stream.",
    parameters: GetSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });
      const task = store.get(taskId);
      if (!task) {
        return jsonResult({ ok: false, error: `task ${taskId} not found` });
      }
      const includeEvents = params.include_recent_events !== false;
      const limit = readNumberParam(params, "recent_events_limit", { integer: true }) ?? 50;
      let recentEvents: unknown[] = [];
      if (includeEvents) {
        const journal = getActiveEventJournal();
        if (journal) {
          recentEvents = journal.query({ taskId, limit });
        }
      }
      return jsonResult({ ok: true, task, recentEvents });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_list (Phase B).
// ---------------------------------------------------------------------------

const ListSchema = Type.Object({
  status: Type.Optional(Type.Union([StatusSchema, Type.Array(StatusSchema)])),
  parent_task_id: Type.Optional(Type.String()),
  source: Type.Optional(
    Type.Union([
      Type.Literal("user"),
      Type.Literal("curiosity"),
      Type.Literal("subagent"),
      Type.Literal("judge"),
      Type.Literal("operator"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  since_ts: Type.Optional(Type.Integer({ minimum: 0 })),
});

export function createTaskListTool(): AnyAgentTool {
  return {
    label: "List Tasks",
    name: "task_list",
    description:
      "List long-horizon Tasks, optionally filtered by status, parent task, source, " +
      "or updated-since timestamp. Useful to see what's currently in flight, waiting, " +
      "or recently completed. Default ordering is most-recently-updated first.",
    parameters: ListSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const rawStatus = params.status;
      let status: TaskStatus | TaskStatus[] | undefined;
      if (typeof rawStatus === "string") status = rawStatus as TaskStatus;
      else if (Array.isArray(rawStatus)) status = rawStatus as TaskStatus[];
      const parentTaskId = readStringParam(params, "parent_task_id");
      const source = readStringParam(params, "source") as TaskSource | undefined;
      const limit = readNumberParam(params, "limit", { integer: true });
      const sinceTs = readNumberParam(params, "since_ts", { integer: true });
      const tasks = store.list({
        ...(status !== undefined ? { status } : {}),
        ...(parentTaskId !== undefined ? { parentTaskId } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(sinceTs !== undefined ? { sinceTs } : {}),
      });
      return jsonResult({ ok: true, count: tasks.length, tasks });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_stop (Phase B).
// ---------------------------------------------------------------------------

const StopSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  reason: Type.String({
    description: "Why the task is being stopped. Recorded in metadata.",
    minLength: 1,
    maxLength: 500,
  }),
});

export function createTaskStopTool(): AnyAgentTool {
  return {
    label: "Stop Task",
    name: "task_stop",
    description:
      "Gracefully terminate a Task. Transitions status to 'stopped' and prevents " +
      "further automatic resumption. Use this when the user cancels, when a task " +
      "is no longer relevant, or when the agent determines the goal can't be met. " +
      "Already-terminal tasks return an error.",
    parameters: StopSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });
      const reason = readStringParam(params, "reason", { required: true });
      const existing = store.get(taskId);
      if (!existing) {
        return jsonResult({ ok: false, error: `task ${taskId} not found` });
      }
      if (isTerminal(existing.status)) {
        return jsonResult({
          ok: false,
          error: `task ${taskId} is already terminal (${existing.status})`,
        });
      }
      const meta = {
        ...existing.metadata,
        stoppedReason: reason,
        stoppedAt: Date.now(),
      };
      const task = store.update(taskId, { status: "stopped", metadata: meta });
      emitTaskEvent(taskId, "stopped", { reason });
      return jsonResult({ ok: true, task });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_output (Phase B).
// ---------------------------------------------------------------------------

const OutputSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
});

export function createTaskOutputTool(): AnyAgentTool {
  return {
    label: "Get Task Output",
    name: "task_output",
    description:
      "Fetch the final artifact reference for a completed task (crystal id, file " +
      "path, URL — whatever the worker recorded as `output` on completion). Returns " +
      "an error if the task is not yet terminal or has no output recorded.",
    parameters: OutputSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });
      const task = store.get(taskId);
      if (!task) {
        return jsonResult({ ok: false, error: `task ${taskId} not found` });
      }
      if (!task.output) {
        return jsonResult({
          ok: false,
          status: task.status,
          error: `task ${taskId} has no output (status=${task.status})`,
        });
      }
      return jsonResult({
        ok: true,
        taskId,
        status: task.status,
        output: task.output,
        completedAt: task.completedAt,
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_write_handoff (Phase C).
// ---------------------------------------------------------------------------

const WriteHandoffSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  intent: Type.String({
    description:
      "One or two sentences summarizing why you're suspending now (e.g. 'context " +
      "approaching 70%; need to continue research after rest').",
    minLength: 1,
    maxLength: 2000,
  }),
  decisions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "List of material decisions made so far that the next run must respect. Be " +
        "specific — these are the constraints the cold-restart agent will inherit.",
    }),
  ),
  pending: Type.Optional(
    Type.Array(Type.String(), {
      description: "Remaining work items in priority order.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Free-form additional context (key findings, citations, partial outputs). The " +
        "structured pending/decisions arrays are preferred — use this for narrative.",
    }),
  ),
  context_tokens: Type.Optional(
    Type.Integer({
      description: "Approximate token budget at handoff time. Informational; cap 1M.",
      minimum: 0,
    }),
  ),
});

export function createTaskWriteHandoffTool(): AnyAgentTool {
  return {
    label: "Write Task Handoff",
    name: "task_write_handoff",
    description:
      "Author a structured handoff record for a long-horizon task. Call this when " +
      "you're about to suspend the task — typically at a rest boundary, when context " +
      "is approaching saturation (~70% of the model's window), or when an external " +
      "dependency blocks progress. The handoff captures intent, decisions, and " +
      "pending work so the next run can rebuild context cold without summarization. " +
      "Use task_schedule_wakeup right after to schedule the resume. " +
      "Returns { ok, handoff:{id,...} }.",
    parameters: WriteHandoffSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });
      const intent = readStringParam(params, "intent", { required: true });
      const decisions = readStringArrayParam(params, "decisions");
      const pending = readStringArrayParam(params, "pending");
      const context = readStringParam(params, "context");
      const contextTokens = readNumberParam(params, "context_tokens", { integer: true });

      try {
        const handoff = store.writeHandoff({
          taskId,
          intent,
          ...(decisions ? { decisions } : {}),
          ...(pending ? { pending } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(typeof contextTokens === "number" ? { contextTokens } : {}),
        });
        emitTaskEvent(taskId, "handoff_written", {
          handoffId: handoff.id,
          intent,
          decisionsCount: handoff.decisions.length,
          pendingCount: handoff.pending.length,
        });
        return jsonResult({ ok: true, handoff });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// task_read_handoff (Phase C).
// ---------------------------------------------------------------------------

const ReadHandoffSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  list: Type.Optional(
    Type.Boolean({
      description: "When true, returns the recent N handoffs. Default: returns only the latest.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export function createTaskReadHandoffTool(): AnyAgentTool {
  return {
    label: "Read Task Handoff",
    name: "task_read_handoff",
    description:
      "Read the latest structured handoff record for a task. This is the FIRST thing " +
      "to call when resuming a long-horizon task — it gives you the intent, the " +
      "decisions you made before suspending, and the pending work in priority order. " +
      "Combined with task_get (for status/plan) and the original goal/done_criteria, " +
      "the handoff is enough to rebuild a fresh context cold. Pass list=true to see " +
      "the full handoff history.",
    parameters: ReadHandoffSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const taskId = readStringParam(params, "task_id", { required: true });
      const list = params.list === true;
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
      if (list) {
        const handoffs = store.listHandoffs(taskId, limit);
        return jsonResult({ ok: true, count: handoffs.length, handoffs });
      }
      const latest = store.latestHandoff(taskId);
      if (!latest) {
        return jsonResult({ ok: false, error: `no handoff for task ${taskId}` });
      }
      return jsonResult({ ok: true, handoff: latest });
    }),
  };
}

// ---------------------------------------------------------------------------
// task_schedule_wakeup (Phase C).
// ---------------------------------------------------------------------------

const ScheduleWakeupSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  delay_seconds: Type.Optional(
    Type.Integer({
      description:
        "Delay before the wakeup fires, in seconds. Mutually exclusive with at_iso. " +
        "Minimum 5 seconds (cron tick floor).",
      minimum: 5,
    }),
  ),
  at_iso: Type.Optional(
    Type.String({
      description:
        "ISO-8601 timestamp to fire at. Mutually exclusive with delay_seconds. Must " +
        "be in the future.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description:
        "Override the default wakeup-prompt message. Defaults to a structured " +
        "'resume task X via handoff Y' instruction that the model is expected to follow.",
      maxLength: 4000,
    }),
  ),
  handoff_id: Type.Optional(
    Type.Integer({
      description:
        "Specific handoff id to reference. Defaults to the latest handoff for the task " +
        "(the conventional and correct choice).",
      minimum: 1,
    }),
  ),
  reason: Type.String({
    description:
      "Why you're scheduling this wakeup. Recorded in the task event journal so the " +
      "operator can audit the wakeup chain.",
    minLength: 1,
    maxLength: 500,
  }),
});

export function createTaskScheduleWakeupTool(): AnyAgentTool {
  return {
    label: "Schedule Task Wakeup",
    name: "task_schedule_wakeup",
    description:
      "Schedule a future agent invocation that will resume this task. The receiving " +
      "agent gets a structured message instructing it to read the latest handoff and " +
      "continue. Use this after task_write_handoff to suspend cleanly across context " +
      "boundaries, rest periods, or external waits. Provide either delay_seconds or " +
      "at_iso (not both). Hard cap of 50 wakeups per task prevents runaway loops; " +
      "raise BITTERBOT_TASKS_MAX_WAKEUPS to override.",
    parameters: ScheduleWakeupSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const cron = getCronEngine();
      if (!cron) {
        return jsonResult({
          ok: false,
          error:
            "cron engine is not active — task wakeups cannot be scheduled. Check " +
            "BITTERBOT_SKIP_CRON and the gateway cron config.",
        });
      }

      const taskId = readStringParam(params, "task_id", { required: true });
      const reason = readStringParam(params, "reason", { required: true });
      const delaySeconds = readNumberParam(params, "delay_seconds", { integer: true });
      const atIso = readStringParam(params, "at_iso");
      const messageOverride = readStringParam(params, "message");
      const handoffId = readNumberParam(params, "handoff_id", { integer: true });

      const task = store.get(taskId);
      if (!task) {
        return jsonResult({ ok: false, error: `task ${taskId} not found` });
      }
      if (isTerminal(task.status)) {
        return jsonResult({
          ok: false,
          error: `task ${taskId} is terminal (${task.status}); cannot schedule wakeup`,
        });
      }

      const maxWakeups = readMaxWakeups();
      if (task.wakeupCount >= maxWakeups) {
        return jsonResult({
          ok: false,
          error: `task ${taskId} has hit the wakeup cap (${task.wakeupCount}/${maxWakeups})`,
        });
      }

      const atMs = computeAtMs(delaySeconds, atIso);
      if (atMs instanceof Error) {
        return jsonResult({ ok: false, error: atMs.message });
      }

      const effectiveHandoffId = handoffId ?? store.latestHandoff(taskId)?.id;
      const message =
        messageOverride ?? buildResumeMessage({ task, handoffId: effectiveHandoffId, reason });

      const job: CronJob = {
        jobId: `task-wakeup-${taskId}-${Date.now().toString(36)}-${randomTag()}`,
        name: `task wakeup: ${truncatePreview(task.goal)}`,
        description: `Resume task ${taskId}: ${truncatePreview(reason, 80)}`,
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message,
          taskId,
          ...(typeof effectiveHandoffId === "number" ? { handoffId: effectiveHandoffId } : {}),
          ...(task.checkpoint
            ? {
                resumeFromCheckpoint: {
                  threadId: task.checkpoint.threadId,
                  stepId: task.checkpoint.stepId,
                },
              }
            : {}),
        },
        delivery: { mode: "none" },
        notify: false,
        deleteAfterRun: true,
        consecutiveErrors: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      try {
        const persisted = await cron.upsertJob(job);
        // Mark the task as waiting and bump wakeupCount atomically.
        store.update(taskId, {
          status: "waiting_external",
          incrementWakeup: true,
        });
        emitTaskEvent(taskId, "wakeup_scheduled", {
          jobId: persisted.jobId,
          atMs,
          atIso: new Date(atMs).toISOString(),
          handoffId: effectiveHandoffId,
          reason,
        });
        return jsonResult({
          ok: true,
          taskId,
          jobId: persisted.jobId,
          atIso: new Date(atMs).toISOString(),
          atMs,
          handoffId: effectiveHandoffId,
          wakeupCount: task.wakeupCount + 1,
          wakeupCap: maxWakeups,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// task_judge (Phase D).
// ---------------------------------------------------------------------------

const JudgeSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  /** Maximum rounds before forcing a failed terminal verdict. */
  max_rounds: Type.Optional(
    Type.Integer({
      description: "Override the judge round cap. Defaults to 5.",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

export function createTaskJudgeTool(): AnyAgentTool {
  return {
    label: "Judge Task",
    name: "task_judge",
    description:
      "Run the planner/worker/judge verification pass on a task that is in " +
      "status='judging' (or status='running' if you want a mid-run check). The " +
      "Judge is an INDEPENDENT pass: it sees only the goal, done_criteria, plan-" +
      "step statuses, output reference, and latest handoff — never the worker's " +
      "chain of thought. Three verdicts: 'pass' (→ completed), 'fail' (→ " +
      "rejecting handoff written, task back to running OR failed at round cap), " +
      "'needs_more' (→ feedback handoff, back to running). Use this *before* " +
      "transitioning a task to 'completed' yourself — let the judge gatekeep.",
    parameters: JudgeSchema,
    execute: safeExecute(async (_toolCallId, params) => {
      const store = getActiveTaskStore();
      if (!store) return storeUnavailable();
      const llmCall = getJudgeLlmCall();
      if (!llmCall) {
        return jsonResult({
          ok: false,
          error:
            "judge LLM call is not registered. Configure the judge provider during " +
            "gateway boot via registerJudgeLlmCall(). For tests, register a stub.",
        });
      }
      const taskId = readStringParam(params, "task_id", { required: true });
      const maxRounds =
        readNumberParam(params, "max_rounds", { integer: true }) ?? DEFAULT_MAX_JUDGE_ROUNDS;

      const task = store.get(taskId);
      if (!task) {
        return jsonResult({ ok: false, error: `task ${taskId} not found` });
      }
      if (isTerminal(task.status)) {
        return jsonResult({
          ok: false,
          error: `task ${taskId} is terminal (${task.status}); judge cannot rerun`,
        });
      }

      const latestHandoff = store.latestHandoff(taskId) ?? null;
      const decision = await runTaskJudge({ task, output: task.output, latestHandoff }, llmCall);

      if (!decision) {
        emitTaskEvent(taskId, "judge_error", { reason: "judge response unparseable" });
        return jsonResult({
          ok: false,
          error: "judge returned an unparseable response. Inspect the LLM provider and retry.",
        });
      }

      const judgeRounds = readJudgeRounds(task) + 1;
      const verdict = decision.verdict;
      const metadata = {
        ...task.metadata,
        judgeRounds,
        lastJudgeAt: Date.now(),
        lastJudgeVerdict: verdict,
        lastJudgeReasoning: decision.reasoning,
        ...(decision.missing ? { lastJudgeMissing: decision.missing } : {}),
      };

      let nextStatus: TaskStatus;
      if (verdict === "pass") {
        nextStatus = "completed";
      } else if (verdict === "needs_more") {
        nextStatus = "running";
      } else {
        nextStatus = judgeRounds >= maxRounds ? "failed" : "running";
      }

      // For fail/needs_more, write a rejecting handoff so the worker sees the
      // judge's feedback when it resumes.
      if (verdict !== "pass") {
        try {
          store.writeHandoff({
            taskId,
            intent: `Judge ${verdict}: ${decision.reasoning}`,
            pending: decision.missing ?? [],
            decisions: [`judge round ${judgeRounds} of ${maxRounds}`],
          });
        } catch (err) {
          log_(err, taskId);
        }
      }

      const updated = store.update(taskId, { status: nextStatus, metadata });
      emitTaskEvent(taskId, "judged", {
        verdict,
        reasoning: decision.reasoning,
        ...(decision.missing ? { missing: decision.missing } : {}),
        judgeRounds,
        nextStatus,
      });

      return jsonResult({
        ok: true,
        verdict,
        reasoning: decision.reasoning,
        missing: decision.missing ?? [],
        judgeRounds,
        maxRounds,
        nextStatus,
        task: updated,
      });
    }),
  };
}

function readJudgeRounds(task: Task): number {
  const meta = task.metadata as Record<string, unknown> | null;
  const raw = meta?.judgeRounds;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function log_(err: unknown, taskId: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `task_judge: failed to write feedback handoff for ${taskId}:`,
    err instanceof Error ? err.message : String(err),
  );
}

// Re-export the decision type so callers (e.g. operator dashboards) can type
// their responses.
export type { TaskJudgeDecision };

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function storeUnavailable() {
  return jsonResult({
    ok: false,
    error:
      "task store is not active. Start the gateway and ensure tasks aren't disabled " +
      "via BITTERBOT_TASKS_DISABLED.",
  });
}

function computeAtMs(delaySeconds: number | undefined, atIso: string | undefined): number | Error {
  const now = Date.now();
  if (typeof delaySeconds === "number" && atIso) {
    return new Error("specify either delay_seconds or at_iso, not both");
  }
  if (typeof delaySeconds === "number") {
    return now + delaySeconds * 1000;
  }
  if (atIso) {
    const parsed = Date.parse(atIso);
    if (Number.isNaN(parsed)) {
      return new Error(`at_iso is not a valid ISO-8601 timestamp: ${atIso}`);
    }
    if (parsed <= now) {
      return new Error(`at_iso must be in the future (got ${atIso})`);
    }
    return parsed;
  }
  return new Error("provide either delay_seconds or at_iso");
}

function buildResumeMessage(args: {
  task: Task;
  handoffId: number | undefined;
  reason: string;
}): string {
  const { task, handoffId, reason } = args;
  const handoffLine =
    typeof handoffId === "number"
      ? `Read the structured handoff via task_read_handoff({task_id:"${task.id}"}) — handoff id ${handoffId}.`
      : `No prior handoff was recorded; call task_get({task_id:"${task.id}"}) for current state.`;
  return [
    `[long-horizon wakeup] Resume task ${task.id}.`,
    `Goal: ${task.goal}`,
    `Done criteria: ${task.doneCriteria}`,
    `Wakeup reason: ${reason}`,
    handoffLine,
    `If done criteria are met, transition the task to status="judging" via task_update so the Judge can verify. ` +
      `Otherwise continue the work. When you must suspend again, use task_write_handoff + task_schedule_wakeup.`,
  ].join("\n");
}

function readMaxWakeups(): number {
  const raw = process.env.BITTERBOT_TASKS_MAX_WAKEUPS;
  if (!raw) return DEFAULT_MAX_WAKEUPS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_WAKEUPS;
  return parsed;
}

function truncatePreview(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function randomTag(): string {
  return crypto.randomBytes(3).toString("hex");
}

function parsePlanArray(raw: unknown): TaskPlan | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new ToolInputError("plan must be an array of steps");
  }
  const steps: PlanStep[] = raw.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError(`plan[${idx}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const id = readStringParam(e, "id", { required: true });
    const title = readStringParam(e, "title", { required: true });
    const description = readStringParam(e, "description");
    const status = (readStringParam(e, "status") ?? "pending") as PlanStepStatus;
    return {
      id,
      title,
      ...(description !== undefined ? { description } : {}),
      status,
    };
  });
  return { steps };
}

function emitTaskEvent(taskId: string, phase: string, data: Record<string, unknown>): void {
  emitAgentEvent({
    runId: `task:${taskId}`,
    taskId,
    stream: "task",
    data: { phase, ...data },
  });
}

// Re-export the store type for convenience in callers that need direct access.
export type { TaskStore };
