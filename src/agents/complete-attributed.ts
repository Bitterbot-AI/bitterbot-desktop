/**
 * PLAN-50: the one non-streaming completion helper for hidden LLM lanes.
 *
 * `completeSimple` was copy-pasted into four places (memory manager, task judge, RLM deep recall,
 * TTS summaries), each discarding `res.usage`. This helper resolves the model, calls the provider,
 * records the usage in the ledger BEFORE surfacing a provider error (a failed call still burns
 * input tokens, and judges retry three times), and returns the text.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { BitterbotConfig } from "../config/config.js";
import type { UsageKind } from "../infra/usage-ledger.types.js";
import {
  ANTHROPIC_BATCH_DEFAULT_MAX_WAIT_MINUTES,
  batchStopReason,
  batchUsageToBuckets,
  isBatchTemporarilyUnsupported,
  runAnthropicBatchCall,
  type AnthropicBatchMessageParams,
  type AnthropicBatchTextBlock,
} from "../infra/anthropic-batch.js";
import { isBackgroundUsagePaused } from "../infra/usage-budgets.js";
import { USAGE_FEATURES } from "../infra/usage-features.js";
import { getUsageLedger, recordUsage } from "../infra/usage-ledger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/complete-attributed");

/** Lanes routed through the Message Batches API by default: latency-tolerant, never on a user turn. */
export const DEFAULT_BATCH_LANES: readonly string[] = [
  USAGE_FEATURES.memoryDream,
  USAGE_FEATURES.memoryExtraction,
  USAGE_FEATURES.memoryDiscovery,
  USAGE_FEATURES.skillsEvolution,
];

export type BatchLaneDecision = { batch: boolean; maxWaitMinutes: number };

/** `memory.batch.{enabled,lanes,maxWaitMinutes}` applied to a feature id. */
export function resolveBatchLane(
  cfg: BitterbotConfig | undefined,
  feature: string,
): BatchLaneDecision {
  const raw = (
    cfg as
      | { memory?: { batch?: { enabled?: boolean; lanes?: string[]; maxWaitMinutes?: number } } }
      | undefined
  )?.memory?.batch;
  const maxWaitMinutes =
    typeof raw?.maxWaitMinutes === "number" &&
    Number.isFinite(raw.maxWaitMinutes) &&
    raw.maxWaitMinutes > 0
      ? raw.maxWaitMinutes
      : ANTHROPIC_BATCH_DEFAULT_MAX_WAIT_MINUTES;
  if (raw?.enabled === false) {
    return { batch: false, maxWaitMinutes };
  }
  const lanes = Array.isArray(raw?.lanes) ? raw.lanes : DEFAULT_BATCH_LANES;
  return { batch: lanes.includes(feature), maxWaitMinutes };
}

/**
 * Text-only pi-ai messages become Messages-API params; anything else (images, tool results)
 * is not batchable and takes the live path.
 */
export function toBatchParams(
  messages: Message[],
  modelId: string,
  maxTokens: number,
): AnthropicBatchMessageParams | null {
  const out: AnthropicBatchMessageParams["messages"] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      return null;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: AnthropicBatchTextBlock[] = [];
    for (const block of m.content as Array<{ type: string; text?: string }>) {
      if (block.type !== "text" || typeof block.text !== "string") {
        return null;
      }
      blocks.push({ type: "text", text: block.text });
    }
    if (blocks.length === 0) {
      return null;
    }
    out.push({ role: m.role, content: blocks });
  }
  if (out.length === 0 || out[0]!.role !== "user") {
    return null;
  }
  return { model: modelId, max_tokens: maxTokens, messages: out };
}

