/**
 * The `cron` tool: the agent schedules its own reminders and recurring work
 * (PLAN-53 E6).
 *
 * The system prompt, the tool policy groups and the tool display table have
 * all named this tool for a long time; it did not exist. An agent asked to
 * "remind me on Friday" could only say it would.
 */

import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { getCronEngine } from "../../cron/active.js";
import type { CronEngine } from "../../cron/engine.js";
import { applyJobPatch, buildJobFromParams, jobToWire } from "../../cron/normalize.js";
import { assertScheduleValid } from "../../cron/schedule.js";
import { readRuns } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveDefaultAgentId } from "../agent-scope.js";
import { currentRunIsNonOwner } from "../run-owner-context.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;

// A flat object: some providers reject unions and nested anyOf in tool schemas.
const CronToolSchema = Type.Object({
  action: stringEnum(CRON_ACTIONS, {
    description:
      "status | list | add (needs job) | update (needs id + patch) | remove | run | runs (history) | wake (queue a note for yourself now)",
  }),
  id: Type.Optional(Type.String({ description: "Job id, for update, remove, run and runs." })),
  job: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          'For add. Fields: name; schedule = {kind:"at", at:"<ISO time>"} for one time, {kind:"every", everyMs:<ms>} for an interval, or {kind:"cron", expr:"0 9 * * 1-5", tz:"America/New_York"}; ' +
          'then EITHER text (a note delivered into your main session at that time: use for reminders) OR message (a prompt run as its own agent turn: use for work to do, e.g. "summarize open tasks"). ' +
          'Optional: delivery = {mode:"announce", channel, to} to send the result to a specific chat, or {mode:"none"}; retryUntilMs for a one-time job that should keep trying; deleteAfterRun.',
      },
    ),
  ),
  patch: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "For update: the job fields to change, e.g. {enabled:false} or {schedule:{...}}.",
      },
    ),
  ),
  mode: Type.Optional(
    Type.String({ description: 'For run: "force" (default) or "due" (only if it is due).' }),
  ),
  limit: Type.Optional(Type.Number({ description: "For runs: how many (default 10)." })),
  text: Type.Optional(Type.String({ description: "For wake: the note to queue." })),
  includeDisabled: Type.Optional(Type.Boolean()),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function engineOrThrow(): CronEngine {
  const engine = getCronEngine();
  if (!engine) {
    throw new Error("Scheduling is not available: the cron engine is not running on this gateway.");
  }
  return engine;
}

function jobOrThrow(engine: CronEngine, id: string): CronJob {
  const job = engine.getJob(id);
  if (!job) {
    throw new Error(`No scheduled job with id ${id}. Use action "list" to see the ids.`);
  }
  return job;
}

/**
 * The scheduler picks a job's kind from its schedule unless told otherwise
 * (a one-time job is a note, a recurring one is a task to run). The tool's
 * contract is simpler and is what the model was told: `text` is always a note
 * into the main session, `message` is always a task run as its own turn.
 */
function shapeJob(job: Record<string, unknown>): Record<string, unknown> {
  if (job.payload !== undefined || job.sessionTarget !== undefined || job.session !== undefined) {
    return job;
  }
  if (typeof job.message === "string" && job.message.trim()) {
    return { ...job, sessionTarget: "isolated" };
  }
  if (typeof job.text === "string" && job.text.trim()) {
    const { text, ...rest } = job;
    return { ...rest, systemEvent: text, sessionTarget: "main" };
  }
  return job;
}

/**
 * A job the agent builds while working for someone who is not the owner must
 * not run later with the owner's tools.
 */
function withCallerAuthority(job: CronJob): CronJob {
  if (job.payload.kind !== "agentTurn" || !currentRunIsNonOwner()) {
    return job;
  }
  return { ...job, payload: { ...job.payload, senderIsOwner: false } };
}

export function createCronTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description: [
      "Schedule reminders and recurring work, and see how scheduled jobs are doing.",
      'Use it whenever the user asks to be reminded, or for something "every day / every Friday / in 20 minutes".',
      "A reminder is a job with `text`; work to carry out later is a job with `message`.",
      "Times are absolute: turn 'in 20 minutes' or 'Friday at 4 PM' into an ISO time or a cron expression with the user's timezone.",
      "A failed job is reported to the owner and its history kept; check `runs` before saying a job worked.",
    ].join(" "),
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "wake") {
        const text = readStringParam(params, "text", { required: true });
        const cfg = loadConfig();
        const sessionKey =
          opts?.agentSessionKey ??
          resolveAgentMainSessionKey({ cfg, agentId: resolveDefaultAgentId(cfg) });
        enqueueSystemEvent(text, { sessionKey, contextKey: "cron:wake" });
        requestHeartbeatNow({ reason: "wake" });
        return jsonResult({ ok: true, queued: text });
      }

      const engine = engineOrThrow();
      switch (action) {
        case "status":
          return jsonResult(engine.status());
        case "list": {
          const includeDisabled = params.includeDisabled !== false;
          const jobs = engine.listJobs().filter((job) => includeDisabled || job.enabled);
          return jsonResult({ jobs: jobs.map(jobToWire) });
        }
        case "add": {
          if (!isRecord(params.job)) {
            throw new Error('add needs `job`, e.g. {name, schedule:{kind:"at", at:"..."}, text}.');
          }
          const job = withCallerAuthority(buildJobFromParams(shapeJob(params.job)));
          assertScheduleValid(job.schedule);
          return jsonResult({ ok: true, job: jobToWire(await engine.upsertJob(job)) });
        }
        case "update": {
          const id = readStringParam(params, "id", { required: true });
          const existing = jobOrThrow(engine, id);
          if (!isRecord(params.patch)) {
            throw new Error("update needs `patch` with the fields to change.");
          }
          const next = withCallerAuthority(applyJobPatch(existing, params.patch));
          assertScheduleValid(next.schedule);
          const saved = await engine.upsertJob({
            ...next,
            consecutiveErrors: existing.consecutiveErrors ?? 0,
            lastRunAt: existing.lastRunAt,
            lastRunStatus: existing.lastRunStatus,
            createdAt: existing.createdAt,
          });
          return jsonResult({ ok: true, job: jobToWire(saved) });
        }
        case "remove": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult({ ok: await engine.removeJob(id) });
        }
        case "run": {
          const id = readStringParam(params, "id", { required: true });
          jobOrThrow(engine, id);
          return jsonResult(await engine.runJob(id, params.mode === "due" ? "due" : "force"));
        }
        case "runs": {
          const id = readStringParam(params, "id", { required: true });
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? Math.max(1, Math.min(Math.floor(params.limit), 200))
              : 10;
          const runs = await readRuns(engine.paths_().runsDir, id, limit);
          return jsonResult({ runs, count: runs.length });
        }
        default:
          throw new Error(`Unknown cron action: ${action}. Use one of ${CRON_ACTIONS.join(", ")}.`);
      }
    },
  };
}
