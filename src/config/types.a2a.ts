export type A2aConfig = {
  /** Enable the A2A protocol server. Default: false. */
  enabled?: boolean;
  /** Human-readable name for this agent node. */
  name?: string;
  /** Description of this agent's capabilities. */
  description?: string;
  /** Public URL for this node (for nodes behind NAT/reverse proxy). */
  url?: string;
  /** Authentication configuration for A2A clients. */
  authentication?: {
    /** Auth scheme. Default: "bearer". */
    type?: "none" | "bearer";
    /** Bearer token for authenticating A2A requests. Falls back to gateway token if unset. */
    bearerToken?: string;
  };
  /**
   * Max `message/send` + `message/stream` task spawns accepted per client
   * per minute (a resource-drain ceiling for publicly-reachable nodes).
   * Default: 12. Set to 0 to disable the check.
   */
  maxTasksPerMinute?: number;
  /** Control which skills are advertised in the Agent Card. */
  skills?: {
    /**
     * Which skills to expose. Default: "none" (PLAN-43 Phase 0: skill
     * advertising is opt-in; setting an allowlist implies exposure of the
     * allowlisted skills).
     */
    expose?: "all" | "none";
    /** Explicit allowlist of skill names to expose (overrides expose setting). */
    allowlist?: string[];
  };
  /**
   * PLAN-43 §3.2b: hermetic execution of inbound (remote-caller) A2A tasks.
   * A remote caller's turn defaults to a pure model turn: no tools, a real
   * wall clock, capped input/output. `tools.allow` extends the toolset, but
   * the hardcoded remote floor (wallet/shell/sessions/egress — see
   * agents/a2a-remote-policy.ts) can never be granted back.
   */
  remoteExecution?: {
    /** Tool grants for remote task turns. Default: allow nothing. */
    tools?: {
      allow?: string[];
      deny?: string[];
    };
    /** Max chars of inbound message text; larger requests are refused before the payment gate. Default: 32000. */
    maxInputChars?: number;
    /** Max chars of result text returned to the caller (truncated beyond). Default: 64000. */
    maxOutputChars?: number;
    /** Server-side wall clock for the spawned turn, seconds. Default: 600. */
    timeoutSeconds?: number;
  };
  /** x402 payment gate configuration. */
  payment?: {
    /**
     * Enable payment requirement for A2A tasks. Default: true when the node
     * is earning-capable (full CDP credentials present and wallet not
     * disabled — see isEarningCapable in defaults.ts), false otherwise.
     */
    enabled?: boolean;
    x402?: {
      /** USDC receiving address on Base. */
      address?: string;
      /** Minimum per-task payment in USDC. Default: 0.01. */
      minPayment?: number;
    };
  };
  /** P2P mesh delegation settings. */
  mesh?: {
    /** Enable delegating tasks to mesh peers. Default: false. */
    delegation?: boolean;
    /** Percentage fee for gateway node on delegated tasks. Default: 10. */
    gatewayFeePercent?: number;
  };
  /**
   * ERC-8004 onchain identity. PLAN-8 Phase 5.
   *
   * When configured with a tokenId, the agent advertises its onchain identity
   * in the Agent Card under `extensions.erc8004` so callers can look up
   * reputation and feedback history on the registry contract.
   */
  erc8004?: {
    /** Enable ERC-8004 identity advertisement. Default: false. */
    enabled?: boolean;
    /** ERC-721 tokenId on the Identity Registry (decimal string). */
    tokenId?: string;
    /** Registry contract address (overrides canonical address for the chosen chain). */
    registry?: string;
    /** Chain. Default: "base". */
    chain?: "base" | "base-sepolia";
    /**
     * In-memory TTL for ERC-8004 reputation lookups, in milliseconds.
     * The `a2a_status` tool caches per-(tokenId, chain) reads so repeated
     * agent calls don't hammer the chain RPC. Default: 300000 (5 minutes).
     */
    cacheTtlMs?: number;
  };
  /** Skill marketplace configuration. */
  marketplace?: {
    /** Enable automatic skill listing. Default: true when A2A is enabled. */
    enabled?: boolean;
    /** Pricing configuration. */
    pricing?: {
      /** Base price in USDC. Default: 0.01 */
      basePriceUsdc?: number;
      /** Minimum price floor. Default: 0.001 */
      minPriceUsdc?: number;
      /** Maximum price cap. Default: 1.00 */
      maxPriceUsdc?: number;
      /** Fixed price override (disables dynamic pricing). */
      fixedPriceUsdc?: number;
      /** Minimum executions before listing. Default: 3 */
      minExecutionsForListing?: number;
      /** Minimum success rate for listing. Default: 0.6 */
      minSuccessRateForListing?: number;
    };
    /** A2A client (outbound) configuration. */
    client?: {
      /** Maximum USDC to spend per outbound A2A task. Default: 0.50 */
      maxTaskCostUsdc?: number;
      /** Maximum USDC to spend per day on outbound tasks. Default: 2.00 */
      dailySpendLimitUsdc?: number;
      /** Task timeout in ms. Default: 60000 */
      taskTimeoutMs?: number;
    };
  };
};
