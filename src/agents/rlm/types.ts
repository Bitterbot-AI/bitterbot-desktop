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
  /**
   * Max recursion depth. 1 = sub-calls are plain LLM completions;
   * 2 = sub-calls run their own mini-REPL whose sub-calls are plain LLMs.
   * Capped at 3. Default: 1.
   */
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
  /**
   * PLAN-52A continuity profile: tighter limits applied when the scope is
   * `current_session` (the agent reaching back into its own offloaded
   * context on the user's critical path). Depth is always 1 for this scope.
   */
  continuity?: RLMContinuityConfig;
};

export type RLMContinuityConfig = {
  /** Max REPL iterations. Default: 8. */
  maxIterations?: number;
  /** Max recursive sub-LLM calls. Default: 8. */
  maxSubCalls?: number;
  /** Max cost in USD per invocation. Default: 0.15. */
  maxBudget?: number;
  /** Wall-clock cap for the whole invocation (ms). Default: 45000. */
  wallClockMs?: number;
};

export const DEFAULT_RLM_CONTINUITY: Required<RLMContinuityConfig> = {
  maxIterations: 8,
  maxSubCalls: 8,
  maxBudget: 0.15,
  wallClockMs: 45_000,
};

export const DEFAULT_RLM_CONFIG: Required<Omit<RLMConfig, "continuity">> & {
  continuity: Required<RLMContinuityConfig>;
} = {
  enabled: true,
  subModel: "auto",
  maxIterations: 15,
  maxDepth: 1,
  maxBudget: 0.5,
  maxSubCalls: 20,
  sandboxTimeout: 30_000,
  maxContextTokens: 500_000,
  defaultScope: "recent_sessions",
  continuity: DEFAULT_RLM_CONTINUITY,
};

/**
 * Restrict a transcript snapshot to a slice of one session. Entry ids are the
 * pi v3 `message` entry ids; lines are 1-based JSONL line numbers (the same
 * addressing the memory index uses in `chunks.start_line`). Either bound may
 * be omitted. Shared with the compaction ledger and `recall_range`.
 */
export type TranscriptRange = {
  fromEntryId?: string;
  toEntryId?: string;
  fromLine?: number;
  toLine?: number;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type RLMScope = "current_session" | "recent_sessions" | "all_sessions";

// ---------------------------------------------------------------------------
// Live environment APIs (state-outside-the-snapshot)
// ---------------------------------------------------------------------------

/**
 * Live, read-only data-access callbacks injected into the sandbox so the
 * REPL can reach beyond the bootstrap `context` snapshot. All host-side;
 * the sandbox only ever sees the async function wrappers.
 */
export type RLMLiveApis = {
  /** Hybrid memory search over crystals and indexed sessions. */
  search?: (
    query: string,
    opts?: { maxResults?: number },
  ) => Promise<Array<{ snippet: string; score: number; path?: string; source?: string }>>;
  /** Load a full session transcript as formatted text ("[ts] ROLE: text" lines). */
  loadTranscript?: (sessionId: string) => Promise<string | null>;
  /** List available session transcripts, newest first. */
  listSessions?: () => Promise<Array<{ sessionId: string; modifiedAt: string }>>;
};

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
  /**
   * Wall-clock cap for the whole run (ms). Checked between steps and raced
   * against every root call, so a slow provider cannot hold the user's turn
   * open indefinitely (the paper's p95 tail). Unset = no cap.
   */
  wallClockMs?: number;
  /** Live data-access APIs to inject into the sandbox. */
  liveApis?: RLMLiveApis;
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
  /** Exact session id (transcript file stem) for `current_session`. */
  sessionId?: string;
  /** Search all indexed sessions. */
  allSessions?: boolean;
  /** Include knowledge crystals. */
  includeMemory?: boolean;
  /** Include tool results (truncated) in the transcript section. */
  includeToolResults?: boolean;
  /** Restrict the snapshot to a slice of the session (entry ids or JSONL lines). */
  range?: TranscriptRange;
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
