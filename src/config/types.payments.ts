/**
 * Payments config root (PLAN-49). Home for the fiat bridge / bank-connector
 * settings. Phase 1 introduces only the display-only `fiat.uiDollars` flag; the
 * money-moving legs (onramp / auto-refill / offramp / bank-link) land in later
 * phases under `fiat`, each behind its own default-off kill switch.
 */
export type PaymentsConfig = {
  /** Fiat bridge (PLAN-49). Money-moving legs default OFF; Phase 1 is display-only. */
  fiat?: {
    /**
     * Present the wallet as a dollar balance + plain-English ledger in the
     * Control UI (PLAN-49 Phase 1). Default: true. Display-only — moves no money
     * and changes no on-chain behavior. Off = the crypto-first wallet view.
     */
    uiDollars?: boolean;
    /**
     * In-app fiat funding on the consent rail (PLAN-49 Phase 2). When enabled, the
     * agent (or the user) can raise a funding request instead of dead-ending on a
     * shortfall, and the Wallet tab funds in-app rather than via a manual detour.
     * The actual card/bank charge runs through the licensed onramp partner and is
     * always initiated by a human. Default: false (opt-in).
     */
    onramp?: {
      enabled?: boolean;
      /**
       * Hard ceiling on total fiat pulled in per 30-day period (invariant I3).
       * Undefined = not bounded by this ceiling (the wallet's own spend caps still
       * apply downstream); 0 = block all funding. Auto-refill (Phase 3) will spend
       * silently only within this ceiling.
       */
      monthlyCeilingUsd?: number;
    };
  };
};
