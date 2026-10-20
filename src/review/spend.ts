/**
 * Giving a wallet to code that pays (PLAN-53 C0): the wallet comes wrapped by
 * the spend gate, with decisions recorded in the review store and the owner's
 * approval recognised.
 */

import { configureSpendGate, gateWallet, type SpendContext } from "../payments/ap2/gate.js";
import type { WalletService } from "../services/wallet-service.js";
import { getReviewService, resolveReviewPolicy } from "./runtime.js";
import { isApprovedExecution } from "./service.js";

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  configured = true;
  configureSpendGate({
    record: (decision) => getReviewService().recordSpendDecision(decision),
    isApproved: isApprovedExecution,
  });
}

export type GatedWalletContext = Omit<SpendContext, "requestApproval" | "approvalRequired"> & {
  /**
   * For a spend that may need the owner's approval mid-call: the tool call to
   * hold, so that approving it can run the same call again.
   */
  hold?: {
    toolName: string;
    params: unknown;
    describe: (spend: { payee: string; amountUsd: number }) => string;
  };
};

/** Make the gate record into the review store, for callers that use it directly. */
export function configureSpendGateForReview(): void {
  ensureConfigured();
}

export function gatedWallet(wallet: WalletService, ctx: GatedWalletContext): WalletService {
  ensureConfigured();
  const { hold, ...rest } = ctx;
  return gateWallet(wallet, {
    ...rest,
    approvalRequired: resolveReviewPolicy().spend === "ask",
    ...(hold
      ? {
          requestApproval: (spend) =>
            getReviewService().holdSpend({
              toolName: hold.toolName,
              params: hold.params,
              preview: hold.describe(spend),
              ctx: { sessionKey: ctx.sessionKey, agentId: ctx.agentId },
            }),
        }
      : {}),
  });
}

export function resetGatedWalletForTest(): void {
  configured = false;
}
