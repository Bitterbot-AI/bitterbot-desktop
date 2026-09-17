import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUsageStore, type UsageLedgerSummary } from "../../stores/usage-store";
import { UsageView } from "./UsageView";

const emptyTotals = () => ({
  calls: 0,
  errors: 0,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
  costComputed: 0,
  computedCalls: 0,
  costReportedOnComputed: 0,
  reportedCalls: 0,
  cacheHitRate: 0,
  unpricedCalls: 0,
  estimatedCalls: 0,
});

function makeSummary(): UsageLedgerSummary {
  const chat = {
    ...emptyTotals(),
    calls: 12,
    usage: {
      input: 1000,
      cacheRead: 9000,
      cacheWrite: 500,
      output: 800,
      reasoning: 0,
      total: 11300,
    },
    cost: { input: 0.01, cacheRead: 0.009, cacheWrite: 0.00625, output: 0.04, total: 0.06525 },
    cacheHitRate: 9000 / 10500,
  };
  const embed = {
    ...emptyTotals(),
    calls: 40,
    usage: { input: 200000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 200000 },
    cost: { input: 0.004, cacheRead: 0, cacheWrite: 0, output: 0, total: 0.004 },
  };
  return {
    updatedAt: 1,
    startMs: 0,
    endMs: 1,
    startDate: "2026-09-09",
    endDate: "2026-09-15",
    days: 7,
    totals: { ...chat, calls: 52, cost: { ...chat.cost, total: 0.06925 } },
    byModel: [
      {
        ...chat,
        provider: "anthropic",
        model: "claude-opus-4-8",
        kinds: ["chat"],
        pricingSources: ["provider"],
        lastTs: 1,
      },
      {
        ...embed,
        provider: "openai",
        model: "text-embedding-3-small",
        kinds: ["embedding"],
        pricingSources: ["embedding-catalog"],
        lastTs: 1,
      },
    ],
    byProvider: [{ ...chat, key: "anthropic", label: "anthropic" }],
    byFeature: [
      { ...chat, key: "agent/turn", label: "Chat turns" },
      { ...embed, key: "memory/index", label: "Memory indexing (embeddings)" },
    ],
    byKind: [
      { ...chat, key: "chat", label: "chat" },
      { ...embed, key: "embedding", label: "embedding" },
    ],
    byAgent: [{ ...chat, key: "main", label: "main" }],
    daily: [
      {
        date: "2026-09-15",
        tokens: 11300,
        cost: 0.069,
        calls: 52,
        usage: chat.usage,
        byModel: [
          {
            provider: "anthropic",
            model: "claude-opus-4-8",
            tokens: 11300,
            cost: 0.069,
            calls: 12,
          },
        ],
        byKind: [],
      },
    ],
    bySession: [
      {
        ...chat,
        key: "agent:main:main",
        sessionKey: "agent:main:main",
        label: "Main chat",
        agentId: "main",
        channel: "webchat",
        lastTs: Date.now(),
        models: ["anthropic/claude-opus-4-8"],
      },
    ],
    outcomes: {
      tasks: 3,
      succeeded: 2,
      failed: 1,
      stopped: 0,
      costTotal: 5.5,
      costPerSuccess: 2.75,
      costOnFailures: 3,
      byModel: [
        {
          provider: "anthropic",
          model: "claude-opus-4-8",
          tasks: 3,
          succeeded: 2,
          failed: 1,
          costTotal: 5.5,
          costPerSuccess: 2.75,
        },
      ],
      byFeature: [],
    },
    energy: { wh: 42, gco2e: 18, bandLow: 0.33, bandHigh: 3, method: "test" },
    runawayRuns: [],
    byTask: [{ ...chat, key: "task-1", taskId: "task-1", label: "Summarize the inbox", runs: 2 }],
    cacheHealth: {
      requests: 12,
      hitRate: 0.86,
      busts: 1,
      wastedUsd: 0.31,
      unreadWriteUsd: 0,
      unreadWriteTokens: 0,
      warm: true,
      ttl: "5m",
      lastChatTs: Date.now(),
      reasons: [{ reason: "prompt prefix changed (system prompt, tools, or model)", count: 1 }],
      byModel: [
        {
          provider: "anthropic",
          model: "claude-opus-4-8",
          requests: 12,
          hitRate: 0.86,
          busts: 1,
          wastedUsd: 0.31,
          unreadWriteUsd: 0,
        },
      ],
    },
    live: {
      window5h: {
        startMs: 0,
        endMs: 1,
        calls: 3,
        tokens: 3000,
        cost: 0.03,
        tokensPerMinute: 10,
        costPerHour: 0.006,
        projectedCost: 0.03,
      },
      lastHour: {
        startMs: 0,
        endMs: 1,
        calls: 1,
        tokens: 1000,
        cost: 0.01,
        tokensPerMinute: 16,
        costPerHour: 0.01,
        projectedCost: 0.01,
      },
      peak5h: { startMs: 0, cost: 0.5, tokens: 50000 },
    },
    pricing: { liveSnapshots: 1, liveNewestAt: Date.now(), liveEntries: 400, liveError: null },
    unpricedModels: [],
    budgets: {
      mode: "warn",
      budgets: [
        {
          id: "global:daily",
          scope: "global",
          window: "daily",
          limitUsd: 1,
          spentUsd: 0.5,
          ratio: 0.5,
          level: 50,
          exceeded: false,
          windowStartMs: 0,
          resetsAtMs: Date.now() + 3_600_000,
          projectedUsd: 0.9,
        },
      ],
      backgroundPaused: false,
    },
    ledger: {
      enabled: true,
      dbPath: null,
      events: 52,
      oldestTs: 0,
      newestTs: 1,
      dbBytes: 1024,
      lastReconcileAt: Date.now(),
      lastReconcileRows: 0,
      retentionDays: 365,
    },
    flags: [{ id: "unpriced-models", level: "warn", message: "flagged model", tip: "set a price" }],
  };
}

