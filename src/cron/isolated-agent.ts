import crypto from "node:crypto";
import type { HookMessageChannel } from "../gateway/hooks.js";
import type { CronJob, CronPayloadAgentTurn } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { AGENT_LANE_NESTED } from "../agents/lanes.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner/run.js";
import { readLatestAssistantReply } from "../agents/tools/agent-step.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { resolveSessionTranscriptPath } from "../config/sessions/paths.js";
import { callGateway } from "../gateway/call.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

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
  const reply = await invokeAgentTurn({ job, sessionKey, agentId });
  const delivery = job.delivery;
  const mode = delivery?.mode ?? "announce";
  if (mode === "none") {
    log.info(`isolated cron run ${job.jobId} (delivery=none, len=${reply?.length ?? 0})`);
    return;
  }

  if (!reply || !reply.trim()) {
    if (delivery?.bestEffort) {
      log.info(`isolated cron run ${job.jobId} produced no reply (best-effort, skipping announce)`);
      return;
    }
    throw new Error("isolated cron job produced no assistant reply to announce");
  }

  const channel = pickAnnounceChannel(delivery?.channel);
  const to = delivery?.to?.trim();
  if (!channel || !to) {
    if (delivery?.bestEffort) {
      log.warn(`cron job ${job.jobId} announce skipped: missing channel/to (best-effort)`);
      return;
    }
    throw new Error("announce delivery requires both delivery.channel and delivery.to");
  }

  await deliverOutboundPayloads({
    cfg,
    channel: channel as Exclude<typeof channel, "none">,
    to,
    payloads: [{ text: reply }],
    agentId,
    bestEffort: delivery?.bestEffort,
  });
  log.info(`cron ${job.jobId} delivered to ${channel}:${to}`);

  // Per docs/automation/cron-jobs.md: announce mode also posts a brief summary
  // to the agent's main session, respecting wakeMode. This keeps the operator
  // aware of what the cron run did even when the answer landed elsewhere.
  postMainSessionSummary({ job, reply, agentId, channel, to });
}

function postMainSessionSummary(args: {
  job: CronJob;
  reply: string;
  agentId: string;
  channel: string;
  to: string;
}): void {
  const { job, reply, agentId, channel, to } = args;
  try {
    const cfg = loadConfig();
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
    const summary = truncate(reply, 280);
    const tag = `[cron:${job.jobId}${job.name ? ` ${job.name}` : ""}]`;
    const text = `${tag} delivered to ${channel}:${to} — ${summary}`;
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
  const params: Record<string, unknown> = {
    message,
    sessionKey,
    idempotencyKey: idem,
    deliver: false,
    channel: INTERNAL_MESSAGE_CHANNEL,
    lane: AGENT_LANE_NESTED,
    agentId,
    inputProvenance: {
      kind: "cron",
      jobId: job.jobId,
      sessionKey,
    },
  };
  if (payload.model) {
    params.model = payload.model;
  }
  if (payload.thinking) {
    params.thinking = payload.thinking;
  }

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
  return `${tag} ${payload.message}`.trim();
}

function pickAnnounceChannel(input: string | undefined): string | undefined {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed || trimmed === "last") {
    return undefined;
  }
  return trimmed;
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
