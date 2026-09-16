/**
 * PLAN-50: shared shapes for the usage ledger (gateway, CLI, UI all import these).
 */

export type UsageKind = "chat" | "embedding" | "vision" | "audio" | "tts" | "search";

export type PricingSource =
  | "provider"
  | "override"
  | "catalog"
  | "embedding-catalog"
  | "live"
  | "local"
  | "estimated"
  | "unpriced";

/** USD per 1M tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic 1-hour cache-write rate when published (live snapshots); optional. */
  cacheWrite1h?: number;
};

/** Exclusive token buckets (Langfuse/OTel-subset model). */
export type UsageBuckets = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Subset of `output` when the provider reports it; informational. */
  reasoning: number;
  total: number;
};

export type UsageCost = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
};

export type CacheTurnState = "hit" | "write" | "mixed" | "none";
export type CacheTtlLabel = "5m" | "1h" | "none";

export type UsageEventRow = {
  id: number;
  ts: number;
  day: string;
  kind: UsageKind;
  feature: string;
  provider: string | null;
  model: string | null;
  api: string | null;
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  channel: string | null;
  usage: UsageBuckets;
  cost: UsageCost;
  costSource: PricingSource;
  price: ModelPrice | null;
  /** Cost recomputed from our own price table (null when no price is known); lets the UI show
   *  "reported" vs "computed" side by side, the ccusage cost-mode idea. */
  costComputed: number | null;
  /** PLAN-50 Phase 5: prompt-cache observation for chat rows. */
  cacheState: CacheTurnState | null;
  cacheBustReason: string | null;
  cacheTtl: CacheTtlLabel | null;
  durationMs: number | null;
  status: "ok" | "error";
  stopReason: string | null;
  batch: boolean;
  items: number | null;
  source: "live" | "reconcile";
};

export type UsageTotalsRow = {
  calls: number;
  errors: number;
  usage: UsageBuckets;
  cost: UsageCost;
  /** Sum of computed cost over rows that have a table price (`computedCalls`). */
  costComputed: number;
  /** Rows with a table price, i.e. the denominator for `costComputed`. */
  computedCalls: number;
  /** Reported cost summed over the same rows, so drift compares like with like. */
  costReportedOnComputed: number;
  /** Rows whose cost came from the model library rather than our table. */
  reportedCalls: number;
  /** cacheRead / (input + cacheRead + cacheWrite); 0 when no input. */
  cacheHitRate: number;
  /** Share of calls whose cost came from an unpriced or estimated source. */
  unpricedCalls: number;
  estimatedCalls: number;
};

export type UsageModelSummary = UsageTotalsRow & {
  provider: string | null;
  model: string | null;
  kinds: UsageKind[];
  pricingSources: PricingSource[];
  lastTs: number | null;
};

export type UsageGroupSummary = UsageTotalsRow & { key: string; label: string };

export type UsageTaskSummary = UsageGroupSummary & { taskId: string; runs: number };

export type UsageCacheModelHealth = {
  provider: string | null;
  model: string | null;
  requests: number;
  hitRate: number;
  busts: number;
  /** Cost of cache writes on bust turns: what a warm cache would have avoided. */
  wastedUsd: number;
};

export type UsageCacheHealth = {
  /** Chat requests on cache-capable providers in the window. */
  requests: number;
  hitRate: number;
  busts: number;
  wastedUsd: number;
  /** True when the newest chat turn is within its cache TTL. */
  warm: boolean;
  ttl: CacheTtlLabel | null;
  lastChatTs: number | null;
  reasons: Array<{ reason: string; count: number }>;
  byModel: UsageCacheModelHealth[];
};

export type UsageRateWindow = {
  startMs: number;
  endMs: number;
  calls: number;
  tokens: number;
  cost: number;
  tokensPerMinute: number;
  costPerHour: number;
  /** Cost projected to the end of the window at the current rate. */
  projectedCost: number;
};

