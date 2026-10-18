/**
 * PLAN-57: compute awareness. Each key lands in the same release as the
 * code that reads it; `local.*` and `paid.*` follow in later phases.
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

/** PLAN-57 §4.6: the owner's trust in a pool decides which memory may reach it. */
export type ComputePoolConfig = {
  /**
   * `trusted`: machines the owner controls or explicitly trusts; may receive
   * `personal` and `normal` content. `untrusted` (default for every pool
   * that is not this machine): `normal` content only. `confidential` content
   * never leaves this machine whatever the pool's trust.
   */
  trust?: "trusted" | "untrusted";
};

export type ComputeEmbeddingsConfig = {
  /**
   * Where memory embedding batches may run (default `pool`): on a pool worker
   * whose pinned model digest, dimensions and processing rules equal the local
   * embedding profile, and only when the egress policy allows the content;
   * otherwise locally. `local` turns pool routing off entirely. Queries always
   * run locally.
   */
  provider?: "pool" | "local";
  /** A pool worker must beat the local estimate by this many ms to be chosen (default 500). */
  marginMs?: number;
  /** How long a worker is skipped after a timeout, mismatch or policy violation (default 300000). */
  cooldownMs?: number;
  /** How long one pool batch may take before it falls back to local (default 60000). */
  timeoutMs?: number;
  /**
   * Override the local embedding model digest used for parity checks. Set it
   * only when the provider cannot report one itself (a remote API) and you
   * know the pool runs the very same weights.
   */
  modelDigest?: string;
};

export type ComputeEgressConfig = {
  /**
   * Governance class given to session transcript chunks that carry no higher
   * tag (default `personal`, so transcripts stay on this machine or trusted
   * pools). `normal` lets them reach untrusted pools; `confidential` keeps
   * them local.
   */
  transcriptsDefaultClass?: "normal" | "personal" | "confidential";
};

/** PLAN-57 §4.8: paid compute. Off for the beta; funding is always the owner's act. */
export type ComputePaidConfig = {
  /**
   * Let the agent submit `paid_usdc` jobs (default off). A submitted paid job
   * waits at `awaiting_payment`; nothing is funded until the owner approves
   * it in the Control UI or with `bitterbot compute approve`. The coordinator
   * must also report paid work as available to this node.
   */
  enabled?: boolean;
  /** Most USDC one job may be funded for (default 5). Larger quotes are refused at the signer. */
  maxUsdcPerJob?: number;
  /** Most USDC compute funding may total in a rolling 24 hours (default 20). */
  maxUsdcPerDay?: number;
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
  /** Per-pool trust, keyed by pool id. The local pool is implicit. */
  pools?: Record<string, ComputePoolConfig>;
  embeddings?: ComputeEmbeddingsConfig;
  egress?: ComputeEgressConfig;
  paid?: ComputePaidConfig;
};
