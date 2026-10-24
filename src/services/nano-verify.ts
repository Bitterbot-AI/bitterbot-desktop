/**
 * Verify Nano (XNO) payment proofs for the A2A payment gate.
 *
 * Opt-in second rail next to x402 on Base (a2a.payment.nano). Mirrors
 * x402-verify.ts: the buyer sends a base64 JSON token in the same payment
 * headers, and this module checks:
 * 1. The token is signed (Ed25519 with BLAKE2b, Nano's account key scheme) by
 *    the paying account over `recipient|blockHash|amountRaw|timestamp`, so a
 *    leaked block hash can't be redeemed by someone else.
 * 2. The token is recent (within maxAgeSeconds) and the recipient is ours.
 * 3. ONE `block_info` call to the configured node: the block is a confirmed
 *    send, from the declared account, to our account, for at least the price
 *    converted at the configured rawPerUsd rate (BigInt, never floats), and
 *    the node saw it within maxAgeSeconds.
 * 4. The block hash hasn't been consumed before (same atomic ledger as x402,
 *    key `nano:<HASH>`).
 *
 * Any RPC error, timeout or non-200 response means "not paid".
 */

import { twistedEdwards } from "@noble/curves/abstract/edwards";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { claimTxHashAtomically } from "./x402-verify.js";

const log = createSubsystemLogger("nano-verify");

/** Network id used in the 402 accepts entry and in payment tokens. */
export const NANO_NETWORK = "nano:mainnet";
/** Default RPC endpoint: a node the operator runs locally (standard Nano RPC port). */
export const NANO_DEFAULT_RPC_URL = "http://127.0.0.1:7076";
export const NANO_DEFAULT_MAX_AGE_SECONDS = 300;
const RPC_TIMEOUT_MS = 10_000;

const ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";

/** Ed25519 with BLAKE2b-512 in place of SHA-512, as used by Nano accounts. */
const ed25519Blake2b = twistedEdwards({ ...ed25519.CURVE, hash: blake2b });

function decodeBase32(s: string): bigint | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = (n << 5n) | BigInt(v);
  }
  return n;
}

function bigintToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Decode a `nano_` (or legacy `xrb_`) account to its 32-byte public key,
 * verifying the 5-byte BLAKE2b checksum. Returns null when malformed.
 */
export function nanoAccountToPublicKey(account: string): Uint8Array | null {
  const m = /^(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{59})$/.exec(account);
  if (!m) return null;
  const body = m[1]!;
  const keyBits = decodeBase32(body.slice(0, 52));
  const checkBits = decodeBase32(body.slice(52));
  if (keyBits === null || checkBits === null || keyBits >> 256n !== 0n) return null;
  const publicKey = bigintToBytes(keyBits, 32);
  const checksum = blake2b(publicKey, { dkLen: 5 }).toReversed();
  const declared = bigintToBytes(checkBits, 5);
  return checksum.every((b, i) => b === declared[i]) ? publicKey : null;
}