export type UsageLiveStats = {
  /** Rolling last 5 hours (the subscription-style block ccusage and Claude Code watch). */
  window5h: UsageRateWindow;
  lastHour: UsageRateWindow;
  /** Most expensive 5-hour block in the range; the default ceiling for the 5h bar ("-t max"). */
  peak5h: { startMs: number; cost: number; tokens: number } | null;
};

export type UsagePricingStatus = {
  liveSnapshots: number;
  liveNewestAt: number | null;
  liveEntries: number;
  liveError: string | null;
};

export type UsageDailyModelPoint = {
  provider: string | null;
  model: string | null;
  tokens: number;
  cost: number;
  calls: number;
};

export type UsageDailyPoint = {
  date: string;
  tokens: number;
  cost: number;
  calls: number;
  usage: UsageBuckets;
  byModel: UsageDailyModelPoint[];
  byKind: Array<{ kind: UsageKind; tokens: number; cost: number; calls: number }>;
};

export type UsageBudgetWindow = "daily" | "weekly" | "monthly";

export type UsageBudgetStatus = {
  id: string;
  scope: "global" | "model" | "feature";
  window: UsageBudgetWindow;
  /** "provider/model" or feature id for scoped budgets. */
  target?: string;
  limitUsd: number;
  spentUsd: number;
  /** spentUsd / limitUsd, may exceed 1. */
  ratio: number;
  /** Highest alert rung crossed (0, 50, 80, 95, 100). */
  level: 0 | 50 | 80 | 95 | 100;
  exceeded: boolean;
  windowStartMs: number;
  resetsAtMs: number;
  /** Linear projection of spend at window end from the elapsed fraction. */
  projectedUsd: number;
};

export type UsageBudgetsSummary = {
  mode: "warn" | "enforce";
  budgets: UsageBudgetStatus[];
  /** True when `mode` is enforce and any budget that covers background lanes is exceeded. */
  backgroundPaused: boolean;
};

export type UsageLedgerHealth = {
  enabled: boolean;
  dbPath: string | null;
  events: number;
  oldestTs: number | null;
  newestTs: number | null;
  dbBytes: number | null;
  lastReconcileAt: number | null;
  lastReconcileRows: number | null;
  retentionDays: number;
};

export type UsageLedgerSummary = {
  updatedAt: number;
  startMs: number;
  endMs: number;
  startDate: string;
  endDate: string;
  days: number;
  totals: UsageTotalsRow;
  byModel: UsageModelSummary[];
  byProvider: UsageGroupSummary[];
  byFeature: UsageGroupSummary[];
  byKind: UsageGroupSummary[];
  byAgent: UsageGroupSummary[];
  daily: UsageDailyPoint[];
  byTask: UsageTaskSummary[];
  cacheHealth: UsageCacheHealth;
  live: UsageLiveStats;
  pricing: UsagePricingStatus;
  /** Models seen in range whose cost had to be zeroed because nobody knows their price. */
  unpricedModels: Array<{
    provider: string | null;
    model: string | null;
    calls: number;
    tokens: number;
  }>;
  budgets: UsageBudgetsSummary;
  ledger: UsageLedgerHealth;
  /** Cost coach: notable conditions with a suggestion each. */
  flags: Array<{ id: string; level: "info" | "warn"; message: string; tip?: string }>;
};

export type UsageEventsPage = {
  events: UsageEventRow[];
  nextBeforeId: number | null;
};

export const USAGE_ALERT_LADDER = [50, 80, 95, 100] as const;

export function emptyUsageBuckets(): UsageBuckets {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}

export function emptyUsageCost(): UsageCost {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

export function emptyUsageTotals(): UsageTotalsRow {
  return {
    calls: 0,
    errors: 0,
    usage: emptyUsageBuckets(),
    cost: emptyUsageCost(),
    costComputed: 0,
    computedCalls: 0,
    costReportedOnComputed: 0,
    reportedCalls: 0,
    cacheHitRate: 0,
    unpricedCalls: 0,
    estimatedCalls: 0,
  };
}

export function cacheHitRate(usage: UsageBuckets): number {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) {
    return 0;
  }
  return usage.cacheRead / promptTokens;
}

export function formatUsageDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
