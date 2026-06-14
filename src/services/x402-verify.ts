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
 * 4. The Transfer log is emitted by the canonical USDC contract for the chain,
 *    and its value is >= the declared amount (binds the token's declared amount
 *    to the actual on-chain transfer; otherwise a real $0.0001 transfer can be
 *    declared as $1000 and inflate accounting). The declared amount must also
 *    be >= the configured minimum.
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

/**
 * Atomically claim a tx_hash for single-use enforcement.
 *
 * Creates the ledger table on first use, then attempts an INSERT. Returns true
 * if this call won the claim (row inserted), false if the tx_hash was already
 * consumed (UNIQUE constraint violation). This is the race-free authority for
 * single-use: even under N concurrent verifications of the same token, the DB's
 * UNIQUE constraint guarantees exactly one INSERT succeeds.
 */
function claimTxHashAtomically(
  db: import("node:sqlite").DatabaseSync,
  txHash: string,
): boolean {
  db.exec(
    `CREATE TABLE IF NOT EXISTS x402_consumed_tx (
       tx_hash TEXT PRIMARY KEY,
       consumed_at INTEGER NOT NULL
     )`,
  );
  try {
    db.prepare(`INSERT INTO x402_consumed_tx (tx_hash, consumed_at) VALUES (?, ?)`).run(
      txHash,
      Date.now(),
    );
    return true;
  } catch (err) {
    // UNIQUE/PRIMARY KEY violation => another request already consumed this tx.
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}

// Canonical USDC contract addresses on Base. Pinning these here lets us reject
// Transfer events emitted by attacker-deployed fake tokens — without this, a
// recipient-matching Transfer from any contract would pass verification.
const USDC_CONTRACT: Record<"base" | "base-sepolia", string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const USDC_DECIMALS = 6;

function declaredAmountToBaseUnits(amount: number): bigint {
  // amount is human USDC (e.g. 0.05). Multiply to 6-decimal base units with
  // rounding so floating-point representation of "0.05" doesn't truncate to
  // 49999 base units.
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

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

    // Replay protection: every token MUST carry a timestamp and fall within the
    // 5-minute window. Previously this was `if (decoded.timestamp && ...)`, so a
    // token that simply OMITTED `timestamp` skipped the expiry check entirely —
    // letting an attacker replay an old on-chain transfer indefinitely on the
    // unsigned path. Require the field unconditionally and fail closed.
    if (typeof decoded.timestamp !== "number" || !Number.isFinite(decoded.timestamp)) {
      return { valid: false, error: "Payment token missing required timestamp" };
    }
    if (Date.now() - decoded.timestamp > 5 * 60 * 1000) {
      return { valid: false, error: "Payment token expired" };
    }
    // Reject tokens dated in the future (clock-skew / pre-dating abuse).
    if (decoded.timestamp - Date.now() > 60 * 1000) {
      return { valid: false, error: "Payment token timestamp is in the future" };
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
    // This cheap pre-check rejects obvious replays early, but it is NOT the
    // authority: a SELECT here followed by an INSERT later in the caller is a
    // check-then-act (TOCTOU) gap that two concurrent requests can both pass.
    // The authoritative, race-free claim happens after all checks succeed, via
    // claimTxHashAtomically() below (atomic INSERT into a dedicated ledger).
    if (params.db) {
      // The ledger table may not exist yet on a fresh DB; it is created lazily
      // by claimTxHashAtomically(). A missing table simply means "nothing
      // consumed yet", so tolerate it here rather than throwing.
      let existing: unknown;
      try {
        existing = params.db
          .prepare(`SELECT 1 FROM x402_consumed_tx WHERE tx_hash = ?`)
          .get(decoded.txHash.toLowerCase());
      } catch {
        existing = undefined;
      }
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

      // Require a USDC Transfer log to our recipient with value >= declared
      // amount. Three independent checks bound together:
      //   (a) `log.address` is the canonical USDC contract for this chain —
      //       blocks fake-token Transfer events emitted by attacker contracts.
      //   (b) `topics[2]` (indexed `to`) equals expectedRecipient, exact match
      //       on the last 20 bytes — blocks the substring false-positive that
      //       a prior version had.
      //   (c) `log.data` (non-indexed `value`) >= declared amount in base units
      //       — blocks the "real $0.0001 transfer, declared $1000" inflation
      //       (#38). Declared amount has already been checked vs minimumAmount.
      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const expectedRecipient = params.expectedRecipient.toLowerCase();
      const expectedToken = USDC_CONTRACT[params.network ?? "base-sepolia"];
      const declaredBaseUnits = declaredAmountToBaseUnits(amount);

      const transferLog = receipt.logs.find((l) => {
        if (l.address?.toLowerCase() !== expectedToken) return false;
        if (l.topics[0] !== transferTopic) return false;
        const topic2 = l.topics[2];
        if (!topic2 || topic2.length < 26) return false;
        const recipientFromLog = ("0x" + topic2.slice(26)).toLowerCase();
        return recipientFromLog === expectedRecipient;
      });
      if (!transferLog) {
        return {
          valid: false,
          error: "No USDC Transfer log to expected recipient in transaction",
        };
      }

      let onChainBaseUnits: bigint;
      try {
        onChainBaseUnits = BigInt(transferLog.data);
      } catch {
        return { valid: false, error: "Malformed Transfer log value" };
      }
      if (onChainBaseUnits < declaredBaseUnits) {
        return {
          valid: false,
          error: `On-chain Transfer value ${onChainBaseUnits} below declared amount ${declaredBaseUnits} (USDC base units)`,
        };
      }
    } catch (err) {
      return { valid: false, error: `On-chain verification failed: ${String(err)}` };
    }

    // Authoritative single-use claim. All verification has passed; now atomically
    // record the tx_hash so that no other concurrent request can also succeed.
    // This closes the TOCTOU window left by the SELECT-only pre-check above: the
    // UNIQUE constraint on x402_consumed_tx means exactly one of N concurrent
    // verifications of the same token wins the INSERT; the rest fail and are
    // reported as already consumed. The dedicated ledger is used (rather than
    // marketplace_purchases) because verify does not yet know the skill/buyer/
    // amount columns that table requires NOT NULL at purchase-record time.
    if (params.db) {
      const claimed = claimTxHashAtomically(params.db, decoded.txHash.toLowerCase());
      if (!claimed) {
        return { valid: false, error: "Payment token already consumed" };
      }
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
