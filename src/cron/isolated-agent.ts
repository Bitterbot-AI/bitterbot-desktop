import crypto from "node:crypto";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../agents/embedded-runner/run.js";
import { AGENT_LANE_NESTED } from "../agents/lanes.js";
import { readLatestAssistantReply } from "../agents/tools/agent-step.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveSessionTranscriptPath } from "../config/sessions/paths.js";
import { getCronEngine } from "../cron/active.js";
import { callGateway } from "../gateway/call.js";
import type { HookMessageChannel } from "../gateway/hooks.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { acquireTaskSlot, releaseTaskSlot } from "../tasks/active-task-tracker.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { type AnnouncePlan, resolveAnnouncePlan } from "./announce-plan.js";
import { lateNoteFor } from "./schedule.js";
import type { CronJob, CronPayloadAgentTurn } from "./types.js";

const log = createSubsystemLogger("gateway/cron");
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

// Run an isolated cron job: invoke an agent turn in `cron:<jobId>` and (when
// configured) announce the assistant's reply over the configured channel.
// Errors propagate to the engine which records the failure and applies the
// retry/backoff policy.
export async function runIsolatedJob(job: CronJob): Promise<void> {
  if (job.payload.kind !== "agentTurn") {
    throw new Error('isolated jobs require payload.kind = "agentTurn"');
  }
  const sessionKey = `cron:${job.jobId}`;
  const cfg = loadConfig();
  const agentId = job.agentId ?? resolveDefaultAgentId(cfg);

  // Where the reply goes is decided before the turn: a job that cannot
  // deliver fails here, without paying for a model call first.
  const plan = resolveAnnouncePlan({
    delivery: job.delivery,
    mainEntry: job.delivery?.mode === "none" ? undefined : readMainSessionEntry(cfg, agentId),
    cfg,
  });

  // PLAN-17 Phase 2 E.3: when this is a long-horizon task wakeup,
  // gate on the hormonal concurrency policy. If we're at capacity,
  // re-schedule the wakeup 60s out and exit cleanly so other tasks can
  // breathe. The cron engine will fire us again. Disable with
  // BITTERBOT_TASKS_CONCURRENCY_GATE=0.
  const payload = job.payload as CronPayloadAgentTurn;
  const isTaskWakeup =
    process.env.BITTERBOT_TASKS_CONCURRENCY_GATE !== "0" && typeof payload.taskId === "string";
  let acquired = false;
  if (isTaskWakeup) {
    const slot = acquireTaskSlot({ jobId: job.jobId });
    if (!slot.ok) {
      const engine = getCronEngine();
      if (engine) {
        const nextAtMs = Date.now() + 60_000;
        try {
          // A NEW job id: this run ends "ok", and the engine then deletes the
          // one-shot it just ran. Re-using the id had the deferred wakeup
          // deleted with it, so the task never resumed.
          await engine.upsertJob({
            ...job,
            jobId: deferredJobId(job.jobId),
            schedule: { kind: "at", at: new Date(nextAtMs).toISOString() },
            nextRunAt: nextAtMs,
            lastRunAt: undefined,
            lastStartedAt: undefined,
            lastRunStatus: undefined,
          });
          log.info(
            `cron ${job.jobId}: deferring task wakeup (${slot.reason}, inflight=${slot.inflight}/${slot.policy.maxConcurrent}, policy=${slot.policy.rationale})`,
          );
          return;
        } catch (err) {
          log.warn(
            `cron ${job.jobId}: failed to defer task wakeup: ${formatErr(err)}; proceeding anyway`,
          );
        }
      } else {
        log.warn(`cron ${job.jobId}: at task capacity but no cron engine to defer; proceeding`);
      }
    }
    acquired = true;
  }

  let reply: string | undefined;
  try {
    reply = await invokeAgentTurn({ job, sessionKey, agentId });
  } finally {
    if (acquired) {
      releaseTaskSlot(job.jobId);
    }
  }
  await finishIsolatedRun({ job, plan, reply, agentId, sessionKey });
}

function readMainSessionEntry(
  cfg: ReturnType<typeof loadConfig>,
  agentId: string,
): SessionEntry | undefined {
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    return loadSessionStore(storePath)[resolveAgentMainSessionKey({ cfg, agentId })];
  } catch (err) {
    log.warn(`could not read the main session entry for ${agentId}: ${formatErr(err)}`);
    return undefined;
  }
}

