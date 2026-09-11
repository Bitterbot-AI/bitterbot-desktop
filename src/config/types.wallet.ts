export type WalletConfig = {
  /** Enable wallet functionality (default: true). User must fund wallet to transact. */
  enabled?: boolean;
  /** Network to operate on (default: "base-sepolia" for testnet safety). */
  network?: "base" | "base-sepolia";
  /** Coinbase Developer Platform API key ID. */
  cdpApiKeyId?: string;
  /** Coinbase Developer Platform API key secret. */
  cdpApiKeySecret?: string;
  /** Cumulative spend cap per agent session in USD (default: 50). */
  sessionSpendCapUsd?: number;
  /** Maximum USD value for a single transaction (default: 25). */
  perTransactionCapUsd?: number;
  /** Directory to persist wallet seed/state (default: ~/.bitterbot/wallet/). */
  walletStorePath?: string;
  /** Daily spend limit in USD (default: 50). Resets every 24 hours. */
  dailySpendLimitUsd?: number;
  /** x402 micropayment protocol configuration. */
  x402?: {
    /** Enable x402 payment flows (default: false). */
    enabled?: boolean;
    /** Maximum cost in USD per x402 request (default: 1). */
    maxCostPerRequestUsd?: number;
    /** x402 facilitator URL for payment validation (optional). */
    facilitatorUrl?: string;
  };
  /**
   * URL of the hosted onramp service for Tier 1 / Tier 3 funding.
   *
   * Resolution order for wallet.stripeOnramp:
   *   Tier 2 — Local Stripe keys (stripe.secretKey / STRIPE_SECRET_KEY) → session created locally.
   *   Tier 3 — Custom onrampUrl → POST /session to this endpoint.
   *   Tier 1 — No keys, no custom URL → defaults to https://onramp.bitterbot.ai.
   *
   * Set to a custom URL to point at your own hosted onramp service (Tier 3).
   * Or set BITTERBOT_ONRAMP_URL env var.
   */
  onrampUrl?: string;
  /** Stripe Crypto Onramp configuration. */
  stripe?: {
    /** Enable Stripe Crypto Onramp for fiat-to-USDC funding (default: false). */
    enabled?: boolean;
    /** Stripe secret key (or set STRIPE_SECRET_KEY env var). */
    secretKey?: string;
    /** Stripe publishable key (or set STRIPE_PUBLISHABLE_KEY env var). */
    publishableKey?: string;
  };
  // TODO: Phase 2 — contract allowlist validation
  /** Phase 2 prep: restrict interactions to audited contract addresses. */
  allowlistedContracts?: string[];
  /**
   * CDP Smart Account custody (PLAN-47 Phase 2). When enabled, spend is bound by
   * an on-chain spend permission (per-period allowance) and gas can be sponsored
   * via user operations, instead of the plain MPC EOA. OPT-IN (default false):
   * creating/routing through a smart account is an operator-run on-chain step —
   * enabling it without having run the upgrade would route sends at a
   * non-existent account. The allowance here is the spend-permission spec,
   * enforced app-side today (SpendPermissionPolicy) and on-chain once upgraded.
   */
  smartAccount?: {
    /** Route sends through the CDP Smart Account instead of the plain EOA (default: false). */
    enabled?: boolean;
    /** Per-period spend allowance in USD. */
    allowanceUsd?: number;
    /** Allowance period in seconds (default: 86400 = daily). */
    periodSeconds?: number;
    /** Sponsor gas via user operations (paymaster) rather than requiring ETH (default: false). */
    sponsorGas?: boolean;
  };
};
