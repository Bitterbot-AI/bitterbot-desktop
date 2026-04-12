import { create } from "zustand";

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

type UsageState = {
  result: UsageResult | null;
  days: number;
  loading: boolean;
  error: string | null;
  setResult: (result: UsageResult) => void;
  setDays: (days: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useUsageStore = create<UsageState>((set) => ({
  result: null,
  days: 30,
  loading: false,
  error: null,
  setResult: (result) => set({ result }),
  setDays: (days) => set({ days }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
