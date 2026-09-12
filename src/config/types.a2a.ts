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
  /**
   * PLAN-43 Phase 3: the attestation exchange (network validation layer).
   * Serving `skill/attest.*` is on whenever A2A is; syncing happens only
   * with the peers listed here (reachable A2A URLs).
   */
  attestation?: {
    /** Serve and sync attestations. Default: true. */
    enabled?: boolean;
    /** Peer A2A base URLs to push/pull attestations with. Default: []. */
    peers?: string[];
    /** Attester pubkeys (ed25519:<hex>) whose verdicts weigh 1.0. */
    trustedAttesters?: string[];
    /** Attester pubkeys whose verdicts are ignored. */
    blockedAttesters?: string[];
    /** Weight for attesters not in either list (their total is also capped at 25% of trusted weight). Default: 0.05. */
    unknownAttesterWeight?: number;
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
    /** AP2 payment mandates over the x402 rail (PLAN-47 Phase 1). */
    ap2?: {
      /**
       * Attach a signed AP2 payment mandate to outbound x402 payments and
       * verify inbound ones (advisory). Default: true. Advisory in Phase 1 —
       * mandates never gate settlement until the Phase 4 enforcement layer.
       */
      enabled?: boolean;
    };
    /** Spend grants + consent (PLAN-48). */
    consent?: {
      /**
       * Require an active human-set spend grant to cover an outbound A2A payment.
       * Default: false. When true, an uncovered spend raises an approval request
       * and is refused rather than paid (the "scope once, escalate out-of-scope"
       * model). Grants are managed via the spendGrant.* operator RPCs.
       */
      grantsRequired?: boolean;
    };
    /** AP2 runtime enforcement: consume-once + context binding (PLAN-47 Phase 4). */
    enforcement?: {
      /**
       * Block an inbound task whose attached AP2 mandate is invalid, replayed,
       * or redirected (wrong payee). Default: true. When false the gate is
       * advisory-log-only. A missing mandate never blocks either way.
       */
      enabled?: boolean;
    };
    /** Escalation approval UX (PLAN-48 Phase 2). */
    escalation?: {
      /**
       * USD amount at or above which approving a pending escalation in the
       * Control UI requires a local step-up confirmation (a platform passkey /
       * biometric ceremony, falling back to a typed confirmation when no
       * platform authenticator is available). Undefined or <= 0 disables the
       * step-up (default: disabled). The step-up is a client-side "human present
       * + verified" gate on the operator-authed approve action; server-side
       * WebAuthn assertion verification is a tracked fast-follow, so the
       * confirmation method recorded on the approval is advisory today.
       */
      stepUpThresholdUsd?: number;
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
    /**
     * PLAN-43 Phase 3 (§3.7) kill switch: when true, no paid listing is
     * advertised or sellable (agent card, invoke, and listing RPCs all read
     * empty) until cleared. Read live from config; no restart needed.
     */
    freezeListings?: boolean;
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
