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
  /**
   * Anthropic's per-TTL cache_creation split when the provider reported it (workstream B
   * surfaces `usage.cacheWrite5m` / `usage.cacheWrite1h`); null when only the aggregate is known.
   */
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  /**
   * Prefix-stability telemetry: SHA-256 of the stable system block (above the cache boundary)
   * and of the sorted tool names sent with this request. A digest that moves between turns
   * less than a TTL apart is a cache bust the operator can act on.
   */
  prefixDigest: string | null;
  toolsDigest: string | null;
  durationMs: number | null;
  status: "ok" | "error";
  stopReason: string | null;
  batch: boolean;
  items: number | null;
  source: "live" | "reconcile";
};

/** How the agent reached a tool: the hot set directly, the client dispatcher, or native search. */
export type ToolCallVia = "direct" | "use_tool" | "native-search" | "list_tools";

export type ToolCallRow = {
  id: number;
  ts: number;
  day: string;
  agentId: string | null;
  sessionKey: string | null;
  runId: string | null;
  tool: string;
  via: ToolCallVia;
  ok: boolean;
  errorClass: string | null;
  durationMs: number | null;
  resultChars: number | null;
  spilled: boolean;
};

export type UsageToolTelemetry = {
  startMs: number;
  endMs: number;
  days: number;
  calls: number;
  direct: number;
  useTool: number;
  useToolFailed: number;
  nativeSearch: number;
  listTools: number;
  failed: number;
  /** Tools reached through use_tool or native search, most often first. */
  indirect: Array<{ tool: string; calls: number; failed: number }>;
  /** Tools the hot set should probably include: indirect calls at or above the threshold. */
  promote: string[];
  promoteThreshold: number;
  spilled: { calls: number; avgChars: number; byTool: Array<{ tool: string; calls: number }> };
  errorClasses: Array<{ errorClass: string; calls: number }>;
};

export type UsagePrefixChange = {
  sessionKey: string;
  /** Turns in the window for that session. */
  turns: number;
  /** Prefix changes observed between turns less than `maxGapMs` apart. */
  changes: number;
  /** Which tier moved: the tool list, the stable system block, or both. */
  tier: "tools" | "system" | "both";
  lastChangeTs: number;
};

export type UsagePrefixStability = {
  startMs: number;
  endMs: number;
  sessions: number;
  /** Sessions with at least one close-gap prefix change. */
  changed: UsagePrefixChange[];
  maxGapMs: number;
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
  unreadWriteUsd: number;
};

export type UsageSessionSummary = UsageGroupSummary & {
  sessionKey: string;
  agentId: string | null;
  channel: string | null;
  lastTs: number | null;
  /** Models used, most spend first. */
  models: string[];
};

export type UsageOutcomeRow = {
  provider: string | null;
  model: string | null;
  tasks: number;
  succeeded: number;
  failed: number;
  costTotal: number;
  /** costTotal / succeeded; null when nothing succeeded. */
  costPerSuccess: number | null;
};

export type UsageOutcomes = {
  /** Tasks in the window that reached a terminal status and have ledger rows. */
  tasks: number;
  succeeded: number;
  failed: number;
  stopped: number;
  costTotal: number;
  costPerSuccess: number | null;
  /** Spend on tasks that ended in failure or were stopped. */
  costOnFailures: number;
  byModel: UsageOutcomeRow[];
  byFeature: Array<{
    feature: string;
    label: string;
    tasks: number;
    succeeded: number;
    costTotal: number;
    costPerSuccess: number | null;
  }>;
};

export type UsageEnergyEstimate = {
  /** Watt-hours, from published per-token estimates; treat as an order of magnitude. */
  wh: number;
  /** Grams CO2-equivalent at a world-average grid factor. */
  gco2e: number;
  /** Uncertainty band multiplier (estimates published by vendors differ by ~3x). */
  bandLow: number;
  bandHigh: number;
  method: string;
};

export type UsageRunawayRun = {
  runId: string;
  sessionKey: string | null;
  feature: string;
  cost: number;
  calls: number;
  startedAt: number;
  /** Multiple of the median run cost in the window. */
  multiple: number;
};

export type UsageCacheHealth = {
  /** Chat requests on cache-capable providers in the window. */
  requests: number;
  hitRate: number;
  busts: number;
  /** Cost of cache writes on bust turns. */
  wastedUsd: number;
  /** Cost of cache writes that were never read back (write-only sessions such as spaced
   *  heartbeats): the dominant waste on nodes whose turns are spaced past the TTL. */
  unreadWriteUsd: number;
  unreadWriteTokens: number;
  /** Which lanes are re-writing the cache without reading it (heartbeats, cron), most costly first. */
  unreadByFeature: Array<{
    feature: string;
    label: string;
    requests: number;
    usd: number;
    /** TTL observed on the lane's rows (null when the rows carry none). */
    ttl: CacheTtlLabel | null;
  }>;
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
  bySession: UsageSessionSummary[];
  outcomes: UsageOutcomes;
  energy: UsageEnergyEstimate;
  runawayRuns: UsageRunawayRun[];
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

/** PLAN-50 Phase 6: what-if replay of a window under another model's prices. */
export type UsageWhatIf = {
  startDate: string;
  endDate: string;
  target: { provider: string; model: string; source: PricingSource };
  /** Rows replayed (chat, vision, search); embeddings/tts/audio are excluded. */
  calls: number;
  actualCost: number;
  projectedCost: number;
  savingsUsd: number;
  savingsPct: number;
  byModel: Array<{
    provider: string | null;
    model: string | null;
    calls: number;
    actualCost: number;
    projectedCost: number;
  }>;
  caveat: string;
};

/** PLAN-50 Phase 6: "explain my bill" for a window vs the window before it. */
export type UsageExplanation = {
  startDate: string;
  endDate: string;
  cost: number;
  priorCost: number;
  changePct: number | null;
  /** Human-readable lines, most important first. */
  lines: string[];
  drivers: Array<{
    kind: "feature" | "model" | "session" | "day";
    key: string;
    label: string;
    cost: number;
    priorCost: number;
    delta: number;
  }>;
};
