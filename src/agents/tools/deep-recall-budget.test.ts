import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { resolveUsageEvent, UsageLedger } from "../../infra/usage-ledger.js";
import { checkRecallBudget, DEFAULT_RECALL_BUDGET_USD_PER_DAY } from "./deep-recall-budget.js";

const cfgWith = (defaults?: number, agent?: number) =>
  ({
    agents: {
      defaults: {
        compaction: { offload: defaults === undefined ? {} : { recallBudgetUsdPerDay: defaults } },
      },
      list: [
        { id: "main" },
        {
          id: "drill",
          ...(agent === undefined
            ? {}
            : { compaction: { offload: { recallBudgetUsdPerDay: agent } } }),
        },
      ],
    },
  }) as unknown as BitterbotConfig;

const spent = (usd: number) => ({ spend: () => usd });

describe("deep_recall daily budget", () => {
  it("defaults to one dollar a day and lets calls through below it", () => {
    expect(checkRecallBudget({ ledger: spent(0.4) })).toEqual({
      exhausted: false,
      budgetUsd: DEFAULT_RECALL_BUDGET_USD_PER_DAY,
      spentUsd: 0.4,
    });
  });

  it("stops at the budget and points at recall_range", () => {
    const budget = checkRecallBudget({ cfg: cfgWith(0.5), agentId: "main", ledger: spent(0.5) });
    expect(budget.exhausted).toBe(true);
    if (budget.exhausted) {
      expect(budget.notice).toContain("$0.50 of $0.50");
      expect(budget.notice).toContain("recall_range");
    }
  });

  it("uses the agent's own limit over the default", () => {
    const cfg = cfgWith(0.5, 3);
    expect(checkRecallBudget({ cfg, agentId: "drill", ledger: spent(1) }).exhausted).toBe(false);
    expect(checkRecallBudget({ cfg, agentId: "main", ledger: spent(1) }).exhausted).toBe(true);
  });

  it("a budget of zero turns deep_recall off", () => {
    expect(
      checkRecallBudget({ cfg: cfgWith(0), agentId: "main", ledger: spent(0) }).exhausted,
    ).toBe(true);
  });

  it("does not block when the ledger is off or cannot be read", () => {
    expect(checkRecallBudget({ ledger: null }).exhausted).toBe(false);
    const broken = {
      spend: () => {
        throw new Error("ledger unavailable");
      },
    };
    expect(checkRecallBudget({ ledger: broken }).exhausted).toBe(false);
  });

  it("counts today's deep_recall rows of a real ledger, by UTC day, and nothing else", async () => {
    const ledger = UsageLedger.openInMemory();
    const now = Date.UTC(2026, 9, 2, 15, 0, 0);
    const row = async (feature: string, ts: number, usd: number, key: string) => {
      const resolved = await resolveUsageEvent({
        kind: "chat",
        feature,
        provider: "acme",
        model: "sub",
        ts,
        usage: { input: 10, output: 10 },
        cost: { total: usd },
      });
      ledger.insert({ ...resolved!, dedupeKey: key });
    };
    await row("rlm/deep-recall", now - 60_000, 0.6, "a");
    await row("rlm/deep-recall", now - 120_000, 0.5, "b");
    // Yesterday (UTC) and another feature do not count.
    await row("rlm/deep-recall", Date.UTC(2026, 9, 1, 23, 59, 0), 5, "c");
    await row("agent/turn", now - 60_000, 5, "d");

    const budget = checkRecallBudget({ ledger, nowMs: now });
    expect(budget.spentUsd).toBeCloseTo(1.1, 5);
    expect(budget.exhausted).toBe(true);
    expect(
      checkRecallBudget({ cfg: cfgWith(2), agentId: "main", ledger, nowMs: now }).exhausted,
    ).toBe(false);
    ledger.close();
  });
});
