/**
 * RLM Deep Recall — Recursive Language Model for infinite context.
 * Based on: "Recursive Language Models" (Zhang, Kraska, Khattab, 2026)
 * Paper: https://arxiv.org/abs/2512.24601
 * Reference implementations: alexzhang13/rlm (Python), hampton-io/RLM (TypeScript)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type RLMConfig = {
  /** Enable RLM deep recall. Default: true. */
  enabled?: boolean;
  /** Sub-model for recursive calls. "auto" picks cheapest available. */
  subModel?: string;
  /** Max REPL loop iterations. Default: 15. */
  maxIterations?: number;
  /** Max recursion depth (1 = sub-calls are plain LLMs). Default: 1. */
  maxDepth?: number;
  /** Max cost in USD per invocation. Default: 0.50. */
  maxBudget?: number;
  /** Max recursive sub-LLM calls. Default: 20. */
  maxSubCalls?: number;
  /** Per code-block timeout (ms). Default: 30000. */
  sandboxTimeout?: number;
  /** Max tokens to load into context. Default: 500000. */
  maxContextTokens?: number;
  /** Default scope for context building. Default: "recent_sessions". */
  defaultScope?: RLMScope;
};

export const DEFAULT_RLM_CONFIG: Required<RLMConfig> = {
  enabled: true,
  subModel: "auto",
  maxIterations: 15,
  maxDepth: 1,
  maxBudget: 0.5,
  maxSubCalls: 20,
  sandboxTimeout: 30_000,
  maxContextTokens: 500_000,
  defaultScope: "recent_sessions",
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type RLMScope = "current_session" | "recent_sessions" | "all_sessions";

export type RLMExecutorOptions = {
  /** Root LLM model ID (the agent's current model). */
  model: string;
  /** Provider for the root model. */
  provider: string;
  /** Sub-LLM model ID for recursive calls (cheap model). */
  subModel: string;
  /** Provider for the sub-model. */
  subProvider: string;
  /** Max REPL iterations. */
  maxIterations: number;
  /** Max recursion depth. */
  maxDepth: number;
  /** Max cost in USD. */
  maxBudget: number;
  /** Max recursive sub-calls. */
  maxSubCalls: number;
  /** Per code-block timeout ms. */
  timeout: number;
};

export type RLMResult = {
  /** The final answer, or null if none was produced. */
  answer: string | null;
  /** Whether the execution completed successfully. */
  success: boolean;
  /** Number of REPL iterations executed. */
  iterations: number;
  /** Number of sub-LLM calls made. */
  subCalls: number;
  /** Total cost in USD. */
  cost: number;
  /** Execution trace for debugging. */
  trace: RLMTraceEntry[];
  /** If a limit was hit, which one. */
  limitReached?: "iterations" | "budget" | "sub_calls" | "timeout";
  /** Error message if execution failed. */
  error?: string;
};

export type RLMTraceEntry = {
  type: "code" | "output" | "llm_response" | "sub_call" | "error" | "final";
  content: string;
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type SandboxExecutionResult = {
  output: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Context Building
// ---------------------------------------------------------------------------

export type ContextBuildParams = {
  /** Specific session key to search. */
  sessionKey?: string;
  /** Search all indexed sessions. */
  allSessions?: boolean;
  /** Include knowledge crystals. */
  includeMemory?: boolean;
  /** Time range filter (epoch ms). */
  timeRange?: { from: number; to: number };
  /** Budget for context size in tokens (~4 chars/token). */
  maxTokens?: number;
};

// ---------------------------------------------------------------------------
// LLM Interface (used by executor to call sub-models)
// ---------------------------------------------------------------------------

export type RLMLLMCallFn = (params: {
  messages: RLMMessage[];
  model: string;
  provider: string;
  maxTokens?: number;
}) => Promise<{ text: string; cost: number }>;

export type RLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
