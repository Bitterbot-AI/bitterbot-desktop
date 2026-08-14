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
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import type { MemorySearchManager } from "../../memory/types.js";
import type { RLMScope, RLMLLMCallFn, RLMLiveApis } from "../rlm/types.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId, resolveAgentModelPrimary } from "../agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import {
  buildDeepRecallContext,
  listSessionSummaries,
  loadTranscriptText,
} from "../rlm/context-builder.js";
import { RLMExecutor } from "../rlm/executor.js";
import { RLMSandbox } from "../rlm/sandbox.js";
import { DEFAULT_RLM_CONFIG } from "../rlm/types.js";
import { jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Session-persistent sandboxes (state survives across deep_recall calls)
// ---------------------------------------------------------------------------

type SessionSandboxEntry = {
  sandbox: RLMSandbox;
  context: string;
  builtAt: number;
  storePath: string;
  /** True while an executor run holds this sandbox (overlap falls back to an owned sandbox). */
  busy: boolean;
};

/** Sandbox reused across deep_recall calls within the same session+scope. */
const sessionSandboxes = new Map<string, SessionSandboxEntry>();
/** Rebuild the context snapshot after this long (live APIs cover the gap). */
const SANDBOX_CONTEXT_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_SANDBOXES = 8;

function sandboxCacheKey(agentId: string, sessionKey: string | undefined, scope: string): string {
  return `${agentId}:${sessionKey ?? "global"}:${scope}`;
}

/**
 * Durable store path. Deliberately scope-INDEPENDENT (unlike the sandbox
 * cache key): findings stored while exploring one scope must survive into
 * queries at another, or continuity fragments across scopes. Exported for
 * tests.
 */
export function resolveStorePath(
  agentDir: string,
  agentId: string,
  sessionKey: string | undefined,
): string {
  const key = `${agentId}:${sessionKey ?? "global"}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(agentDir, "rlm-store", `${hash}.json`);
}

const LIMIT_REASONS: Record<string, string> = {
  iterations: "it ran out of iterations",
  budget: "it ran out of budget",
  sub_calls: "it ran out of sub-calls",
  timeout: "it timed out",
};

/**
 * A run that did NOT finish must never read as if it did.
 *
 * On a cap the executor returns the last REPL output as `answer` (executor.ts:
 * "Iteration limit reached"), and that scrap is usually the model narrating its
 * own intent. A live continuity probe came back with
 * `"continuity_token = violet-owl-42 Task: store marker + confirm — COMPLETE.
 * FINAL already called."` alongside `success: false, limitReached: "iterations"`
 * — nothing had been stored, but the sentence said COMPLETE, so the agent
 * reported success to the operator and the real defect was filed as a curiosity
 * gap instead of a bug. Prose beats a boolean every time, so the prose has to
 * carry the failure. (2026-08-13)
 */
export function annotateIncompleteAnswer(
  answer: string | null,
  success: boolean,
  limitReached?: string | null,
): string | null {
  if (success && !limitReached) {
    return answer;
  }
  const why = limitReached
    ? (LIMIT_REASONS[limitReached] ?? `limit: ${limitReached}`)
    : "it failed";
  const banner =
    `[INCOMPLETE — this run did not finish because ${why}. ` +
    `Anything below claiming a task is done is the model's own unverified narration, ` +
    `NOT a confirmed outcome. Do not report it as done; re-run or verify directly.]`;
  return answer ? `${banner}\n\n${answer}` : banner;
}

async function loadPersistedStore(storePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt store file — start fresh
  }
  return null;
}

async function persistStore(storePath: string, data: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(data), "utf-8");
  } catch {
    // Durability is best-effort; the in-memory store still works
  }
}

function evictStaleSandboxes(): void {
  if (sessionSandboxes.size <= MAX_CACHED_SANDBOXES) {
    return;
  }
  const entries = [...sessionSandboxes.entries()].toSorted((a, b) => a[1].builtAt - b[1].builtAt);
  while (sessionSandboxes.size > MAX_CACHED_SANDBOXES && entries.length > 0) {
    const [key, entry] = entries.shift()!;
    entry.sandbox.dispose();
    sessionSandboxes.delete(key);
  }
}

