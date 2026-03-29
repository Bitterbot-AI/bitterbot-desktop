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
import { getHeader } from "../http-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

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

export async function verifyA2aPayment(
  req: IncomingMessage,
  config: BitterbotConfig,
  marketplace: MarketplaceEconomics | null,
  rpcParams?: { skillId?: string; message?: { parts?: Array<{ type: string; text?: string }> } },
): Promise<PaymentGateResult> {
  // Check x402 payment headers — accept both custom and x402 v2 standard headers
  // x402 v2 spec: client sends PAYMENT-SIGNATURE header (Base64 JSON)
  const paymentHeader = getHeader(req, "x-payment")
    ?? getHeader(req, "payment-signature");  // x402 v2 standard header
  const paymentToken = getHeader(req, "x-payment-token");

  if (!paymentHeader && !paymentToken) {
    // No payment attempted — return pricing info
    const minPayment = config.a2a?.payment?.x402?.minPayment ?? 0.01;
    const listings = marketplace?.getListableSkills() ?? [];
    return {
      paid: false,
      pricing: {
        priceUsdc: minPayment,
        skills: listings.map((l) => ({ id: l.skillCrystalId, name: l.name, price: l.priceUsdc })),
      },
    };
  }

  // Verify x402 payment on Base
  try {
    const { verifyX402Payment } = await import("../../services/x402-verify.js");
    const address = config.a2a?.payment?.x402?.address;
    if (!address) {
      log.warn("Payment received but no x402 address configured");
      return { paid: false };
    }

    const network = config.tools?.wallet?.network ?? "base-sepolia";

    const verification = await verifyX402Payment({
      paymentToken: paymentToken ?? paymentHeader!,
      expectedRecipient: address,
      minimumAmount: config.a2a?.payment?.x402?.minPayment ?? 0.01,
      network: network as "base" | "base-sepolia",
      db: marketplace?.getDb?.(),
    });

    if (verification.valid) {
      // Resolve skill ID from explicit param or by matching task text against listings
      let resolvedSkillId = rpcParams?.skillId;
      if (!resolvedSkillId && marketplace) {
        const taskText = rpcParams?.message?.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ")
          .toLowerCase() ?? "";
        if (taskText) {
          const listings = marketplace.getListableSkills();
          const match = listings.find((l) =>
            taskText.includes(l.name.toLowerCase()) || taskText.includes(l.skillCrystalId),
          );
          resolvedSkillId = match?.skillCrystalId;
        }
      }
      return {
        paid: true,
        txHash: verification.txHash,
        amountUsdc: verification.amount,
        buyerPeerId: verification.senderAddress,
        skillId: resolvedSkillId,
      };
    }

    log.debug(`Payment verification failed: ${verification.error}`);
    return { paid: false };
  } catch (err) {
    log.debug(`Payment verification error: ${String(err)}`);
    return { paid: false };
  }
}
