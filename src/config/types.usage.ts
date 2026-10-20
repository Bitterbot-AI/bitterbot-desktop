/**
 * PLAN-50: usage ledger and spend budgets.
 */

export type UsageBudgetLimitConfig = {
  /** Budget in USD for the window. */
  usd: number;
};

export type UsageBudgetsConfig = {
  /** "warn" (default) alerts only; "enforce" also pauses background lanes (dream, extraction, evolution) when exceeded. User turns are never blocked. */
  mode?: "warn" | "enforce";
  /** UTC calendar day. */
  daily?: UsageBudgetLimitConfig;
  /** UTC week starting Monday. */
  weekly?: UsageBudgetLimitConfig;
  /** UTC calendar month. */
  monthly?: UsageBudgetLimitConfig;
  /** Monthly budget per "provider/model". */
  perModel?: Record<string, UsageBudgetLimitConfig>;
  /** Monthly budget per feature id (e.g. "memory/dream"). */
  perFeature?: Record<string, UsageBudgetLimitConfig>;
};

export type UsageLedgerConfig = {
  /** Record every model call (chat, hidden lanes, embeddings) to the local usage ledger. Default true. */
  enabled?: boolean;
  /** Days of usage history to keep. Default 365. */
  retentionDays?: number;
};

export type UsagePricingConfig = {
  /** Refresh a dated price snapshot from OpenRouter's public model list once a day. Default true. */
  liveRefresh?: boolean;
  /** Override the models endpoint (e.g. a mirror). */
  openRouterUrl?: string;
};

export type UsageConfig = {
  ledger?: UsageLedgerConfig;
  budgets?: UsageBudgetsConfig;
  pricing?: UsagePricingConfig;
};