async function finishIsolatedRun(args: {
  job: CronJob;
  plan: AnnouncePlan;
  reply: string | undefined;
  agentId: string;
  sessionKey: string;
}): Promise<void> {
  const { job, plan, reply, agentId, sessionKey } = args;
  if (plan.kind === "none") {
    log.info(`isolated cron run ${job.jobId} (delivery=none, len=${reply?.length ?? 0})`);
    return;
  }

  if (!reply || !reply.trim()) {
    if (plan.kind === "main-only" || job.delivery?.bestEffort) {
      log.info(`isolated cron run ${job.jobId} produced no reply (nothing to announce)`);
      return;
    }
    throw new Error("isolated cron job produced no assistant reply to announce");
  }

  if (plan.kind === "main-only") {
    log.info(`cron ${job.jobId}: ${plan.reason}; result kept in the main session`);
    postMainSessionSummary({
      job,
      reply,
      agentId,
      where: `finished (not sent to a channel; full reply in session ${sessionKey})`,
    });
    return;
  }

  await deliverOutboundPayloads({
    cfg: loadConfig(),
    channel: plan.channel,
    to: plan.to,
    ...(plan.accountId ? { accountId: plan.accountId } : {}),
    ...(plan.threadId != null ? { threadId: plan.threadId } : {}),
    payloads: [{ text: reply }],
    agentId,
    bestEffort: job.delivery?.bestEffort,
  });
  log.info(`cron ${job.jobId} delivered to ${plan.channel}:${plan.to}`);

  // Per docs/automation/cron-jobs.md: announce mode also posts a brief summary
  // to the agent's main session, respecting wakeMode. This keeps the operator
  // aware of what the cron run did even when the answer landed elsewhere.
  postMainSessionSummary({
    job,
    reply,
    agentId,
    where: `delivered to ${plan.channel}:${plan.to}`,
  });
}

function postMainSessionSummary(args: {
  job: CronJob;
  reply: string;
  agentId: string;
  /** What happened to the reply, e.g. "delivered to telegram:123". */
  where: string;
}): void {
  const { job, reply, agentId, where } = args;
  try {
    const cfg = loadConfig();
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
    const summary = truncate(reply, 280);
    const tag = `[cron:${job.jobId}${job.name ? ` ${job.name}` : ""}]`;
    const text = `${tag} ${where} — ${summary}`;
    enqueueSystemEvent(text, { sessionKey, contextKey: `cron:${job.jobId}` });
    if (job.wakeMode === "now") {
      requestHeartbeatNow({ reason: `cron:${job.jobId}:summary` });
    }
  } catch (err) {
    log.warn(`could not post main-session summary for ${job.jobId}: ${formatErr(err)}`);
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1).trimEnd()}…`;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Build the gateway `agent` RPC params for a cron-fired turn. Exported for
 * tests: this shape MUST validate against AgentParamsSchema — the previous
 * inputProvenance shape ({kind:"cron", jobId, sessionKey}) was rejected with
 * INVALID_REQUEST, which silently broke EVERY task wakeup: cron fired, the
 * agent RPC bounced, and tasks sat in waiting_external forever.
 */
export function buildIsolatedAgentTurnParams(args: {
  message: string;
  sessionKey: string;
  agentId: string;
  idempotencyKey: string;
  model?: string;
  thinking?: string;
  /** `false` for a job scheduled by a non-owner run. */
  senderIsOwner?: false;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    message: args.message,
    sessionKey: args.sessionKey,
    idempotencyKey: args.idempotencyKey,
    deliver: false,
    channel: INTERNAL_MESSAGE_CHANNEL,
    lane: AGENT_LANE_NESTED,
    agentId: args.agentId,
    // Canonical InputProvenance: the job id lives in the message text and
    // the task journal; it needs no schema field.
    inputProvenance: {
      kind: "internal_system",
      sourceChannel: "cron",
      sourceSessionKey: args.sessionKey,
    },
  };
  if (args.model) {
    // The agent RPC schema has no `model` field and the server method never
    // read one — sending it is schema-fatal (additionalProperties: false).
    // Surface the unsupported override instead of failing the whole turn.
    log.warn(
      `cron payload.model ("${args.model}") is not supported on the agent RPC; using the session's configured model`,
    );
  }
  if (args.thinking) {
    params.thinking = args.thinking;
  }
  if (args.senderIsOwner === false) {
    params.senderIsOwner = false;
  }
  return params;
}