describe("UsageView", () => {
  beforeEach(() => {
    useUsageStore.setState({
      summary: null,
      liveEvents: [],
      error: null,
      loading: false,
      tab: "overview",
    });
  });

  it("renders an error banner instead of a blank page when the RPC fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("invalid sessions.usage params: unexpected property 'days'"));
    useGatewayStore.setState({ status: "connected", request, hello: null } as never);
    render(<UsageView />);
    expect(await screen.findByText(/unexpected property 'days'/)).toBeTruthy();
  });

  it("renders the ledger summary: KPI tiles, embeddings, budgets and flags", async () => {
    const summary = makeSummary();
    const request = vi.fn(async (method: string) => {
      if (method === "usage.ledger.summary") return summary;
      if (method === "usage.ledger.events") return { events: [], nextBeforeId: null };
      if (method === "sessions.usage") return { sessions: [], totals: {}, aggregates: {} };
      throw new Error(`unexpected ${method}`);
    });
    useGatewayStore.setState({ status: "connected", request, hello: null } as never);
    render(<UsageView />);
    expect(await screen.findByText("Cache hit rate")).toBeTruthy();
    expect(screen.getByText("86%")).toBeTruthy();
    expect(screen.getByText("Embeddings")).toBeTruthy();
    expect(screen.getByText("flagged model")).toBeTruthy();
    expect(screen.getByText("Prompt cache")).toBeTruthy();
    expect(screen.getByText(/1 bust/)).toBeTruthy();
    expect(screen.getByText("Burn rate")).toBeTruthy();
    expect(screen.getByText(/Ledger: 52 rows/)).toBeTruthy();
    expect(request).toHaveBeenCalledWith("usage.ledger.summary", { days: 30 });
    // The Sessions tab reads the ledger's bySession now; the transcript scan is no longer requested.
    expect(request).not.toHaveBeenCalledWith("sessions.usage", expect.anything());
    expect(screen.getByText("Cost per outcome")).toBeTruthy();
    expect(screen.getByText("Energy (estimate)")).toBeTruthy();
  });

  it("shows the empty state when nothing was recorded", async () => {
    const summary = {
      ...makeSummary(),
      totals: emptyTotals(),
      byModel: [],
      byFeature: [],
      byKind: [],
      daily: [],
      flags: [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "usage.ledger.summary") return summary;
      if (method === "usage.ledger.events") return { events: [], nextBeforeId: null };
      return { sessions: [] };
    });
    useGatewayStore.setState({ status: "connected", request, hello: null } as never);
    render(<UsageView />);
    expect(await screen.findByText(/No model calls in this window yet/)).toBeTruthy();
  });
});
