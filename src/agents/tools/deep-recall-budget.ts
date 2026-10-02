/**
 * Daily budget for `deep_recall` (PLAN-52A 3.9):
 * `compaction.offload.recallBudgetUsdPerDay`, default $1.00.
 *
 * `deep_recall` is the one recall path that costs money (a sub-model loop per
 * call). Once the day's spend on it reaches the budget, the tool answers with
 * a one-line notice instead of running; `recall_range` (exact, free) is still
 * there.
 *
 * What is counted: every `rlm/deep-recall` row in the usage ledger since
 * 00:00 UTC (the day the PLAN-50 budgets use), for the whole node. Those rows
 * carry no agent, so the spend cannot be split per agent or per session; the
 * limit compared against it is the calling agent's setting. The check covers
 * every scope: a budget that only guarded `current_session` would be passed
 * by asking for another scope.
 *
 * Not enforced when the usage ledger is off, or for a sub-model with no
 * price (its calls record $0): the per-call cost cap still applies there.
 */

import type { BitterbotConfig } from "../../config/config.js";
import { budgetWindowBounds } from "../../infra/usage-budgets.js";
import {
  getUsageLedger,
  isUsageLedgerEnabled,
  type UsageLedger,
} from "../../infra/usage-ledger.js";
import { resolveAgentCompaction } from "../runtime/compaction/agent-config.js";

export const DEFAULT_RECALL_BUDGET_USD_PER_DAY = 1.0;
export const DEEP_RECALL_FEATURE = "rlm/deep-recall";

export type RecallBudget =
  | { exhausted: false; budgetUsd: number; spentUsd: number }
  | { exhausted: true; budgetUsd: number; spentUsd: number; notice: string };

export function checkRecallBudget(params: {
  cfg?: BitterbotConfig;
  agentId?: string;
  nowMs?: number;
  /** Defaults to the process ledger when it is enabled. */
  ledger?: Pick<UsageLedger, "spend"> | null;
}): RecallBudget {
  const configured = resolveAgentCompaction(params.cfg, params.agentId).offload
    .recallBudgetUsdPerDay;
  const budgetUsd =
    typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_RECALL_BUDGET_USD_PER_DAY;
  let spentUsd = 0;
  try {
    const ledger =
      params.ledger !== undefined
        ? params.ledger
        : isUsageLedgerEnabled()
          ? getUsageLedger()
          : null;
    spentUsd =
      ledger?.spend({
        feature: DEEP_RECALL_FEATURE,
        startMs: budgetWindowBounds("daily", params.nowMs ?? Date.now()).startMs,
      }) ?? 0;
  } catch {
    // No ledger, no enforcement: the per-call cost cap still applies.
    spentUsd = 0;
  }
  if (budgetUsd > 0 && spentUsd < budgetUsd) {
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
