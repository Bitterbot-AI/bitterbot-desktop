/**
 * PLAN-29 Phase 1.1: bounty funding validator.
 *
 * v2 (Forage) bounties land in `bounty_posts` as 'unverified' (the Rust
 * ingest gate checked structure + poster signature only). This module does
 * the economic half: it validates the `funding_proof` against the chain and
 * promotes rows to 'open' — the only status the directory scan, claims, and
 * dream-mode hunting are allowed to touch. Nothing downstream may ever treat
 * 'unverified' funding as real demand.
 *
 * Proof formats:
 *  - "attest:<sig>" — poster asserts solvency; we verify by reading the
 *    poster wallet's live USDC balance (>= reward). Cheap, revocable-by-
 *    spending, good enough for small one-shots; re-checked on every sweep
 *    while the bounty is open is Phase 2 hardening.
 *  - "eip3009:<base64 JSON>" — a signed transferWithAuthorization blob.
 *    Structurally validated here (from == poster wallet, value >= reward,
 *    validBefore in the future). Capture-side verification happens at
 *    settlement time.
 *
 * Decisions are conservative: malformed or underfunded proofs reject the
 * row ('rejected'); transient RPC failures leave it 'unverified' for the
 * next sweep. The balance reader is injected so tests never touch Base
 * (same pattern as Aubaine's SettlementExecutor).
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/bounty-funding");

export const USDC_CONTRACTS: Record<string, `0x${string}`> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** Returns the wallet's USDC balance in whole USDC (6-decimal adjusted). */
export type UsdcBalanceReader = (wallet: string) => Promise<number>;

/** Live viem-backed balance reader. Lazy-imports viem off the hot path. */
export function createUsdcBalanceReader(network: "base" | "base-sepolia"): UsdcBalanceReader {
  return async (wallet: string): Promise<number> => {
    const { createPublicClient, http } = await import("viem");
    const chains = await import("viem/chains");
    const client = createPublicClient({
      chain: network === "base" ? chains.base : chains.baseSepolia,
      transport: http(),
    });
    const raw = (await client.readContract({
      address: USDC_CONTRACTS[network],
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [wallet as `0x${string}`],
    })) as bigint;
    return Number(raw) / 1e6;
  };
}

type PendingRow = {
  bounty_id: string;
  poster_wallet: string;
  reward_usdc: number;
  funding_proof: string | null;
  expires_at: number;
};

export type FundingSweepResult = {
  promoted: number;
  rejected: number;
  /** Transient failures left 'unverified' for the next sweep. */
  deferred: number;
  expired: number;
};

/** Structural check of an eip3009:<base64 JSON> proof. */
function validateEip3009Proof(
  proof: string,
  posterWallet: string,
  rewardUsdc: number,
  now: number,
): { ok: boolean; reason?: string } {
  let decoded: {
    from?: string;
    value?: string | number;
    validBefore?: string | number;
  };
  try {
    decoded = JSON.parse(Buffer.from(proof.slice("eip3009:".length), "base64").toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed eip3009 payload" };
  }
  if (!decoded.from || decoded.from.toLowerCase() !== posterWallet.toLowerCase()) {
    return { ok: false, reason: "auth signer is not the poster wallet" };
  }
  const value = Number(decoded.value ?? 0);
  if (!(value >= rewardUsdc * 1e6)) {
    return { ok: false, reason: `auth value ${value} below reward` };
  }
  const validBefore = Number(decoded.validBefore ?? 0);
  if (!(validBefore * 1000 > now)) {
    return { ok: false, reason: "authorization already expired" };
  }
  return { ok: true };
}

/**
 * One validation sweep over 'unverified' bounty rows. Called from the
 * consolidation tick; bounded by `limit` per pass and yields between rows
 * via the awaited balance reads (event-loop starvation rule).
 */
export async function validatePendingBounties(opts: {
  db: DatabaseSync;
  readBalance: UsdcBalanceReader;
  now?: number;
  limit?: number;
}): Promise<FundingSweepResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 25;
  const result: FundingSweepResult = { promoted: 0, rejected: 0, deferred: 0, expired: 0 };

  const rows = opts.db
    .prepare(
      `SELECT bounty_id, poster_wallet, reward_usdc, funding_proof, expires_at
         FROM bounty_posts WHERE status = 'unverified' ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as unknown as PendingRow[];

  const setStatus = opts.db.prepare(
    `UPDATE bounty_posts SET status = ?, updated_at = ? WHERE bounty_id = ? AND status = 'unverified'`,
  );

  for (const row of rows) {
    if (row.expires_at <= now) {
      setStatus.run("expired", now, row.bounty_id);
      result.expired++;
      continue;
    }
    const proof = row.funding_proof ?? "";
    if (proof.startsWith("eip3009:")) {
      const check = validateEip3009Proof(proof, row.poster_wallet, row.reward_usdc, now);
      if (check.ok) {
        setStatus.run("open", now, row.bounty_id);
        result.promoted++;
      } else {
        log.info(`Rejecting bounty ${row.bounty_id}: ${check.reason}`);
        setStatus.run("rejected", now, row.bounty_id);
        result.rejected++;
      }
      continue;
    }
    if (proof.startsWith("attest:")) {
      try {
        const balance = await opts.readBalance(row.poster_wallet);
        if (balance >= row.reward_usdc) {
          setStatus.run("open", now, row.bounty_id);
          result.promoted++;
        } else {
          log.info(
            `Rejecting bounty ${row.bounty_id}: poster balance $${balance} < reward $${row.reward_usdc}`,
          );
          setStatus.run("rejected", now, row.bounty_id);
          result.rejected++;
        }
      } catch (err) {
        // RPC hiccup: not the poster's fault — try again next sweep.
        log.debug(`Deferring bounty ${row.bounty_id}: balance read failed (${String(err)})`);
        result.deferred++;
      }
      continue;
    }
    log.info(`Rejecting bounty ${row.bounty_id}: unknown funding proof scheme`);
    setStatus.run("rejected", now, row.bounty_id);
    result.rejected++;
  }

  if (result.promoted || result.rejected || result.expired) {
    log.info(
      `Funding sweep: ${result.promoted} open, ${result.rejected} rejected, ` +
        `${result.expired} expired, ${result.deferred} deferred`,
    );
  }
  return result;
}
