/**
 * PLAN-57: compute awareness. Each key lands in the same release as the
 * code that reads it; `embeddings.*`, `pools.*` and `paid.*` follow in later
 * phases.
 */
export type ComputeAwarenessConfig = {
  /**
   * Render the `<compute-state>` block in the volatile tail of the system
   * prompt when something is actionable (default: on). Off keeps the tool
   * and the static prompt section; the agent then asks for state explicitly.
   */
  stateBlock?: boolean;
  /** Character budget for the block, as tokens (default 120; about 4 chars per token). */
  maxTokens?: number;
  /** Below this many credits the block says so (default 10). */
  creditFloor?: number;
  /**
   * Compute completions may wake the agent at most this many times per hour
   * (default 20). Beyond it, completions are still queued and the block
   * shows them as waiting; nothing is dropped.
   */
  wakeBudgetPerHour?: number;
};

export type ComputeConfig = {
  /**
   * Master switch for the agent-facing compute surface: the `compute` tool,
   * its system-prompt section and the state block. Default on. Nothing
   * renders unless a compute backend (the Soapbox plugin) is also loaded, so
   * an install without a pool spends no tokens on it either way.
   */
  enabled?: boolean;
  awareness?: ComputeAwarenessConfig;
};
