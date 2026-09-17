import { create } from "zustand";

// ---------------------------------------------------------------------------
// PLAN-50 usage ledger shapes (mirror of src/infra/usage-ledger.types.ts)
// ---------------------------------------------------------------------------

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

export type UsageBuckets = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
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

export type UsageTotalsRow = {
  calls: number;
  errors: number;
  usage: UsageBuckets;
  cost: UsageCost;
  costComputed: number;
  computedCalls: number;
  costReportedOnComputed: number;
  reportedCalls: number;
  cacheHitRate: number;
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
export type UsageSessionSummary = UsageGroupSummary & {
  sessionKey: string;
  agentId: string | null;
  channel: string | null;
  lastTs: number | null;
  models: string[];
};
export type UsageOutcomes = {
  tasks: number;
  succeeded: number;
  failed: number;
  stopped: number;
  costTotal: number;
  costPerSuccess: number | null;
  costOnFailures: number;
  byModel: Array<{
    provider: string | null;
    model: string | null;
    tasks: number;
    succeeded: number;
    failed: number;
    costTotal: number;
    costPerSuccess: number | null;
  }>;
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
  wh: number;
  gco2e: number;
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
  multiple: number;
};
export type UsageWhatIf = {
  startDate: string;
  endDate: string;
  target: { provider: string; model: string; source: PricingSource };
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
export type UsageExplanation = {
  startDate: string;
  endDate: string;
  cost: number;
  priorCost: number;
  changePct: number | null;
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

export type UsageCacheHealth = {
  requests: number;
  hitRate: number;
  busts: number;
  wastedUsd: number;
  unreadWriteUsd: number;
  unreadWriteTokens: number;
  warm: boolean;
  ttl: "5m" | "1h" | "none" | null;
  lastChatTs: number | null;
  reasons: Array<{ reason: string; count: number }>;
  byModel: Array<{
    provider: string | null;
    model: string | null;
    requests: number;
    hitRate: number;
    busts: number;
    wastedUsd: number;
    unreadWriteUsd: number;
  }>;
};

export type UsageRateWindow = {
  startMs: number;
  endMs: number;
  calls: number;
  tokens: number;
  cost: number;
  tokensPerMinute: number;
  costPerHour: number;
  projectedCost: number;
};

export type UsageLiveStats = {
  window5h: UsageRateWindow;
  lastHour: UsageRateWindow;
  peak5h: { startMs: number; cost: number; tokens: number } | null;
};

export type UsageDailyPoint = {
  date: string;
  tokens: number;
  cost: number;
  calls: number;
  usage: UsageBuckets;
  byModel: Array<{
    provider: string | null;
    model: string | null;
    tokens: number;
    cost: number;
    calls: number;
  }>;
  byKind: Array<{ kind: UsageKind; tokens: number; cost: number; calls: number }>;
};

export type UsageBudgetStatus = {
  id: string;
  scope: "global" | "model" | "feature";
  window: "daily" | "weekly" | "monthly";
  target?: string;
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  level: 0 | 50 | 80 | 95 | 100;
  exceeded: boolean;
  windowStartMs: number;
  resetsAtMs: number;
  projectedUsd: number;
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
  pricing: {
    liveSnapshots: number;
    liveNewestAt: number | null;
    liveEntries: number;
    liveError: string | null;
  };
  unpricedModels: Array<{
    provider: string | null;
    model: string | null;
    calls: number;
    tokens: number;
  }>;
  budgets: { mode: "warn" | "enforce"; budgets: UsageBudgetStatus[]; backgroundPaused: boolean };
  ledger: {
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
  flags: Array<{ id: string; level: "info" | "warn"; message: string; tip?: string }>;
};

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
  costComputed: number | null;
  cacheState: "hit" | "write" | "mixed" | "none" | null;
  cacheBustReason: string | null;
  cacheTtl: "5m" | "1h" | "none" | null;
  durationMs: number | null;
  status: "ok" | "error";
  stopReason: string | null;
  batch: boolean;
  items: number | null;
  source: "live" | "reconcile";
};

// ---------------------------------------------------------------------------
// Legacy transcript-scan shapes (sessions.usage) — still used for the Sessions tab.
// ---------------------------------------------------------------------------

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};

export type UsageSessionEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  usage: {
    totalTokens: number;
    totalCost: number;
    input: number;
    output: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export type UsageAggregates = {
  messages: { total: number; user: number; assistant: number; toolCalls: number; errors: number };
  tools: { totalCalls: number; uniqueTools: number; tools: Array<{ name: string; count: number }> };
  byModel: Array<{ provider?: string; model?: string; count: number; totals: UsageTotals }>;
  byProvider: Array<{ provider?: string; count: number; totals: UsageTotals }>;
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
  [key: string]: unknown;
};

export type UsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: UsageSessionEntry[];
  totals: UsageTotals;
  aggregates: UsageAggregates;
};

export type UsageTab = "overview" | "models" | "features" | "sessions" | "live";

export const LIVE_FEED_LIMIT = 100;

type UsageState = {
  summary: UsageLedgerSummary | null;
  liveEvents: UsageEventRow[];
  days: number;
  tab: UsageTab;
  /** Models tab: reported (model library) vs computed (tokens × our table) cost. */
  costMode: "reported" | "computed" | "both";
  loading: boolean;
  error: string | null;
  /** null = unknown (not connected yet); false = gateway predates the ledger RPCs. */
  ledgerSupported: boolean | null;
  lastEventAt: number | null;
  setSummary: (summary: UsageLedgerSummary | null) => void;
  setLiveEvents: (events: UsageEventRow[]) => void;
  pushLiveEvent: (event: UsageEventRow) => void;
  setDays: (days: number) => void;
  setTab: (tab: UsageTab) => void;
  setCostMode: (mode: "reported" | "computed" | "both") => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setLedgerSupported: (supported: boolean | null) => void;
};

export const useUsageStore = create<UsageState>((set) => ({
  summary: null,
  liveEvents: [],
  days: 30,
  tab: "overview",
  costMode: "reported",
  loading: false,
  error: null,
  ledgerSupported: null,
  lastEventAt: null,
  setSummary: (summary) => set({ summary }),
  setLiveEvents: (liveEvents) => set({ liveEvents: liveEvents.slice(0, LIVE_FEED_LIMIT) }),
  pushLiveEvent: (event) =>
    set((state) => {
      if (state.liveEvents.some((e) => e.id === event.id)) {
        return state;
      }
      return {
        liveEvents: [event, ...state.liveEvents].slice(0, LIVE_FEED_LIMIT),
        lastEventAt: event.ts,
      };
    }),
  setDays: (days) => set({ days }),
  setTab: (tab) => set({ tab }),
  setCostMode: (costMode) => set({ costMode }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setLedgerSupported: (ledgerSupported) => set({ ledgerSupported }),
}));
