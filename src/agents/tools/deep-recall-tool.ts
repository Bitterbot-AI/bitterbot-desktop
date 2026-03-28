/**
 * deep_recall — Agent tool for RLM-powered infinite recall.
 *
 * Uses a Recursive Language Model approach to search and reason over the agent's
 * full conversation history and memory by letting a sub-LLM write code to
 * programmatically explore the context.
 *
 * Based on: "Recursive Language Models" (Zhang, Kraska, Khattab, 2026)
 * Paper: https://arxiv.org/abs/2512.24601
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId, resolveAgentModelPrimary } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { RLMExecutor } from "../rlm/executor.js";
import { buildDeepRecallContext } from "../rlm/context-builder.js";
import { DEFAULT_RLM_CONFIG } from "../rlm/types.js";
import type { RLMScope, RLMMessage, RLMLLMCallFn } from "../rlm/types.js";

const DeepRecallSchema = Type.Object({
  query: Type.String({
    description: "What you're looking for or trying to figure out. Be specific.",
  }),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("current_session"),
      Type.Literal("recent_sessions"),
      Type.Literal("all_sessions"),
    ], {
      description: "How far back to search. Default: recent_sessions.",
    }),
  ),
  include_memory: Type.Optional(
    Type.Boolean({
      description: "Whether to include knowledge crystals in the search context. Default: true.",
    }),
  ),
});

/** Cheap sub-model preferences by provider. */
const CHEAP_SUB_MODELS: Record<string, { provider: string; model: string }> = {
  openai: { provider: "openai", model: "gpt-4o-mini" },
  anthropic: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  google: { provider: "google", model: "gemini-2.0-flash-lite" },
};

/**
 * Resolve the cheapest available sub-model for RLM recursive calls.
 * Checks what API keys are available and picks the cheapest model.
 */
async function resolveSubModel(
  cfg: BitterbotConfig | undefined,
  configuredSubModel: string,
): Promise<{ provider: string; model: string } | null> {
  if (configuredSubModel && configuredSubModel !== "auto") {
    const parts = configuredSubModel.split("/");
    if (parts.length >= 2) {
      return { provider: parts[0]!, model: parts.slice(1).join("/") };
    }
  }

  // Auto-detect: try providers in cost order
  try {
    const { discoverAuthStorage } = await import("../pi-model-discovery.js");
    const { resolveBitterbotAgentDir } = await import("../agent-paths.js");
    const agentDir = resolveBitterbotAgentDir();
    const authStorage = discoverAuthStorage(agentDir);

    // Check available providers
    for (const [providerId, subModel] of Object.entries(CHEAP_SUB_MODELS)) {
      const providers = authStorage.list?.() ?? [];
      const hasProvider =
        providers.includes(providerId) ||
        process.env[`${providerId.toUpperCase()}_API_KEY`] ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.GOOGLE_API_KEY;
      if (hasProvider) {
        return subModel;
      }
    }
  } catch {
    // Fallback
  }

  // Last resort: try OpenAI (most common)
  if (process.env.OPENAI_API_KEY) return CHEAP_SUB_MODELS.openai!;
  if (process.env.ANTHROPIC_API_KEY) return CHEAP_SUB_MODELS.anthropic!;
  if (process.env.GOOGLE_API_KEY) return CHEAP_SUB_MODELS.google!;

  return null;
}

/**
 * Build the LLM call function that the RLM executor uses for root and sub-calls.
 */
function buildLlmCallFn(cfg: BitterbotConfig | undefined): RLMLLMCallFn {
  return async (params) => {
    const { completeSimple } = await import("@mariozechner/pi-ai");
    const { resolveModel } = await import("../pi-embedded-runner/model.js");
    const { getApiKeyForModel } = await import("../model-auth.js");

    const resolved = resolveModel(params.provider, params.model, undefined, cfg);
    if (!resolved.model) {
      throw new Error(`Cannot resolve model: ${params.provider}/${params.model}`);
    }

    const auth = await getApiKeyForModel({ model: resolved.model, cfg });

    const messages = params.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
      timestamp: Date.now(),
    })) as unknown as import("@mariozechner/pi-ai").Message[];

    const res = await completeSimple(
      resolved.model,
      { messages },
      {
        apiKey: auth?.apiKey,
        maxTokens: params.maxTokens ?? 4000,
        temperature: 0.3,
      },
    );

    const text =
      res.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text?: string }) => b.text ?? "")
        .join("\n") ?? "";

    // Estimate cost from usage if available
    const cost = res.usage?.cost?.total ?? 0;

    return { text, cost };
  };
}

