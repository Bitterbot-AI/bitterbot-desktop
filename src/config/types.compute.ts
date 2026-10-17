/**
 * PLAN-57: compute awareness. Phase 0 carries one key; later phases add
 * `awareness.*`, `embeddings.*`, `pools.*` and `paid.*` as they land, each
 * in the same release as the code that reads it.
 */
export type ComputeConfig = {
  /**
   * Master switch for the agent-facing compute surface: the `compute` tool
   * and its system-prompt section. Default on. Nothing renders unless a
   * compute backend (the Soapbox plugin) is also loaded, so an install
   * without a pool spends no tokens on it either way.
   */
  enabled?: boolean;
};
