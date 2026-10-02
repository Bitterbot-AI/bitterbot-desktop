/**
 * Daily budget for `deep_recall` over the current conversation (PLAN-52A
 * 3.9): `compaction.offload.recallBudgetUsdPerDay`, default $1.00.
 *
 * `deep_recall` is the one recall path that costs money (a sub-model loop per
 * call). Once a day's spend on it reaches the budget, the tool answers with a
 * one-line notice instead of running; `recall_range` (exact, free) is still
 * there. The spend comes from the usage ledger (`rlm/deep-recall`), which has
 * no agent on those rows, so the budget is per day for the node.
 */

import type { BitterbotConfig } from "../../config/config.js";
import { getUsageLedger, isUsageLedgerEnabled } from "../../infra/usage-ledger.js";
import { resolveAgentCompaction } from "../runtime/compaction/agent-config.js";

export const DEFAULT_RECALL_BUDGET_USD_PER_DAY = 1.0;
export const DEEP_RECALL_FEATURE = "rlm/deep-recall";

export type RecallBudget =
  | { exhausted: false; budgetUsd: number; spentUsd: number }
  | { exhausted: true; budgetUsd: number; spentUsd: number; notice: string };

function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function checkRecallBudget(params: {
  cfg?: BitterbotConfig;
  agentId?: string;
  nowMs?: number;
  /** Test seam; defaults to today's `rlm/deep-recall` spend in the usage ledger. */
  spentTodayUsd?: () => number;
}): RecallBudget {
  const configured = resolveAgentCompaction(params.cfg, params.agentId).offload
    .recallBudgetUsdPerDay;
  const budgetUsd =
    typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_RECALL_BUDGET_USD_PER_DAY;
  let spentUsd = 0;
  try {
    spentUsd = params.spentTodayUsd
      ? params.spentTodayUsd()
      : isUsageLedgerEnabled()
        ? (getUsageLedger()?.spend({
            feature: DEEP_RECALL_FEATURE,
            startMs: startOfLocalDay(params.nowMs ?? Date.now()),
          }) ?? 0)
        : 0;
  } catch {
    // No ledger, no enforcement: the per-call cost cap still applies.
    spentUsd = 0;
  }
  if (spentUsd < budgetUsd) {
    return { exhausted: false, budgetUsd, spentUsd };
  }
  return {
    exhausted: true,
    budgetUsd,
    spentUsd,
    notice:
      `Today's deep_recall budget is used up ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}). ` +
      "Use recall_range for this conversation: it returns the exact text of a range, an entry, or a tool output, at no cost.",
  };
}
