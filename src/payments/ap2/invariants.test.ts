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
 *   I2 consume-once (mandate)   -> src/payments/ap2/enforcement.test.ts  (Phase 4, DONE)
 *       (replayed mandate denied; nonce not burned on an earlier-check failure)
 *   I3 context binding (mandate)-> src/payments/ap2/enforcement.test.ts  (Phase 4, DONE)
 *       (mandate payee != settlement recipient -> deny)
 *   I6 policy decision record   -> src/payments/ap2/enforcement.test.ts  (Phase 4, DONE)
 *       (a PDR is persisted for every allow and every deny)
 *   I2/I3 also hold at the x402 tx layer -> src/services/x402-verify.test.ts
 *       (consumed-tx ledger; on-chain Transfer recipient + amount binding, GHSA-36vc-...)
 *   spend caps                  -> src/services/wallet-service.spend-limits.test.ts
 *
 * The gap the plan closes is the OUTBOUND + mandate-scoped side of these
 * guarantees, which does not exist yet.
 */
import { describe, it } from "vitest";

describe("PLAN-47 invariants (red skeletons — turn green per phase)", () => {
  // I1 mandate authenticity is DONE (Phase 1) — see src/payments/ap2/mandate.test.ts.
  // I2 consume-once, I3 context binding, I6 Policy Decision Record are DONE
  // (Phase 4) — see src/payments/ap2/enforcement.test.ts.

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