export function createDeepRecallTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  // Check if memory is configured (deep recall needs session access)
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;

  // Check if RLM is enabled
  const rlmCfg = cfg.memory?.rlm;
  if (rlmCfg?.enabled === false) return null;

  return {
    label: "Deep Recall",
    name: "deep_recall",
    description:
      "Search and reason over your full conversation history and memory using code execution. " +
      "Use when memory_search doesn't find what you need, or when you need to reason over many " +
      "messages at once. Loads history into a sandboxed environment where a sub-LLM writes code " +
      "to search, filter, and analyze it programmatically.",
    parameters: DeepRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const scope = (readStringParam(params, "scope") as RLMScope | undefined) ??
        rlmCfg?.defaultScope ??
        DEFAULT_RLM_CONFIG.defaultScope;
      const includeMemory = typeof params.include_memory === "boolean"
        ? params.include_memory
        : true;

      // Step 1: Quick memory_search first — if high-confidence results, skip RLM
      const { manager } = await getMemorySearchManager({ cfg, agentId });
      if (manager) {
        try {
          const quickResults = await manager.search(query, { maxResults: 5 });
          // Only shortcut if we have 3+ genuinely high-confidence results.
          // manager.search may ignore minScore (e.g. RRF strategy), so filter here.
          const highConfidence = quickResults.filter((r) => r.score >= 0.8);
          if (highConfidence.length >= 3) {
            return jsonResult({
              source: "memory_search_shortcut",
              note: "High-confidence results found via memory_search; RLM not needed.",
              results: highConfidence.map((r) => ({
                snippet: r.snippet,
                score: r.score,
                path: r.path,
                source: r.source,
              })),
            });
          }
        } catch {
          // Continue to RLM
        }
      }

      // Step 2: Resolve sub-model
      const subModelRef = await resolveSubModel(cfg, rlmCfg?.subModel ?? "auto");
      if (!subModelRef) {
        return jsonResult({
          error: "No suitable sub-model available for deep recall. Configure an API key for OpenAI, Anthropic, or Google.",
        });
      }

      // Step 3: Build context
      const maxTokens = rlmCfg?.maxContextTokens ?? DEFAULT_RLM_CONFIG.maxContextTokens;
      const context = await buildDeepRecallContext({
        agentId,
        scope,
        sessionKey: options.agentSessionKey,
        includeMemory,
        maxTokens,
        memoryManager: manager,
      });

      if (context.length < 50) {
        return jsonResult({
          error: "No session history or memory found to search.",
        });
      }

      // Step 4: Execute RLM
      // Root model = agent's current model (writes the exploration code)
      // Sub-model = cheapest available (answers recursive sub-queries)
      const rootModelSpec = resolveAgentModelPrimary(cfg, agentId);
      let rootProvider = DEFAULT_PROVIDER;
      let rootModel = DEFAULT_MODEL;
      if (rootModelSpec) {
        const parts = rootModelSpec.split("/");
        if (parts.length >= 2) {
          rootProvider = parts[0]!;
          rootModel = parts.slice(1).join("/");
        } else {
          rootModel = rootModelSpec;
        }
      }

      const llmCall = buildLlmCallFn(cfg);
      const executor = new RLMExecutor(llmCall);

      const result = await executor.execute(query, context, {
        model: rootModel,
        provider: rootProvider,
        subModel: subModelRef.model,
        subProvider: subModelRef.provider,
        maxIterations: rlmCfg?.maxIterations ?? DEFAULT_RLM_CONFIG.maxIterations,
        maxDepth: rlmCfg?.maxDepth ?? DEFAULT_RLM_CONFIG.maxDepth,
        maxBudget: rlmCfg?.maxBudget ?? DEFAULT_RLM_CONFIG.maxBudget,
        maxSubCalls: rlmCfg?.maxSubCalls ?? DEFAULT_RLM_CONFIG.maxSubCalls,
        timeout: rlmCfg?.sandboxTimeout ?? DEFAULT_RLM_CONFIG.sandboxTimeout,
      });

      // Step 5: Trigger hormonal event based on result
      if (manager) {
        try {
          const memManager = manager as any;
          if (memManager.hormonalManager) {
            if (result.success && result.answer) {
              memManager.hormonalManager.stimulate("reward");
            } else if (!result.success) {
              memManager.hormonalManager.stimulate("error");
            }
          }
        } catch {
          // Non-critical
        }
      }

      return jsonResult({
        answer: result.answer,
        success: result.success,
        iterations: result.iterations,
        subCalls: result.subCalls,
        cost: `$${result.cost.toFixed(4)}`,
        limitReached: result.limitReached ?? null,
        error: result.error ?? null,
        contextSize: {
          chars: context.length,
          estimatedTokens: Math.ceil(context.length / 4),
        },
      });
    },
  };
}