export type CompleteAttributedParams = {
  provider: string;
  modelId: string;
  cfg?: BitterbotConfig;
  agentDir?: string;
  /** Either a full message list or a single user prompt. */
  messages?: Message[];
  prompt?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ledger attribution, e.g. "memory/dream". */
  feature: string;
  kind?: UsageKind;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  /** Prefix for the thrown error on provider failure. Defaults to the feature. */
  errorPrefix?: string;
  /** Skip the background-budget gate (user-facing callers). Default: gate applies to background features only. */
  ignoreBudget?: boolean;
  /** Throw a "missing API key" error up front instead of letting the provider reject the call. */
  requireApiKey?: boolean;
  /**
   * Route through the Anthropic Message Batches API (50% price) and fall back to the live
   * call on timeout or error. Only honored for anthropic/anthropic-messages models with an
   * API key (not OAuth) and text-only messages. Default: `resolveBatchLane(cfg, feature)`.
   */
  batch?: boolean;
  /** Wall-clock cap for the batch before falling back live. Default `memory.batch.maxWaitMinutes` (20). */
  batchMaxWaitMinutes?: number;
};

export type CompleteAttributedResult = {
  text: string;
  message: AssistantMessage;
  /** USD cost as reported by the model library, 0 when unknown. */
  costUsd: number;
  /** True when the answer came back through the Message Batches API. */
  batched?: boolean;
};

export class UsageBudgetPausedError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(
      `usage budget exceeded; background lane "${feature}" is paused until the budget window resets`,
    );
    this.name = "UsageBudgetPausedError";
    this.feature = feature;
  }
}

export function extractAssistantText(message: AssistantMessage): string {
  return (
    message.content
      ?.filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("\n") ?? ""
  );
}

