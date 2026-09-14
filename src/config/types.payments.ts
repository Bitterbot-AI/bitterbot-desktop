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
  };
};
