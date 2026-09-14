/**
 * Money view — the dollar-denominated read model over the USDC wallet.
 * PLAN-49 Phase 1 (the intuitive core; moves no money).
 *
 * The wallet holds USDC on Base and the agent transacts in it, but a real user
 * thinks in dollars, not stablecoins, chains, or tx hashes. This module is the
 * translation layer: it takes the on-chain USDC balance plus a normalized list of
 * money events (spends from the wallet's tx history, earnings from marketplace
 * sales, later funding/withdrawals) and produces a `$` balance and a
 * plain-English ledger — "Paid a peer agent", "Added funds", "Withdrew to bank".
 *
 * The dollar basis is honest and explicit: **1 USDC = $1.00.** USDC is a
 * fully-reserved US-dollar stablecoin redeemable 1:1 by its issuer, so showing
 * the USDC balance as dollars is a faithful presentation, not an estimate — the
 * one place a rate could drift (a fiat on/off-ramp's spread/fee) is surfaced as
 * an explicit `feeUsd`, never folded silently into the amount (invariant I5).
 *
 * Pure and side-effect-free: callers supply the balance and events; the gateway
 * RPC assembles those from the wallet service and marketplace, and the Control UI
 * renders the result. No money moves here.
 */

/** How a money event affects the balance, in the user's mental model. */
export type MoneyEventKind = "funded" | "spent" | "earned" | "withdrawn";

/** A normalized money event, already converted to dollars by the caller. */
export interface MoneyEvent {
  kind: MoneyEventKind;
  /** Absolute dollar amount that moved (always positive). */
  amountUsd: number;
  /** Unix ms. */
  at: number;
  /** Who/what, in the caller's words (e.g. a peer URL, "Coinbase", a skill name). */
  counterparty?: string;
  /** On-chain / partner reference (tx hash, session id) for the details view. */
  ref?: string;
  /** Any fee charged on top of amountUsd (on/off-ramp spread). Surfaced, never hidden. */
  feeUsd?: number;
}

/** A rendered ledger line: the event plus its signed dollar delta and a label. */
export interface LedgerEntry extends MoneyEvent {
  /** +amount for funded/earned, -(amount+fee) for spent/withdrawn. */
  deltaUsd: number;
  /** Plain-English one-liner for the UI. */
  description: string;
}

export interface MoneyTotals {
  fundedUsd: number;
  spentUsd: number;
  earnedUsd: number;
  withdrawnUsd: number;
  /** Total fees across all events (on/off-ramp spreads). */
  feesUsd: number;
}

export interface MoneyView {
  /** Current spendable balance in dollars (USDC balance, 1:1). */
  balanceUsd: number;
  currency: "USD";
  /** Newest-first ledger. */
  entries: LedgerEntry[];
  totals: MoneyTotals;
  /**
   * A human note about completeness: the balance is the on-chain source of truth,
   * but the ledger itemizes only recorded activity (today: outbound spends +
   * marketplace earnings). Inbound funding/receives that predate itemization live
   * in the balance without a line. Stated so the UI never implies double-entry it
   * does not have.
   */
  note?: string;
}

/** 1 USDC = $1.00 (fully-reserved, issuer-redeemable). The dollar abstraction. */
export function usdcToUsd(usdc: string | number): number {
  const n = typeof usdc === "number" ? usdc : Number.parseFloat(usdc);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents for display-stable dollar math (avoids float drift in sums). */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Map a wallet transaction-history `type` to a money-event kind. Outbound sends,
 * x402 payments, and trades are spends; explicit receive/funding/earning/
 * withdrawal types map through. Unknown types default to "spent" (an unrecognized
 * debit is the conservative assumption — it never inflates the shown balance).
 */
export function kindForTxType(type: string): MoneyEventKind {
  switch (type) {
    case "receive":
    case "fund":
    case "onramp":
      return "funded";
    case "earn":
    case "sale":
      return "earned";
    case "withdraw":
    case "offramp":
      return "withdrawn";
    case "send":
    case "trade":
    case "x402_payment":
    default:
      return "spent";
  }
}

function describe(e: MoneyEvent): string {
  const who = e.counterparty?.trim();
  switch (e.kind) {
    case "funded":
      return who ? `Added funds via ${who}` : "Added funds";
    case "earned":
      return who ? `Earned from ${who}` : "Earned";
    case "withdrawn":
      return who ? `Withdrew to ${who}` : "Withdrew to bank";
    case "spent":
      return who ? `Paid ${who}` : "Paid for a task";
  }
}

const INFLOW: ReadonlySet<MoneyEventKind> = new Set(["funded", "earned"]);

/**
 * Build the dollar-denominated money view from the current USDC balance and the
 * normalized events. Entries come back newest-first; totals sum each kind and all
 * fees; the balance mirrors the USDC balance 1:1.
 */
export function buildMoneyView(params: {
  balanceUsdc: string | number;
  events: MoneyEvent[];
  note?: string;
}): MoneyView {
  const totals: MoneyTotals = {
    fundedUsd: 0,
    spentUsd: 0,
    earnedUsd: 0,
    withdrawnUsd: 0,
    feesUsd: 0,
  };

  const entries: LedgerEntry[] = params.events
    .map((e) => {
      const amount = Number.isFinite(e.amountUsd) && e.amountUsd > 0 ? e.amountUsd : 0;
      const fee = Number.isFinite(e.feeUsd ?? 0) && (e.feeUsd ?? 0) > 0 ? (e.feeUsd as number) : 0;
      const inflow = INFLOW.has(e.kind);
      // A spend/withdrawal costs amount + fee; an inflow credits amount (a fee on
      // an inflow reduces what lands, so it is subtracted from the credit).
      const deltaUsd = inflow ? cents(amount - fee) : cents(-(amount + fee));

      totals.feesUsd = cents(totals.feesUsd + fee);
      if (e.kind === "funded") totals.fundedUsd = cents(totals.fundedUsd + amount);
      else if (e.kind === "earned") totals.earnedUsd = cents(totals.earnedUsd + amount);
      else if (e.kind === "spent") totals.spentUsd = cents(totals.spentUsd + amount);
      else totals.withdrawnUsd = cents(totals.withdrawnUsd + amount);

      return {
        ...e,
        amountUsd: amount,
        feeUsd: fee || undefined,
        deltaUsd,
        description: describe(e),
      };
    })
    .toSorted((a, b) => b.at - a.at);

  return {
    balanceUsd: cents(usdcToUsd(params.balanceUsdc)),
    currency: "USD",
    entries,
    totals,
    note: params.note,
  };
}
