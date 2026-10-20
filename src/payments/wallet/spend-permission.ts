/**
 * Spend-permission policy — the per-period allowance a CDP Smart Account spend
 * permission enforces on-chain, expressed as pure, testable logic. PLAN-47
 * Phase 2 (the smart-account custody upgrade).
 *
 * A plain EOA (Bitterbot's `0x1593…` today) cannot express "at most $X per day to
 * token T" — every send is unconstrained by the key alone. A CDP Smart Account
 * (ERC-4337) can, via a SpendPermission { token, allowance, period, start }.
 * This module is the off-chain mirror of that permission: the same windowed
 * allowance math, so the limit can be enforced at the application layer today
 * (defense in depth on EOA sends) and handed to the smart account verbatim once
 * the upgrade lands. Keeping one policy definition on both sides is what makes
 * the on-chain move a routing change, not a re-specification.
 *
 * Windows are FIXED and anchored at `start` (matching CDP's recurring-period
 * model), not rolling: the allowance resets at each period boundary.
 */

/** A CDP-shaped spend permission: at most `allowanceUsd` per `periodSeconds`. */
export interface SpendPermission {
  /** Allowance per period, in USD (USDC). */
  allowanceUsd: number;
  /** Period length in seconds (e.g. 86400 for daily). */
  periodSeconds: number;
  /** Window anchor, unix ms. Periods are [start + k·period, start + (k+1)·period). Default 0. */
  startMs?: number;
}

export interface SpendRecord {
  amountUsd: number;
  atMs: number;
}

export interface SpendCheck {
  allowed: boolean;
  /** Remaining allowance in the current window after the checked amount would apply. */
  remainingUsd: number;
  reason?: string;
}

/**
 * Enforces a SpendPermission against a running list of spends. Construct with
 * the permission and (optionally) prior spends loaded from persistence; call
 * `check` before a send and `record` after it settles.
 */
export class SpendPermissionPolicy {
  private readonly periodMs: number;
  private readonly startMs: number;

  constructor(
    private readonly permission: SpendPermission,
    private spends: SpendRecord[] = [],
  ) {
    if (!(permission.allowanceUsd >= 0)) {
      throw new Error(`invalid allowanceUsd: ${permission.allowanceUsd}`);
    }
    if (!(permission.periodSeconds > 0)) {
      throw new Error(`invalid periodSeconds: ${permission.periodSeconds}`);
    }
    this.periodMs = permission.periodSeconds * 1000;
    this.startMs = permission.startMs ?? 0;
  }

  /** Start (unix ms) of the fixed window containing `now`. */
  windowStart(now: number): number {
    const k = Math.floor((now - this.startMs) / this.periodMs);
    return this.startMs + k * this.periodMs;
  }

  /** Total spent in the window containing `now`. */
  consumedUsd(now: number): number {
    const from = this.windowStart(now);
    const to = from + this.periodMs;
    let sum = 0;
    for (const s of this.spends) {
      if (s.atMs >= from && s.atMs < to) sum += s.amountUsd;
    }
    return sum;
  }

  /** Allowance left in the current window. */
  remainingUsd(now: number): number {
    return Math.max(0, this.permission.allowanceUsd - this.consumedUsd(now));
  }

  /** Whether `amountUsd` may be spent now, without recording it. */
  check(amountUsd: number, now: number): SpendCheck {
    if (!(amountUsd >= 0) || !Number.isFinite(amountUsd)) {
      return { allowed: false, remainingUsd: this.remainingUsd(now), reason: "invalid amount" };
    }
    const remaining = this.remainingUsd(now);
    if (amountUsd > remaining) {
      return {
        allowed: false,
        remainingUsd: remaining,
        reason: `spend permission exceeded: ${amountUsd} > ${remaining} remaining this period`,
      };
    }
    return { allowed: true, remainingUsd: remaining - amountUsd };
  }

  /** Record a settled spend so it counts against the window. */
  record(amountUsd: number, now: number): void {
    this.spends.push({ amountUsd, atMs: now });
  }

  /** Drop spends older than the current window — keeps the record list bounded. */
  prune(now: number): void {
    const from = this.windowStart(now);
    this.spends = this.spends.filter((s) => s.atMs >= from);
  }

  /** Current spends (for persistence). */
  snapshot(): SpendRecord[] {
    return [...this.spends];
  }
}
