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

/**
 * PLAN-47 Phase 4: AP2 enforcement gate. If the buyer attached an AP2 payment
 * mandate inside the x402 token, run the enforcement gate — authenticity +
 * consume-once (replay) + context binding (the mandate's declared payee must be
 * the party actually being paid) — and emit a Policy Decision Record.
 *
 * Returns { block } — true only when enforcement is enabled AND a *present*
 * mandate fails (forgery / replay / redirect). A missing mandate never blocks
 * (legacy / third-party peers), and when enforcement is disabled the decision is
 * advisory-logged only (Phase 1 behavior). Never throws into the payment path:
 * an internal error degrades to advisory (does not block a paid task).
 *
 * Today only Bitterbot-fleet peers emit `ap2`, and they share this mandate
 * format, so blocking a present-and-invalid mandate is a forgery/replay defense
 * with no legitimate-traffic cost. Kill switch: a2a.payment.enforcement.enabled.
 */
async function enforceInboundAp2Mandate(
  paymentToken: string,
  ctx: {
    expectedPayee: string;
    expectedAmount: number;
    enforce: boolean;
    /** PLAN-48 Phase 5: deny at/above this USD unless consent is verified (0/undef = additive). */
    gateConsentAboveUsd?: number;
    db?: import("node:sqlite").DatabaseSync;
  },
): Promise<{ block: boolean }> {
  try {
    const decoded = JSON.parse(Buffer.from(paymentToken, "base64").toString("utf-8")) as {
      ap2?: { intent?: unknown; payment?: unknown; consent?: unknown; binding?: unknown };
    };
    if (!decoded.ap2?.intent || !decoded.ap2?.payment) return { block: false }; // legacy / no mandate

    const { evaluate, createSqliteEnforcementStore, InMemoryEnforcementStore } =
      await import("../../payments/ap2/enforcement.js");
    const { recoverMessageAddress } = await import("viem");
    const nodeCrypto = await import("node:crypto");
    // Verify an Ed25519 signature over `msg` for an `ed25519:<hex>` pubkey — the
    // same SPKI-wrapped form the Circles envelope layer uses — to check the
    // consent lineage (the moat). Never throws.
    const verifyEd25519 = (msg: string, sigHex: string, pubkey: string): boolean => {
      try {
        const m = /^ed25519:([0-9a-f]{64})$/.exec(pubkey);
        if (!m || !/^[0-9a-f]+$/.test(sigHex)) return false;
        const spki = Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(m[1]!, "hex"),
        ]);
        const key = nodeCrypto.createPublicKey({ key: spki, format: "der", type: "spki" });
        return nodeCrypto.verify(null, Buffer.from(msg), key, Buffer.from(sigHex, "hex"));
      } catch {
        return false;
      }
    };
    const store = ctx.db ? createSqliteEnforcementStore(ctx.db) : new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment: decoded.ap2.payment as never,
      intent: decoded.ap2.intent as never,
      expectedPayee: ctx.expectedPayee,
      expectedAmount: ctx.expectedAmount,
      recover: (canonical, signature) =>
        recoverMessageAddress({ message: canonical, signature: signature as `0x${string}` }),
      store,
      // Consent lineage, when the buyer attached it (additive provenance).
      consent: decoded.ap2.consent as never,
      binding: decoded.ap2.binding as never,
      verifyEd25519,
      // D-5: above this amount, an unverified/absent consent denies (0/undef = additive).
      gateConsentAboveUsd: ctx.gateConsentAboveUsd,
    });

    if (pdr.verdict === "allow") {
      log.debug(`AP2 mandate allowed (${pdr.mandateId.slice(0, 16)})`);
      return { block: false };
    }
    if (ctx.enforce) {
      log.warn(`AP2 mandate DENIED, blocking task: ${pdr.reasons.join("; ")}`);
      return { block: true };
    }
    log.warn(`AP2 mandate would be denied (advisory, not enforced): ${pdr.reasons.join("; ")}`);
    return { block: false };
  } catch (err) {
    // Fail open to the on-chain decision: an enforcement bug must not reject a
    // task the buyer already paid for on-chain.
    log.debug(`AP2 enforcement skipped (degraded to advisory): ${String(err)}`);
    return { block: false };
  }
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
      // PLAN-47 Phase 4: AP2 enforcement gate. Blocks a present-but-invalid
      // mandate (forgery/replay/redirect) when enforcement is enabled; a missing
      // mandate or disabled enforcement never blocks. Default: enabled.
      const enforce = config.a2a?.payment?.enforcement?.enabled ?? true;
      const gateConsentAboveUsd = config.a2a?.payment?.consent?.gateThresholdUsd;
      const { block } = await enforceInboundAp2Mandate(paymentToken ?? paymentHeader!, {
        expectedPayee: address,
        expectedAmount: requiredAmount,
        enforce,
        gateConsentAboveUsd,
        db: marketplace?.getDb?.(),
      });
      if (block) {
        return { paid: false };
      }
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
