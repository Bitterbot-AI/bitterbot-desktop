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
import { isBackgroundUsagePaused } from "../infra/usage-budgets.js";
import { getUsageLedger, recordUsage } from "../infra/usage-ledger.js";

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
};

export type CompleteAttributedResult = {
  text: string;
  message: AssistantMessage;
  /** USD cost as reported by the model library, 0 when unknown. */
  costUsd: number;
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