function encodeBase32(bytes: Uint8Array, chars: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** Encode a 32-byte public key as a checksummed `nano_` account. */
export function publicKeyToNanoAccount(publicKey: Uint8Array): string {
  const checksum = blake2b(publicKey, { dkLen: 5 }).toReversed();
  return `nano_${encodeBase32(publicKey, 52)}${encodeBase32(checksum, 8)}`;
}

export function isValidNanoAccount(account: string): boolean {
  return nanoAccountToPublicKey(account) !== null;
}

function sameAccount(a: string, b: string): boolean {
  const ka = nanoAccountToPublicKey(a);
  const kb = nanoAccountToPublicKey(b);
  return !!ka && !!kb && ka.every((x, i) => x === kb[i]);
}

export type NanoRailConfig = {
  address: string;
  rawPerUsd: string;
  rpcUrl?: string;
  maxAgeSeconds?: number;
};

/**
 * The configured Nano rail, or undefined when it is off. The schema checks the
 * account's shape; the checksum is checked here so a typo'd address never gets
 * advertised to buyers.
 */
export function resolveNanoRail(cfg: NanoRailConfig | undefined): NanoRailConfig | undefined {
  if (!cfg?.address || !cfg.rawPerUsd || !/^[1-9][0-9]*$/.test(cfg.rawPerUsd)) return undefined;
  if (!isValidNanoAccount(cfg.address)) {
    log.warn("a2a.payment.nano.address fails its checksum; Nano payments stay off");
    return undefined;
  }
  return cfg;
}

/** The exact bytes the payer signs. */
export function nanoPaymentMessage(p: {
  recipient: string;
  blockHash: string;
  amountRaw: string;
  timestamp: number;
}): string {
  return `${p.recipient}|${p.blockHash.toUpperCase()}|${p.amountRaw}|${p.timestamp}`;
}

/** USD price -> raw, rounded UP so a payment can never be a fraction short. */
export function usdToRaw(usd: number, rawPerUsd: string): bigint {
  const microUsd = BigInt(Math.round(usd * 1_000_000));
  return (microUsd * BigInt(rawPerUsd) + 999_999n) / 1_000_000n;
}

export interface NanoVerificationResult {
  valid: boolean;
  blockHash?: string;
  amountRaw?: string;
  senderAccount?: string;
  error?: string;
}

type BlockInfo = {
  error?: string;
  block_account?: string;
  amount?: string;
  local_timestamp?: string;
  confirmed?: string | boolean;
  subtype?: string;
  contents?: { type?: string; link_as_account?: string };
};

export async function verifyNanoPayment(params: {
  paymentToken: string;
  /** Our nano_ receiving account (a2a.payment.nano.address). */
  expectedRecipient: string;
  /** Price in USD; converted with rawPerUsd. */
  minimumUsd: number;
  /** Raw (10^-30 XNO) per 1 USD, as a decimal integer string. */
  rawPerUsd: string;
  rpcUrl?: string;
  maxAgeSeconds?: number;
  db?: import("node:sqlite").DatabaseSync;
}): Promise<NanoVerificationResult> {
  try {
    const decoded = JSON.parse(Buffer.from(params.paymentToken, "base64").toString("utf-8")) as {
      network?: string;
      blockHash?: string;
      account?: string;
      recipient?: string;
      amountRaw?: string;
      timestamp?: number;
      signature?: string;
    };
    if (decoded.network !== NANO_NETWORK) {
      return { valid: false, error: "Not a Nano payment token" };
    }
    if (typeof decoded.blockHash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(decoded.blockHash)) {
      return { valid: false, error: "Malformed block hash" };
    }
    const blockHash = decoded.blockHash.toUpperCase();
    if (typeof decoded.account !== "string" || !isValidNanoAccount(decoded.account)) {
      return { valid: false, error: "Invalid sender account" };
    }
    if (typeof decoded.recipient !== "string" || !isValidNanoAccount(decoded.recipient)) {
      return { valid: false, error: "Invalid recipient account" };
    }
    if (!sameAccount(decoded.recipient, params.expectedRecipient)) {
      return { valid: false, error: "Signed token recipient does not match expected" };
    }
    if (typeof decoded.amountRaw !== "string" || !/^[1-9][0-9]{0,39}$/.test(decoded.amountRaw)) {
      return { valid: false, error: "Malformed amountRaw" };
    }
    const required = usdToRaw(params.minimumUsd, params.rawPerUsd);
    if (BigInt(decoded.amountRaw) < required) {
      return { valid: false, error: `Amount ${decoded.amountRaw} raw below required ${required}` };
    }

    const maxAgeMs = (params.maxAgeSeconds ?? NANO_DEFAULT_MAX_AGE_SECONDS) * 1000;
    if (typeof decoded.timestamp !== "number" || !Number.isFinite(decoded.timestamp)) {
      return { valid: false, error: "Payment token missing required timestamp" };
    }
    if (Date.now() - decoded.timestamp > maxAgeMs) {
      return { valid: false, error: "Payment token expired" };
    }
    if (decoded.timestamp - Date.now() > 60 * 1000) {
      return { valid: false, error: "Payment token timestamp is in the future" };
    }

    if (typeof decoded.signature !== "string" || !/^[0-9A-Fa-f]{128}$/.test(decoded.signature)) {
      return { valid: false, error: "Payment proof is not signed by the payer" };
    }
    const message = new TextEncoder().encode(
      nanoPaymentMessage({
        recipient: decoded.recipient,
        blockHash,
        amountRaw: decoded.amountRaw,
        timestamp: decoded.timestamp,
      }),
    );
    let sigOk = false;
    try {
      sigOk = ed25519Blake2b.verify(
        decoded.signature,
        message,
        nanoAccountToPublicKey(decoded.account)!,
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return { valid: false, error: "Payment signature does not match declared sender" };
    }

    const ledgerKey = `nano:${blockHash}`;
    // Cheap pre-check; the authoritative claim is the atomic INSERT below.
    if (params.db) {
      let existing: unknown;
      try {
        existing = params.db
          .prepare(`SELECT 1 FROM x402_consumed_tx WHERE tx_hash = ?`)
          .get(ledgerKey);
      } catch {
        existing = undefined;
      }
      if (existing) {
        return { valid: false, error: "Payment token already consumed" };
      }
    }

    let info: BlockInfo;
    try {
      const res = await fetch(params.rpcUrl ?? NANO_DEFAULT_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "block_info", json_block: "true", hash: blockHash }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { valid: false, error: `Nano RPC returned HTTP ${res.status}` };
      }
      info = (await res.json()) as BlockInfo;
    } catch (err) {
      return { valid: false, error: `Nano RPC failed: ${String(err)}` };
    }
    if (!info || typeof info !== "object" || info.error) {
      return { valid: false, error: `Nano RPC error: ${info?.error ?? "empty response"}` };
    }
    if (info.confirmed !== "true" && info.confirmed !== true) {
      return { valid: false, error: "Block is not confirmed" };
    }
    if (info.contents?.type !== "state" || info.subtype !== "send") {
      return { valid: false, error: "Block is not a send" };
    }
    if (
      typeof info.block_account !== "string" ||
      !sameAccount(info.block_account, decoded.account)
    ) {
      return { valid: false, error: "Block was not sent by the declared account" };
    }
    const dest = info.contents.link_as_account;
    if (typeof dest !== "string" || !sameAccount(dest, params.expectedRecipient)) {
      return { valid: false, error: "Block does not pay the expected recipient" };
    }
    if (typeof info.amount !== "string" || !/^[0-9]{1,40}$/.test(info.amount)) {
      return { valid: false, error: "Malformed block amount" };
    }
    const onChain = BigInt(info.amount);
    if (onChain < required || onChain !== BigInt(decoded.amountRaw)) {
      return {
        valid: false,
        error: `Block amount ${onChain} raw does not cover declared ${decoded.amountRaw} / required ${required}`,
      };
    }
    const seenAt = Number(info.local_timestamp);
    if (!Number.isFinite(seenAt) || seenAt <= 0 || Date.now() - seenAt * 1000 > maxAgeMs) {
      return { valid: false, error: "Block is too old" };
    }

    if (params.db && !claimTxHashAtomically(params.db, ledgerKey)) {
      return { valid: false, error: "Payment token already consumed" };
    }

    return {
      valid: true,
      blockHash,
      amountRaw: info.amount,
      senderAccount: decoded.account,
    };
  } catch (err) {
    log.debug(`Nano payment token parse/verification failed: ${String(err)}`);
    return { valid: false, error: `Invalid payment token: ${String(err)}` };
  }
}