/** Test hook: clear the sandbox cache. */
export function clearDeepRecallSandboxCache(): void {
  for (const entry of sessionSandboxes.values()) {
    entry.sandbox.dispose();
  }
  sessionSandboxes.clear();
}

const DeepRecallSchema = Type.Object({
  query: Type.String({
    description: "What you're looking for or trying to figure out. Be specific.",
  }),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("current_session"),
        Type.Literal("recent_sessions"),
        Type.Literal("all_sessions"),
      ],
      {
        description: "How far back to search. Default: recent_sessions.",
      },
    ),
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
  if (process.env.OPENAI_API_KEY) {
    return CHEAP_SUB_MODELS.openai!;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return CHEAP_SUB_MODELS.anthropic!;
  }
  if (process.env.GOOGLE_API_KEY) {
    return CHEAP_SUB_MODELS.google!;
  }

  return null;
}

/**
 * Map RLM messages to pi-ai's wire shape. pi-ai requires assistant message
 * content as content-block ARRAYS (providers flatMap over them); string
 * content crashes with "assistantMsg.content.flatMap is not a function" on
 * the second REPL iteration. Exported for tests.
 */
export function toPiMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Array<{ role: string; content: string | Array<{ type: "text"; text: string }> }> {
  return messages.map((m) =>
    m.role === "assistant"
      ? {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: m.content }],
          timestamp: Date.now(),
        }
      : {
          role: m.role,
          content: m.content,
          timestamp: Date.now(),
        },
  );
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

    const messages = toPiMessages(
      params.messages,
    ) as unknown as import("@mariozechner/pi-ai").Message[];

    const res = await completeSimple(
      resolved.model,
      { messages },
      {
        apiKey: auth?.apiKey,
        maxTokens: params.maxTokens ?? 4000,
        // No sampling params: current Anthropic models 400 on temperature,
        // and completeSimple embeds that error instead of throwing.
      },
    );
    const failure = res as { stopReason?: string; errorMessage?: string };
    if (failure.stopReason === "error") {
      throw new Error(`deep-recall llm error: ${failure.errorMessage ?? "unknown"}`);
    }

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
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  // Check if memory is configured (deep recall needs session access)
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }

  // Check if RLM is enabled
  const rlmCfg = cfg.memory?.rlm;
  if (rlmCfg?.enabled === false) {
    return null;
  }

  // The 1h query-result cache is class-level (tool instances are rebuilt per
  // agent turn); namespace it by agent+session so answers never cross agents.
  const llmCall = buildLlmCallFn(cfg);
  const executor = new RLMExecutor(llmCall, `${agentId}:${options.agentSessionKey ?? "global"}`);

  return {
    label: "Deep Recall",
    name: "deep_recall",
    description:
      "Search and reason over your full conversation history and memory using code execution. " +
      "Use when memory_search doesn't find what you need, or when you need to reason over many " +
      "messages at once. Loads history into a sandboxed environment where a sub-LLM writes code " +
      "to search, filter, and analyze it programmatically. The sandbox REPL exposes store(name, " +
      "value) / get(name) / has(name) — a durable key-value store persisted per session across " +
      "calls (it survives restarts) — and FINAL(answer) to finish. Your query is the sub-LLM's " +
      "instructions, so it CAN direct store()/get() usage; storing intermediate findings across " +
      "calls is a legitimate pattern. A result with success=false or a limitReached value did " +
      "NOT complete, whatever its answer text claims — treat any completion claim in it as " +
      "unverified.",
    parameters: DeepRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const scope =
        (readStringParam(params, "scope") as RLMScope | undefined) ??
        rlmCfg?.defaultScope ??
        DEFAULT_RLM_CONFIG.defaultScope;
      const includeMemory =
        typeof params.include_memory === "boolean" ? params.include_memory : true;

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
          error:
            "No suitable sub-model available for deep recall. Configure an API key for OpenAI, Anthropic, or Google.",
        });
      }

      // Step 3: Live data-access APIs — the context snapshot below is only a
      // bootstrap; these let the REPL reach the full live history beyond it.
      const liveApis: RLMLiveApis = {
        loadTranscript: (sessionId) => loadTranscriptText(agentId, sessionId),
        listSessions: () => listSessionSummaries(agentId),
      };
      if (manager) {
        const mgr = manager;
        liveApis.search = async (q, opts) => {
          const results = await mgr.search(q, { maxResults: opts?.maxResults ?? 10 });
          return results.map((r) => ({
            snippet: r.snippet,
            score: r.score,
            path: r.path,
            source: r.source,
          }));
        };
      }

      // Step 3b: Session-persistent sandbox — reuse REPL state (stored
      // variables, prior findings) across deep_recall calls in this session.
      const cacheKey = sandboxCacheKey(agentId, options.agentSessionKey, scope);
      const maxTokens = rlmCfg?.maxContextTokens ?? DEFAULT_RLM_CONFIG.maxContextTokens;
      let entry = sessionSandboxes.get(cacheKey);
      let context: string;
      if (entry && Date.now() - entry.builtAt <= SANDBOX_CONTEXT_TTL_MS) {
        context = entry.context;
      } else {
        context = await buildDeepRecallContext({
          agentId,
          scope,
          sessionKey: options.agentSessionKey,
          includeMemory,
          maxTokens,
          memoryManager: manager,
        });
        if (context.length < 50 && !entry) {
          return jsonResult({
            error: "No session history or memory found to search.",
          });
        }
        if (entry) {
          // Refresh the stale snapshot but keep the accumulated store
          entry.sandbox.updateContext(context);
          entry.context = context;
          entry.builtAt = Date.now();
        } else {
          let storePath = "";
          try {
            const { resolveBitterbotAgentDir } = await import("../agent-paths.js");
            storePath = resolveStorePath(
              resolveBitterbotAgentDir(),
              agentId,
              options.agentSessionKey,
            );
          } catch {
            // No durable store path — session-only persistence
          }
          const sandbox = new RLMSandbox({
            context,
            timeout: rlmCfg?.sandboxTimeout ?? DEFAULT_RLM_CONFIG.sandboxTimeout,
            liveApis,
            onLLMQuery: async () => "[llm handlers not bound]",
          });
          if (storePath) {
            const persisted = await loadPersistedStore(storePath);
            if (persisted) {
              sandbox.importStore(persisted);
            }
          }
          entry = { sandbox, context, builtAt: Date.now(), storePath, busy: false };
          sessionSandboxes.set(cacheKey, entry);
          evictStaleSandboxes();
        }
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

      // PLAN-9 GAP-12: Somatic marker assessment — check emotional signature of knowledge region
      let somaticWarning: string | undefined;
      if (manager) {
        try {
          const { assessSomaticMarkers } = await import("../../memory/somatic-markers.js");
          const memManager = manager as MemorySearchManager & {
            db?: import("node:sqlite").DatabaseSync;
          };
          // Use quick search results as proxy for the knowledge region
          const quickResults = await memManager.search(query, { maxResults: 10 });
          if (quickResults.length >= 3 && memManager.db) {
            const db = memManager.db;
            const chunkIds: string[] = [];
            for (const r of quickResults) {
              try {
                const row = db
                  .prepare(
                    `SELECT id FROM chunks WHERE path = ? AND start_line = ? AND end_line = ?`,
                  )
                  .get(r.path, r.startLine, r.endLine) as { id: string } | undefined;
                if (row) {
                  chunkIds.push(row.id);
                }
              } catch {
                /* non-critical */
              }
            }
            if (chunkIds.length >= 3) {
              const assessment = assessSomaticMarkers(db, chunkIds);
              if (assessment.verdict === "caution" && assessment.message) {
                somaticWarning = assessment.message;
              }
            }
          }
        } catch {
          // Somatic assessment non-critical
        }
      }

      // Plan 7, Phase 8: Check cache first — avoid redundant REPL sessions
      const cached = executor.getCachedResult(query, scope);
      if (cached) {
        return jsonResult({
          answer: cached,
          success: true,
          source: "cache",
          note: "Returned from RLM cache (1h TTL). New session extraction invalidates cache.",
        });
      }

      // Sandboxes are cached per scope but the durable store is shared per
      // agent+session: merge the latest disk state into this sandbox so keys
      // stored under OTHER scopes are visible here (in-memory keys win).
      if (entry.storePath) {
        const persisted = await loadPersistedStore(entry.storePath);
        if (persisted) {
          entry.sandbox.importStore(persisted);
        }
      }

      // Overlapping calls on the same key would corrupt shared REPL state
      // (handler rebinding, FINAL clearing, output interleaving). If the
      // cached sandbox is busy, run on a transient owned sandbox seeded from
      // its store instead.
      const executorOptions = {
        model: rootModel,
        provider: rootProvider,
        subModel: subModelRef.model,
        subProvider: subModelRef.provider,
        maxIterations: rlmCfg?.maxIterations ?? DEFAULT_RLM_CONFIG.maxIterations,
        maxDepth: rlmCfg?.maxDepth ?? DEFAULT_RLM_CONFIG.maxDepth,
        maxBudget: rlmCfg?.maxBudget ?? DEFAULT_RLM_CONFIG.maxBudget,
        maxSubCalls: rlmCfg?.maxSubCalls ?? DEFAULT_RLM_CONFIG.maxSubCalls,
        timeout: rlmCfg?.sandboxTimeout ?? DEFAULT_RLM_CONFIG.sandboxTimeout,
        liveApis,
      };
      let result;
      if (entry.busy) {
        const transient = new RLMSandbox({
          context,
          timeout: executorOptions.timeout,
          liveApis,
          onLLMQuery: async () => "[llm handlers not bound]",
        });
        transient.importStore(entry.sandbox.exportStore());
        try {
          result = await executor.execute(query, context, executorOptions, transient);
        } finally {
          transient.dispose();
        }
      } else {
        entry.busy = true;
        try {
          result = await executor.execute(query, context, executorOptions, entry.sandbox);
        } finally {
          entry.busy = false;
        }
        // Persist the REPL store so accumulated state survives restarts
        if (entry.storePath) {
          // Awaited: back-to-back calls (even in one turn) must read a
          // consistent store — fire-and-forget here raced same-turn readers.
          await persistStore(entry.storePath, entry.sandbox.exportStore());
        }
      }

      // Step 5: Trigger hormonal event based on result + Plan 7 self-improvement
      if (manager) {
        try {
          const memManager = manager as MemorySearchManager & {
            hormonalManager?: { stimulate(event: string): void } | null;
            curiosityEngine?: {
              registerBlindSpot?(params: { query: string; scope: string; timestamp: number }): void;
            } | null;
          };
          if (memManager.hormonalManager) {
            if (result.success && result.answer) {
              memManager.hormonalManager.stimulate("reward");
              // Plan 7, Phase 8: Cache successful result
              executor.cacheResult(query, scope, result.answer);
            } else if (!result.success) {
              memManager.hormonalManager.stimulate("error");
              // Plan 7, Phase 8: Register blind spot as curiosity target
              if (memManager.curiosityEngine?.registerBlindSpot) {
                memManager.curiosityEngine.registerBlindSpot({
                  query,
                  scope,
                  timestamp: Date.now(),
                });
              }
            }
          }
        } catch {
          // Non-critical
        }
      }

      return jsonResult({
        answer: annotateIncompleteAnswer(result.answer, result.success, result.limitReached),
        success: result.success,
        iterations: result.iterations,
        subCalls: result.subCalls,
        cost: `$${result.cost.toFixed(4)}`,
        limitReached: result.limitReached ?? null,
        error: result.error ?? null,
        somaticWarning: somaticWarning ?? null,
        contextSize: {
          chars: context.length,
          estimatedTokens: Math.ceil(context.length / 4),
        },
      });
    },
  };
}