async function invokeAgentTurn(args: {
  job: CronJob;
  sessionKey: string;
  agentId: string;
}): Promise<string | undefined> {
  const { job, sessionKey, agentId } = args;
  const payload = job.payload as CronPayloadAgentTurn;
  const message = formatTurnMessage(job, payload);
  const idem = crypto.randomUUID();
  const timeoutMs =
    typeof payload.timeoutSeconds === "number" && payload.timeoutSeconds > 0
      ? Math.min(payload.timeoutSeconds * 1_000, 30 * 60_000)
      : DEFAULT_TURN_TIMEOUT_MS;
  const params = buildIsolatedAgentTurnParams({
    message,
    sessionKey,
    agentId,
    idempotencyKey: idem,
    model: payload.model,
    thinking: payload.thinking,
    senderIsOwner: payload.senderIsOwner,
  });

  const response = await callGateway<{ runId?: string }>({
    method: "agent",
    params,
    timeoutMs: 15_000,
  });
  const runId = typeof response?.runId === "string" && response.runId ? response.runId : idem;
  const wait = await callGateway<{ status?: string; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs },
    timeoutMs: timeoutMs + 2_000,
  });
  if (wait?.status !== "ok") {
    const detail = typeof wait?.error === "string" ? wait.error : (wait?.status ?? "unknown");
    throw new Error(`agent turn did not complete cleanly: ${detail}`);
  }
  return readLatestAssistantReply({ sessionKey });
}

function formatTurnMessage(job: CronJob, payload: CronPayloadAgentTurn): string {
  const tag = `[cron:${job.jobId}${job.name ? ` ${job.name}` : ""}]`;
  const note = lateNoteFor(job, Date.now());
  return `${tag} ${payload.message}${note ? `\n\n${note}` : ""}`.trim();
}

const DEFERRED_SUFFIX = /-d[0-9a-z]+$/;

/** `<id>-d<time>`: one suffix however many times a wakeup is deferred. */
export function deferredJobId(jobId: string): string {
  return `${jobId.replace(DEFERRED_SUFFIX, "")}-d${Date.now().toString(36)}`;
}

// Shared "run an isolated agent turn" entrypoint used by the hooks dispatcher
// (and by anything else that wants the same lane semantics + summary shape).
// Cron's own `runIsolatedJob` keeps using the in-process gateway round-trip so
// it picks up the full agent dispatch path; this function is for callers that
// already live inside the gateway process and want a direct embedded run.
export type IsolatedAgentJob = {
  agentId?: string;
  name?: string;
  payload: {
    message: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };
  channel?: HookMessageChannel;
  to?: string;
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
};

export type IsolatedAgentResult = {
  status: "ok" | "error";
  summary: string;
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
};

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

export async function runIsolatedAgentTurn(args: {
  sessionKey: string;
  job: IsolatedAgentJob;
  lane?: string;
  runId?: string;
}): Promise<IsolatedAgentResult> {
  const { sessionKey, job } = args;
  const cfg = loadConfig();
  const agentId = job.agentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const runId = args.runId ?? crypto.randomUUID();
  const sessionId = `hook-${runId}`;
  const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
  const timeoutMs = job.payload.timeoutSeconds
    ? job.payload.timeoutSeconds * 1_000
    : DEFAULT_HOOK_TIMEOUT_MS;

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      agentId,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: job.payload.message,
      model: job.payload.model,
      thinkLevel: job.payload.thinking as "off" | "minimal" | "low" | "medium" | "high" | undefined,
      timeoutMs,
      runId,
      messageChannel: job.channel,
      messageTo: job.to,
      requireExplicitMessageTarget: !job.deliver,
      disableMessageTool: !job.deliver,
      lane: args.lane ?? "hook",
    });

    const hasError = result.meta?.error != null || result.meta?.aborted;
    const summaryText =
      result.payloads?.[0]?.text?.trim() ||
      result.meta?.error?.message?.trim() ||
      (hasError ? "error" : "ok");
    return {
      status: hasError ? "error" : "ok",
      summary: summaryText,
      payloads: result.payloads,
    };
  } catch (err) {
    return {
      status: "error",
      summary: formatErr(err),
    };
  }
}
