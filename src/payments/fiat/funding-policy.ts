/**
 * Funding ceiling policy (PLAN-49 Phase 2). The hard cap on how much fiat can be
 * pulled into the wallet per period (invariant I3), so a runaway auto-refill or a
 * mis-tapped top-up can never exceed a budget the user set. Reuses the same
 * windowed-allowance math as spending (SpendPermissionPolicy), so funding and
 * spending share one policy definition.
 *
 * Pure: callers supply the ceiling and the prior top-ups; nothing here charges a
 * card or moves money.
 */

import { SpendPermissionPolicy } from "../wallet/spend-permission.js";

const MONTH_SECONDS = 30 * 24 * 60 * 60;

export interface FundingCeilingCheck {
  allowed: boolean;
  /** Remaining headroom in the current period (Infinity when unbounded). */
  remainingUsd: number;
  reason?: string;
}

export interface TopUp {
  amountUsd: number;
  atMs: number;
}

/**
 * Is a requested top-up within the monthly funding ceiling? `ceilingUsd`
 * undefined = unbounded by this check (the wallet's own spend caps still apply
 * downstream); `0` = block all funding. Fixed 30-day windows by default, matching
 * the spend-permission model.
 */
export function checkFundingWithinCeiling(params: {
  requestUsd: number;
  ceilingUsd?: number;
  priorTopUps?: TopUp[];
  periodSeconds?: number;
  now?: number;
}): FundingCeilingCheck {
  const now = params.now ?? Date.now();
  if (!Number.isFinite(params.requestUsd) || params.requestUsd <= 0) {
    return { allowed: false, remainingUsd: 0, reason: "invalid funding amount" };
  }
  if (params.ceilingUsd === undefined) {
    return { allowed: true, remainingUsd: Number.POSITIVE_INFINITY };
  }
  const policy = new SpendPermissionPolicy(
    { allowanceUsd: params.ceilingUsd, periodSeconds: params.periodSeconds ?? MONTH_SECONDS },
    (params.priorTopUps ?? []).map((t) => ({ amountUsd: t.amountUsd, atMs: t.atMs })),
  );
  const chk = policy.check(params.requestUsd, now);
  return {
    allowed: chk.allowed,
    remainingUsd: chk.remainingUsd,
    reason: chk.allowed ? undefined : (chk.reason ?? "monthly funding ceiling reached"),
  };
}
