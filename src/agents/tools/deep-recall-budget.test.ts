import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
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

describe("deep_recall daily budget", () => {
  it("defaults to one dollar a day and lets calls through below it", () => {
    const budget = checkRecallBudget({ spentTodayUsd: () => 0.4 });
    expect(budget).toEqual({
      exhausted: false,
      budgetUsd: DEFAULT_RECALL_BUDGET_USD_PER_DAY,
      spentUsd: 0.4,
    });
  });

  it("stops at the budget and points at recall_range", () => {
    const budget = checkRecallBudget({
      cfg: cfgWith(0.5),
      agentId: "main",
      spentTodayUsd: () => 0.5,
    });
    expect(budget.exhausted).toBe(true);
    if (budget.exhausted) {
      expect(budget.notice).toContain("$0.50 of $0.50");
      expect(budget.notice).toContain("recall_range");
    }
  });

  it("uses the agent's own budget over the default", () => {
    const cfg = cfgWith(0.5, 3);
    expect(checkRecallBudget({ cfg, agentId: "drill", spentTodayUsd: () => 1 }).exhausted).toBe(
      false,
    );
    expect(checkRecallBudget({ cfg, agentId: "main", spentTodayUsd: () => 1 }).exhausted).toBe(
      true,
    );
  });

  it("a budget of zero turns deep_recall off for the current conversation", () => {
    expect(
      checkRecallBudget({ cfg: cfgWith(0), agentId: "main", spentTodayUsd: () => 0 }).exhausted,
    ).toBe(true);
  });

  it("does not block when the spend cannot be read", () => {
    const budget = checkRecallBudget({
      spentTodayUsd: () => {
        throw new Error("ledger unavailable");
      },
    });
    expect(budget.exhausted).toBe(false);
  });
});
