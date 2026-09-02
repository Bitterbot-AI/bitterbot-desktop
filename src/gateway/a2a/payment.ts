/**
 * A2A Payment Gate — x402 payment verification for inbound tasks.
 *
 * Checks for x402 payment headers on inbound A2A requests.
 * If payment is required but not present, returns pricing info for 402 response.
 * If payment is present, verifies on-chain before accepting the task.
 */

import type { IncomingMessage } from "node:http";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { MarketplaceEconomics } from "../../memory/marketplace-economics.js";
import { getLocalWalletCapability } from "../../infra/wallet-discovery.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getHeader } from "../http-utils.js";

const log = createSubsystemLogger("a2a/payment");

// ---------------------------------------------------------------------------
// Payment attempt rate limiting — prevents DoS via fake x402 tokens that
// trigger expensive on-chain getTransactionReceipt calls.
// ---------------------------------------------------------------------------

const paymentAttemptTracker = new Map<string, { count: number; windowStart: number }>();
const PAYMENT_RATE_LIMIT = 10; // max attempts per minute per IP
const PAYMENT_WINDOW_MS = 60_000;

export function isPaymentRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = paymentAttemptTracker.get(clientIp);
  if (!entry || now - entry.windowStart > PAYMENT_WINDOW_MS) {
    paymentAttemptTracker.set(clientIp, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  if (entry.count > PAYMENT_RATE_LIMIT) {
    log.warn(`Payment rate limit exceeded for ${clientIp} (${entry.count}/${PAYMENT_RATE_LIMIT})`);
    return true;
  }
  return false;
}

export interface PaymentGateResult {
  paid: boolean;
  txHash?: string;
  skillId?: string;
  buyerPeerId?: string;
  amountUsdc?: number;
  pricing?: {
    priceUsdc: number;
    skills: Array<{ id: string; name: string; price: number }>;
  };
}

/**
 * PLAN-43 Phase 1: resolve the caller's skill selection — EXACT id only,
 * from the explicit param or metadata. Fuzzy name-matching against the
 * task text is banned by design (§3.4: slopsquat magnet; a purchase must
 * never be attributed to a skill the buyer did not name).
 */
export function resolveRequestedSkillId(rpcParams?: {
  skillId?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const direct = rpcParams?.skillId;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const meta = rpcParams?.metadata?.skillId;
  return typeof meta === "string" && meta.trim() ? meta.trim() : undefined;
}

export async function verifyA2aPayment(
  req: IncomingMessage,
  config: BitterbotConfig,
  marketplace: MarketplaceEconomics | null,
  rpcParams?: {
    skillId?: string;
    metadata?: Record<string, unknown>;
    message?: { parts?: Array<{ type: string; text?: string }> };
  },
  opts?: {
    /**
     * Per-call price of the requested skill (PLAN-43 Phase 1). The paid
     * amount must cover it — verifying against minPayment alone would let
     * a buyer purchase an expensive skill at the floor price.
     */
    requiredAmountUsdc?: number;
  },
): Promise<PaymentGateResult> {
  // Check x402 payment headers — accept both custom and x402 v2 standard headers
  // x402 v2 spec: client sends PAYMENT-SIGNATURE header (Base64 JSON)
  const paymentHeader = getHeader(req, "x-payment") ?? getHeader(req, "payment-signature"); // x402 v2 standard header
  const paymentToken = getHeader(req, "x-payment-token");

  const minPayment = config.a2a?.payment?.x402?.minPayment ?? 0.01;
  const requiredAmount = Math.max(minPayment, opts?.requiredAmountUsdc ?? 0);

  if (!paymentHeader && !paymentToken) {
    // No payment attempted — return pricing info
    const listings = marketplace?.getListableSkills() ?? [];
    return {
      paid: false,
      pricing: {
        priceUsdc: requiredAmount,
        skills: listings.map((l) => ({ id: l.skillCrystalId, name: l.name, price: l.priceUsdc })),
      },
    };
  }

  // Verify x402 payment on Base
  try {
    const { verifyX402Payment } = await import("../../services/x402-verify.js");
    // Fall back to the live wallet's receiving address (same source the agent
    // card advertises) so enabling payments needs only a2a.payment.enabled.
    const address = config.a2a?.payment?.x402?.address ?? getLocalWalletCapability()?.address;
    if (!address) {
      log.warn("Payment received but no x402 address configured and no local wallet advertised");
      return { paid: false };
    }

    // Default the verification network to mainnet. Defaulting to a testnet here
    // is fail-open: if payments are enabled but tools.wallet.network is unset,
    // the paywall could be satisfied with valueless base-sepolia USDC. Fail
    // closed onto mainnet so a missing config never downgrades to testnet money.
    const network = config.tools?.wallet?.network ?? "base";

    const verification = await verifyX402Payment({
      paymentToken: paymentToken ?? paymentHeader!,
      expectedRecipient: address,
      minimumAmount: requiredAmount,
      network: network as "base" | "base-sepolia",
      db: marketplace?.getDb?.(),
    });

    if (verification.valid) {
      // PLAN-43 Phase 1: EXACT-id skill attribution only. The previous
      // fallback fuzzy-matched the task text against listing names — the
      // slopsquat vector §3.4 bans. No skillId means a generic task.
      return {
        paid: true,
        txHash: verification.txHash,
        amountUsdc: verification.amount,
        buyerPeerId: verification.senderAddress,
        skillId: resolveRequestedSkillId(rpcParams),
      };
    }

    log.debug(`Payment verification failed: ${verification.error}`);
    return { paid: false };
  } catch (err) {
    log.debug(`Payment verification error: ${String(err)}`);
    return { paid: false };
  }
}
