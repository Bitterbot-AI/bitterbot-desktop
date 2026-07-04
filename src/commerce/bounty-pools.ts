/**
 * PLAN-29 Phase 4 (LEGAL-GATED, flag-off by default): bounty pools.
 *
 * Kickstarter for answers: N funders each sign a small EIP-3009
 * authorization naming the eventual hunter's wallet as recipient is
 * impossible pre-award, so pool auths are signed AT AWARD TIME against
 * the winning hunter and captured only when BOTH conditions hold:
 * quorum (pledged total covers the reward) AND oracle pass. Below
 * quorum or on fail, nothing is ever captured — funders who backed a
 * pool that never strikes were never charged (Aubaine confirm-then-
 * capture, reused as designed).
 *
 * Structurally non-custodial: every captured transfer moves
 * funder-wallet -> hunter-wallet directly on USDC. This module relays
 * signatures and submits gas-only capture transactions; it can never
 * hold or redirect funds. Signers can cancelAuthorization on-chain
 * before capture, so strike results are per-auth best-effort and
 * recorded as such.
 *
 * GA gate: `forage.pools.enabled` stays false until payments counsel
 * review (PLAN-26 precedent). The flag flip is its own reviewed commit.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { Eip3009Authorization, SettlementExecutor } from "./settlement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("commerce/bounty-pools");

export type PoolPledge = {
  bountyId: string;
  funderPubkey: string;
  /** Signed EIP-3009 authorization (recipient = awarded hunter wallet). */
  auth: Eip3009Authorization;
};

export type PledgeOutcome =
  | { ok: true; pledgedUsdc: number; quorumUsdc: number; quorumReached: boolean }
  | { ok: false; error: string };

/**
 * Record one funder's signed authorization toward an open pool bounty.
 * Validation is structural (the chain validates economically at capture):
 * recipient must be the awarded hunter's wallet, value positive, not
 * expired, one pledge per funder wallet per bounty.
 */
export function recordPoolPledge(
  db: DatabaseSync,
  pledge: PoolPledge,
  now: number = Date.now(),
): PledgeOutcome {
  const bounty = db
    .prepare(
      `SELECT b.bounty_id, b.status, b.kind, b.reward_usdc, c.hunter_wallet
         FROM bounty_posts b
         LEFT JOIN bounty_claims c
           ON c.bounty_id = b.bounty_id AND c.status IN ('claimed','delivered','verified')
        WHERE b.bounty_id = ?`,
    )
    .get(pledge.bountyId) as
    | {
        bounty_id: string;
        status: string;
        kind: string;
        reward_usdc: number;
        hunter_wallet: string | null;
      }
    | undefined;
  if (!bounty || bounty.kind !== "pool") {
    return { ok: false, error: "Unknown pool bounty" };
  }
  if (bounty.status !== "open") {
    return { ok: false, error: `Pool is not open (status: ${bounty.status})` };
  }
  if (!bounty.hunter_wallet) {
    return { ok: false, error: "Pool has no awarded hunter yet; pledges are signed at award" };
  }
  const auth = pledge.auth;
  if (auth.to.toLowerCase() !== bounty.hunter_wallet.toLowerCase()) {
    return { ok: false, error: "Authorization recipient is not the awarded hunter wallet" };
  }
  const amountUsdc = Number(auth.value) / 1e6;
  if (!(amountUsdc > 0)) {
    return { ok: false, error: "Authorization value must be positive" };
  }
  if (auth.validBefore * 1000 <= now) {
    return { ok: false, error: "Authorization already expired" };
  }
  try {
    db.prepare(
      `INSERT INTO bounty_pool_auths
         (id, bounty_id, funder_pubkey, funder_wallet, amount_usdc, auth_json,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pledged', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      pledge.bountyId,
      pledge.funderPubkey,
      auth.from,
      amountUsdc,
      JSON.stringify(auth),
      now,
      now,
    );
  } catch {
    return { ok: false, error: "This wallet already pledged to this pool" };
  }
  const pledged = pledgedTotal(db, pledge.bountyId);
  return {
    ok: true,
    pledgedUsdc: pledged,
    quorumUsdc: bounty.reward_usdc,
    quorumReached: pledged >= bounty.reward_usdc,
  };
}

function pledgedTotal(db: DatabaseSync, bountyId: string): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS v FROM bounty_pool_auths
          WHERE bounty_id = ? AND status = 'pledged'`,
      )
      .get(bountyId) as { v: number }
  ).v;
}

export type StrikeResult = {
  struck: number;
  captured: number;
  captureFailed: number;
  usdCaptured: number;
  belowQuorum: number;
};

/**
 * Capture sweep for pool bounties whose oracle already passed
 * (bounty_settlements has the pass verdict) AND whose pledges cover the
 * reward. Captures each auth individually; per-auth failures (cancelled,
 * drained wallet) are recorded and never block sibling captures.
 */
export async function strikeReadyPools(opts: {
  db: DatabaseSync;
  executor: SettlementExecutor;
  now?: number;
  limit?: number;
}): Promise<StrikeResult> {
  const now = opts.now ?? Date.now();
  const result: StrikeResult = {
    struck: 0,
    captured: 0,
    captureFailed: 0,
    usdCaptured: 0,
    belowQuorum: 0,
  };
  const ready = opts.db
    .prepare(
      `SELECT DISTINCT b.bounty_id, b.reward_usdc
         FROM bounty_posts b
         JOIN bounty_settlements s
           ON s.bounty_id = b.bounty_id AND s.oracle_verdict = 'pass'
        WHERE b.kind = 'pool' AND b.is_local = 1
          AND EXISTS (SELECT 1 FROM bounty_pool_auths a
                       WHERE a.bounty_id = b.bounty_id AND a.status = 'pledged')
        LIMIT ?`,
    )
    .all(opts.limit ?? 5) as unknown as Array<{ bounty_id: string; reward_usdc: number }>;

  for (const pool of ready) {
    if (pledgedTotal(opts.db, pool.bounty_id) < pool.reward_usdc) {
      result.belowQuorum++;
      continue; // confirm-then-capture: below quorum, capture NOTHING
    }
    const auths = opts.db
      .prepare(
        `SELECT id, auth_json FROM bounty_pool_auths
          WHERE bounty_id = ? AND status = 'pledged'`,
      )
      .all(pool.bounty_id) as unknown as Array<{ id: string; auth_json: string }>;
    result.struck++;
    for (const row of auths) {
      try {
        const auth = JSON.parse(row.auth_json) as Eip3009Authorization;
        const { txHash } = await opts.executor.capture(auth);
        opts.db
          .prepare(
            `UPDATE bounty_pool_auths SET status = 'captured', tx_hash = ?, updated_at = ? WHERE id = ?`,
          )
          .run(txHash, now, row.id);
        result.captured++;
        result.usdCaptured += Number(auth.value) / 1e6;
      } catch (err) {
        opts.db
          .prepare(
            `UPDATE bounty_pool_auths SET status = 'capture_failed', error = ?, updated_at = ? WHERE id = ?`,
          )
          .run(String(err), now, row.id);
        result.captureFailed++;
        log.warn(`Pool auth capture failed on ${pool.bounty_id}: ${String(err)}`);
      }
    }
    log.info(
      `Pool ${pool.bounty_id} struck: ${result.captured} captures ` +
        `($${result.usdCaptured.toFixed(2)}), ${result.captureFailed} failed`,
    );
  }
  return result;
}
