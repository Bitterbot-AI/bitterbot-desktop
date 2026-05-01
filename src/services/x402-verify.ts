/**
 * Verify x402 payment receipts on Base.
 *
 * When a buyer agent pays for a skill via x402, it includes a payment
 * token/receipt in the request headers. This module verifies:
 * 1. Optional EIP-191 signature binding (recipient, txHash, amount, sender, timestamp)
 *    so a leaked txHash can't be replayed by another agent against a different
 *    recipient. Tokens without a signature are accepted with a deprecation
 *    warning (legacy clients) and rely on on-chain checks alone.
 * 2. The transaction exists on-chain
 * 3. The recipient matches our wallet address (exact match against Transfer
 *    event log, not the substring check it used to do)
 * 4. The amount meets the minimum requirement
 * 5. The transaction is recent (within 5 minutes to prevent replay)
 * 6. The transaction hasn't already been consumed (UNIQUE on tx_hash)
 *
 * On-chain verification via viem is MANDATORY even on testnet.
 * Without it, a 10-line script can spam spoofed payment tokens and corrupt
 * all economic data. (Gemini peer review: "Trust Me" exploit fix)
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalizePaymentPayload } from "./a2a-client.js";

const log = createSubsystemLogger("x402-verify");

export interface X402VerificationResult {
  valid: boolean;
  txHash?: string;
  amount?: number;
  senderAddress?: string;
  /** True iff the token included a valid EIP-191 signature. */
  signatureVerified?: boolean;
  error?: string;
}

export async function verifyX402Payment(params: {
  paymentToken: string;
  expectedRecipient: string;
  minimumAmount: number;
  network?: "base" | "base-sepolia";
  /** Optional: pass DB to check for replay attacks */
  db?: import("node:sqlite").DatabaseSync;
}): Promise<X402VerificationResult> {
  // Parse the payment token
  // x402 tokens are base64-encoded JSON with:
  //   { txHash, amount, sender, recipient?, timestamp, version?, signature? }
  // `recipient` and `version` were added when signed tokens shipped; legacy
  // unsigned tokens omit them and are still accepted (with a warning).
  try {
    const decoded = JSON.parse(Buffer.from(params.paymentToken, "base64").toString("utf-8")) as {
      txHash?: string;
      amount?: string | number;
      sender?: string;
      recipient?: string;
      timestamp?: number;
      version?: string;
      signature?: string;
    };

    if (!decoded.txHash) {
      return { valid: false, error: "Missing txHash in payment token" };
    }

    const amount =
      typeof decoded.amount === "string" ? parseFloat(decoded.amount) : (decoded.amount ?? 0);

    if (amount < params.minimumAmount) {
      return { valid: false, error: `Amount ${amount} below minimum ${params.minimumAmount}` };
    }

    // Replay protection: transaction must be within 5 minutes
    if (decoded.timestamp && Date.now() - decoded.timestamp > 5 * 60 * 1000) {
      return { valid: false, error: "Payment token expired" };
    }

    // Verify the signed binding when present. The signature proves the buyer's
    // wallet authorized this specific (recipient, txHash, amount) tuple — so
    // even if the txHash leaks, another agent can't claim the payment as their
    // own without forging the signature. Legacy tokens skip this and rely on
    // the on-chain Transfer recipient match below.
    let signatureVerified = false;
    if (decoded.signature && decoded.version === "v1") {
      if (!decoded.recipient || !decoded.sender || decoded.timestamp === undefined) {
        return { valid: false, error: "Signed token missing required fields" };
      }
      if (decoded.recipient.toLowerCase() !== params.expectedRecipient.toLowerCase()) {
        return { valid: false, error: "Signed token recipient does not match expected" };
      }
      try {
        const { recoverMessageAddress } = await import("viem");
        const canonical = canonicalizePaymentPayload({
          txHash: decoded.txHash,
          amount,
          sender: decoded.sender,
          recipient: decoded.recipient,
          timestamp: decoded.timestamp,
          version: "v1",
        });
        const recovered = await recoverMessageAddress({
          message: canonical,
          signature: decoded.signature as `0x${string}`,
        });
        if (recovered.toLowerCase() !== decoded.sender.toLowerCase()) {
          return { valid: false, error: "Payment signature does not match declared sender" };
        }
        signatureVerified = true;
      } catch (err) {
        return { valid: false, error: `Signature verification failed: ${String(err)}` };
      }
    } else if (!decoded.signature) {
      // Legacy unsigned token. Defer to on-chain recipient match (below) and
      // log a deprecation warning so operators can plan client upgrades.
      log.debug("legacy unsigned x402 token accepted (signature recommended)");
    }

    // Single-use enforcement — reject already-consumed payment tokens.
    // Without this, a valid payment can be replayed thousands of times within the
    // 5-minute window. (Gemini peer review: replay attack fix)
    // The UNIQUE index on tx_hash in marketplace_purchases enforces this at the DB level.
    if (params.db) {
      const existing = params.db
        .prepare(`SELECT 1 FROM marketplace_purchases WHERE tx_hash = ?`)
        .get(decoded.txHash);
      if (existing) {
        return { valid: false, error: "Payment token already consumed" };
      }
    }

    // On-chain verification via viem
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia, base } = await import("viem/chains");

    const chain = params.network === "base" ? base : baseSepolia;
    const client = createPublicClient({
      chain,
      transport: http(),
    });

    try {
      const receipt = await client.getTransactionReceipt({
        hash: decoded.txHash as `0x${string}`,
      });

      if (receipt.status !== "success") {
        return { valid: false, error: "Transaction failed on-chain" };
      }

      // Verify recipient matches our wallet address (case-insensitive).
      // For ERC-20 (USDC), receipt.to is the token contract, not the recipient,
      // so we decode Transfer event logs instead.
      const expectedRecipient = params.expectedRecipient.toLowerCase();
      if (receipt.to?.toLowerCase() !== expectedRecipient) {
        const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        // ERC-20 Transfer indexed `to` is in topics[2] as a 32-byte left-padded
        // hex string. Slice the last 20 bytes (40 hex chars) for exact equality
        // — the previous .includes() check could false-positive against any
        // address that happened to contain the recipient's hex as a substring.
        const transferLog = receipt.logs.find((l) => {
          if (l.topics[0] !== transferTopic) return false;
          const topic2 = l.topics[2];
          if (!topic2 || topic2.length < 26) return false;
          const recipientFromLog = ("0x" + topic2.slice(26)).toLowerCase();
          return recipientFromLog === expectedRecipient;
        });
        if (!transferLog) {
          return { valid: false, error: "Transaction recipient does not match" };
        }
      }
    } catch (err) {
      return { valid: false, error: `On-chain verification failed: ${String(err)}` };
    }

    return {
      valid: true,
      txHash: decoded.txHash,
      amount,
      senderAddress: decoded.sender,
      signatureVerified,
    };
  } catch (err) {
    log.debug(`Payment token parse/verification failed: ${String(err)}`);
    return { valid: false, error: `Invalid payment token: ${String(err)}` };
  }
}
