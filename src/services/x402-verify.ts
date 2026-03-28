/**
 * Verify x402 payment receipts on Base.
 *
 * When a buyer agent pays for a skill via x402, it includes a payment
 * token/receipt in the request headers. This module verifies:
 * 1. The transaction exists on-chain
 * 2. The recipient matches our wallet address
 * 3. The amount meets the minimum requirement
 * 4. The transaction is recent (within 5 minutes to prevent replay)
 *
 * On-chain verification via viem is MANDATORY even on testnet.
 * Without it, a 10-line script can spam spoofed payment tokens and corrupt
 * all economic data. (Gemini peer review: "Trust Me" exploit fix)
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("x402-verify");

export interface X402VerificationResult {
  valid: boolean;
  txHash?: string;
  amount?: number;
  senderAddress?: string;
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
  // x402 tokens are base64-encoded JSON with: { txHash, chain, amount, sender, timestamp, signature }
  try {
    const decoded = JSON.parse(
      Buffer.from(params.paymentToken, "base64").toString("utf-8"),
    ) as {
      txHash?: string;
      amount?: string | number;
      sender?: string;
      timestamp?: number;
    };

    if (!decoded.txHash) {
      return { valid: false, error: "Missing txHash in payment token" };
    }

    const amount = typeof decoded.amount === "string"
      ? parseFloat(decoded.amount)
      : decoded.amount ?? 0;

    if (amount < params.minimumAmount) {
      return { valid: false, error: `Amount ${amount} below minimum ${params.minimumAmount}` };
    }

    // Replay protection: transaction must be within 5 minutes
    if (decoded.timestamp && Date.now() - decoded.timestamp > 5 * 60 * 1000) {
      return { valid: false, error: "Payment token expired" };
    }

    // Single-use enforcement — reject already-consumed payment tokens.
    // Without this, a valid payment can be replayed thousands of times within the
    // 5-minute window. (Gemini peer review: replay attack fix)
    // The UNIQUE index on tx_hash in marketplace_purchases enforces this at the DB level.
    if (params.db) {
      const existing = params.db.prepare(
        `SELECT 1 FROM marketplace_purchases WHERE tx_hash = ?`,
      ).get(decoded.txHash);
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

      // Verify recipient matches our wallet address (case-insensitive)
      if (receipt.to?.toLowerCase() !== params.expectedRecipient.toLowerCase()) {
        // For ERC-20 (USDC), the `to` field is the token contract, not the recipient.
        // Check Transfer event logs for actual recipient.
        const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const transferLog = receipt.logs.find(
          (l) => l.topics[0] === transferTopic &&
                 l.topics[2]?.toLowerCase().includes(params.expectedRecipient.slice(2).toLowerCase()),
        );
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
    };
  } catch (err) {
    log.debug(`Payment token parse/verification failed: ${String(err)}`);
    return { valid: false, error: `Invalid payment token: ${String(err)}` };
  }
}
