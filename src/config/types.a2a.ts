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
  /** Control which skills are advertised in the Agent Card. */
  skills?: {
    /** Which skills to expose. Default: "all". */
    expose?: "all" | "none";
    /** Explicit allowlist of skill names to expose (overrides expose setting). */
    allowlist?: string[];
  };
  /** x402 payment gate configuration. */
  payment?: {
    /** Enable payment requirement for A2A tasks. Default: false. */
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
