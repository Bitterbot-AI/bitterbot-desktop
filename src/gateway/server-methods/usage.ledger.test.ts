import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    usage: { budgets: { daily: { usd: 10 } } },
  })),
}));

import { resetModelPricingMemoForTest as resolveModelPricingMemoResetForTest } from "../../infra/model-pricing.js";
import { UsageLedger, resolveUsageEvent, setUsageLedgerForTest } from "../../infra/usage-ledger.js";
import { listGatewayMethods } from "../server-methods-list.js";
import { __testLedger, usageHandlers } from "./usage.js";

type Handler = (typeof usageHandlers)[string];
const call = async (name: string, params: unknown) => {
  const respond = vi.fn();
  await (usageHandlers[name] as Handler)({ respond, params } as unknown as Parameters<Handler>[0]);
  return respond.mock.calls[0] as [boolean, unknown, { message?: string } | undefined];
};

describe("usage.ledger.* RPCs", () => {
  let ledger: UsageLedger;

  beforeEach(async () => {
    resolveModelPricingMemoResetForTest();
    __testLedger.ledgerSummaryCache.clear();
    ledger = UsageLedger.openInMemory();
    setUsageLedgerForTest(ledger);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const now = Date.now();
    for (const [feature, kind, provider, model, usage] of [
      [
        "agent/turn",
        "chat",
        "anthropic",
        "claude-haiku-4-5",
        { input: 100, cacheRead: 900, output: 50 },
      ],
      ["memory/index", "embedding", "openai", "text-embedding-3-small", { total: 4000 }],
      ["memory/dream", "chat", "anthropic", "claude-haiku-4-5", { input: 10, output: 10 }],
    ] as const) {
      const row = await resolveUsageEvent({
        ts: now - 60_000,
        kind,
        feature,
        provider,
        model,
        usage,
        agentId: "main",
      });
      ledger.insert(row!);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    setUsageLedgerForTest(null);
    ledger.close();
  });

  it("advertises and answers usage.ledger.summary with every pivot", async () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining(["usage.ledger.summary", "usage.ledger.events"]),
    );
    const [ok, result] = await call("usage.ledger.summary", { days: 7 });
    expect(ok).toBe(true);
    const summary = result as {
      totals: { calls: number; usage: { total: number }; cacheHitRate: number };
      byModel: Array<{ model: string | null; kinds: string[]; pricingSources: string[] }>;
      byFeature: Array<{ key: string }>;
      byKind: Array<{ key: string }>;
      daily: Array<{ date: string }>;
      budgets: { budgets: Array<{ id: string; limitUsd: number }> };
      ledger: { events: number };
      startDate: string;
      endDate: string;
    };
    expect(summary.totals.calls).toBe(3);
    expect(summary.startDate).toBe("2026-09-09");
    expect(summary.endDate).toBe("2026-09-15");
    expect(summary.daily).toHaveLength(7);
    expect(
      summary.byModel.map((m) => m.model ?? "").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["claude-haiku-4-5", "text-embedding-3-small"]);
    expect(summary.byModel.find((m) => m.model === "claude-haiku-4-5")?.pricingSources).toEqual([
      "catalog",
    ]);
    expect(summary.byKind.map((k) => k.key).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "chat",
      "embedding",
    ]);
    expect(summary.byFeature.map((f) => f.key).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "agent/turn",
      "memory/dream",
      "memory/index",
    ]);
    expect(summary.budgets.budgets[0]).toMatchObject({ id: "global:daily", limitUsd: 10 });
    expect(summary.ledger.events).toBe(3);
  });

  it("filters the summary by kind and feature and rejects unknown params", async () => {
    const [, embeddingsOnly] = await call("usage.ledger.summary", { days: 7, kind: "embedding" });
    expect((embeddingsOnly as { totals: { calls: number } }).totals.calls).toBe(1);
    const [, dreamOnly] = await call("usage.ledger.summary", { days: 7, feature: "memory/dream" });
    expect((dreamOnly as { totals: { calls: number } }).totals.calls).toBe(1);
    const [ok, , err] = await call("usage.ledger.summary", { dayz: 7 });
    expect(ok).toBe(false);
    expect(err?.message).toContain("unexpected property 'dayz'");
  });

  it("pages usage.ledger.events newest first with filters", async () => {
    const [ok, page] = await call("usage.ledger.events", { limit: 2 });
    expect(ok).toBe(true);
    const first = page as {
      events: Array<{ id: number; feature: string }>;
      nextBeforeId: number | null;
    };
    expect(first.events).toHaveLength(2);
    expect(first.events[0]!.id).toBeGreaterThan(first.events[1]!.id);
    expect(first.nextBeforeId).toBe(first.events[1]!.id);
    const [, rest] = await call("usage.ledger.events", { limit: 2, beforeId: first.nextBeforeId! });
    expect((rest as { events: unknown[] }).events).toHaveLength(1);
    const [, embeddings] = await call("usage.ledger.events", { kind: "embedding" });
    expect(
      (embeddings as { events: Array<{ feature: string }> }).events.map((e) => e.feature),
    ).toEqual(["memory/index"]);
  });

  it("reports the ledger as disabled instead of crashing", async () => {
    setUsageLedgerForTest(null);
    process.env.BITTERBOT_USAGE_LEDGER = "0";
    try {
      const [ok, , err] = await call("usage.ledger.summary", {});
      expect(ok).toBe(false);
      expect(err?.message).toContain("disabled");
    } finally {
      delete process.env.BITTERBOT_USAGE_LEDGER;
    }
  });
});
