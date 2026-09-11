/**
 * PLAN-47 invariant harness (Phase 0).
 *
 * One `it.todo` per plan invariant (I1-I7) that is not yet satisfiable, plus a
 * pointer to the existing test that already covers the ones the current code
 * guarantees. These todos are the red skeletons the later phases turn green;
 * they document the contract without failing CI or duplicating coverage.
 *
 * Already covered by existing tests (do NOT re-implement here):
 *   I1 mandate authenticity     -> src/payments/ap2/mandate.test.ts  (Phase 1, DONE)
 *       (signature verify, over-limit + disallowed-payee emit refused, tamper/expiry)
 *   I2 consume-once (inbound)   -> src/services/x402-verify.test.ts
 *       (x402_consumed_tx atomic claim; "Payment token already consumed")
 *   I3 context binding (inbound)-> src/services/x402-verify.test.ts
 *       (on-chain Transfer recipient exact-match; amount binding, GHSA-36vc-...)
 *   spend caps                  -> src/services/wallet-service.spend-limits.test.ts
 *
 * The gap the plan closes is the OUTBOUND + mandate-scoped side of these
 * guarantees, which does not exist yet.
 */
import { describe, it } from "vitest";

describe("PLAN-47 invariants (red skeletons — turn green per phase)", () => {
  // I1 mandate authenticity is DONE (Phase 1) — see src/payments/ap2/mandate.test.ts.

  // Phase 4: Policy Decision Record enforcement layer.
  it.todo(
    "I2 consume-once (mandate-scoped, outbound) — a replayed Payment mandate is " +
      "rejected though its signature is still valid (extends x402-verify's tx-hash ledger)",
  );
  it.todo(
    "I3 context binding (mandate-scoped) — a mandate authorized for merchant/context A " +
      "cannot settle against B even with a valid signature (AP2 Context-Binding-Failure)",
  );
  it.todo(
    "I6 auditable decision record — every allow/deny emits a persisted, replayable " +
      "Policy Decision Record (mandate id, nonce, context match, verdict, timestamp)",
  );

  // Phase 2: CDP MPC EOA -> Smart Account (Victor-authored; test is ours).
  it.todo(
    "I5 address continuity — after the EIP-7702 upgrade the wallet address is " +
      "unchanged (0x1593…), balances intact, send_usdc + Aubaine EIP-3009 signer still work",
  );

  // Cross-cutting, per phase.
  it.todo(
    "I7 kill-switch honesty — with each phase's kill switch off, behavior is " +
      "byte-identical to pre-plan (mandates not required, enforcement not applied)",
  );

  // I4 (no unauthorized spend path) is enforced at lint time, not here:
  // scripts/check-payment-paths.mjs (wired into `pnpm lint`).
});