export async function completeAttributed(
  params: CompleteAttributedParams,
): Promise<CompleteAttributedResult> {
  if (!params.ignoreBudget) {
    const paused = isBackgroundUsagePaused({
      ledger: getUsageLedger(),
      cfg: params.cfg,
      feature: params.feature,
    });
    if (paused) {
      throw new UsageBudgetPausedError(params.feature);
    }
  }

  const [{ completeSimple }, { resolveModel }, modelAuth, { resolveCacheTtlLabel }] =
    await Promise.all([
      import("@mariozechner/pi-ai"),
      import("./pi-embedded-runner/model.js"),
      import("./model-auth.js"),
      import("./pi-embedded-runner/extra-params.js"),
    ]);

  const resolved = resolveModel(params.provider, params.modelId, params.agentDir, params.cfg);
  if (!resolved.model) {
    throw new Error(
      `${params.errorPrefix ?? params.feature}: cannot resolve model ${params.provider}/${params.modelId}` +
        (resolved.error ? ` (${resolved.error})` : ""),
    );
  }
  const auth = await modelAuth.getApiKeyForModel({
    model: resolved.model,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  // Only touch requireApiKey when asked: test doubles of model-auth may not define it.
  const apiKey = params.requireApiKey
    ? modelAuth.requireApiKey(auth, params.provider)
    : auth?.apiKey;

  const messages: Message[] =
    params.messages ??
    ([{ role: "user", content: params.prompt ?? "", timestamp: Date.now() }] as Message[]);

  // Latency-tolerant lanes: try the Message Batches API first; any failure falls through to
  // the live call below so no lane ever stalls on the batch queue.
  const laneDecision = resolveBatchLane(params.cfg, params.feature);
  const wantBatch = params.batch ?? laneDecision.batch;
  const providerName = (resolved.model.provider ?? params.provider).toLowerCase();
  if (
    wantBatch &&
    providerName === "anthropic" &&
    resolved.model.api === "anthropic-messages" &&
    apiKey &&
    auth?.mode !== "oauth" &&
    !isBatchTemporarilyUnsupported(resolved.model.baseUrl)
  ) {
    const request = toBatchParams(messages, resolved.model.id, params.maxTokens ?? 2048);
    if (request) {
      const batchStartedAt = Date.now();
      const outcome = await runAnthropicBatchCall({
        apiKey,
        baseUrl: resolved.model.baseUrl,
        request,
        maxWaitMs: (params.batchMaxWaitMinutes ?? laneDecision.maxWaitMinutes) * 60_000,
        signal: params.signal,
        headers: resolved.model.headers,
        customId: `${params.feature}-${params.runId ?? ""}`,
      });
      if (outcome.ok) {
        const buckets = batchUsageToBuckets(outcome.message.usage);
        const text = (outcome.message.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text ?? "")
          .join("\n");
        const stopReason = batchStopReason(outcome.message.stop_reason);
        const message = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: outcome.message.model ?? resolved.model.id,
          usage: {
            input: buckets.input,
            output: buckets.output,
            cacheRead: buckets.cacheRead,
            cacheWrite: buckets.cacheWrite,
            totalTokens: buckets.totalTokens,
            // No library price for batch rows: the ledger prices them from the table at 50%.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason,
          timestamp: Date.now(),
        } as AssistantMessage;
        recordUsage({
          kind: params.kind ?? "chat",
          feature: params.feature,
          provider: "anthropic",
          model: message.model,
          api: "anthropic-messages",
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          taskId: params.taskId,
          usage: message.usage,
          durationMs: Date.now() - batchStartedAt,
          status: stopReason === "error" ? "error" : "ok",
          stopReason,
          batch: true,
          cacheWrite5m: buckets.cacheWrite5m,
          cacheWrite1h: buckets.cacheWrite1h,
          cacheTtl: buckets.cacheWrite1h ? "1h" : buckets.cacheWrite5m ? "5m" : undefined,
          config: params.cfg,
        });
        log.debug(
          `batch ok feature=${params.feature} batch=${outcome.batchId} waited=${Math.round(outcome.waitedMs / 1000)}s polls=${outcome.polls}`,
        );
        return { text, message, costUsd: 0, batched: true };
      }
      log.info(
        `batch fallback to live: feature=${params.feature} reason=${outcome.reason}${outcome.error ? ` (${outcome.error})` : ""}${outcome.batchId ? ` batch=${outcome.batchId}` : ""}${outcome.canceled ? " canceled" : ""} after ${Math.round(outcome.waitedMs / 1000)}s`,
      );
      if (params.signal?.aborted) {
        throw new Error(`${params.errorPrefix ?? params.feature}: aborted`);
      }
    }
  }

  const startedAt = Date.now();
  const message = await completeSimple(
    resolved.model,
    { messages },
    {
      apiKey,
      maxTokens: params.maxTokens ?? 2048,
      // No sampling params: current Anthropic models 400 on temperature, and completeSimple
      // embeds that error in the response instead of throwing.
      signal: params.signal,
    },
  );

  const failure = message as { stopReason?: string; errorMessage?: string };
  // pi-ai does not surface Anthropic's per-TTL cache_creation split, so the TTL on the row is the
  // configured retention for this model (what the request asked for); 1h writes are priced at 2x.
  let cacheTtl: "5m" | "1h" | "none" | undefined;
  try {
    cacheTtl = resolveCacheTtlLabel({
      cfg: params.cfg,
      provider: message.provider ?? params.provider,
      modelId: message.model ?? params.modelId,
      baseUrl: typeof resolved.model.baseUrl === "string" ? resolved.model.baseUrl : undefined,
    });
  } catch {
    cacheTtl = undefined;
  }
  recordUsage({
    kind: params.kind ?? "chat",
    feature: params.feature,
    provider: message.provider ?? params.provider,
    model: message.model ?? params.modelId,
    api: message.api,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    taskId: params.taskId,
    usage: message.usage,
    cost: message.usage?.cost,
    durationMs: Date.now() - startedAt,
    status: failure.stopReason === "error" ? "error" : "ok",
    stopReason: failure.stopReason,
    cacheTtl,
    config: params.cfg,
  });

  if (failure.stopReason === "error") {
    throw new Error(
      `${params.errorPrefix ?? params.feature}: provider error: ${failure.errorMessage ?? "unknown"}`,
    );
  }

  return { text: extractAssistantText(message), message, costUsd: message.usage?.cost?.total ?? 0 };
}
