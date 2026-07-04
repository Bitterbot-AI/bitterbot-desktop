/**
 * PLAN-29 Phase 2.1: heartbeat stream payouts.
 *
 * Streams are the Forage economy's volume engine: one heartbeat bounty
 * generates a settlement-bearing check every cadence interval for as long
 * as the budget lasts. Check-ins arrive via forage/checkin (chained
 * observation hashes, cadence-guarded); this sweep converts unpaid checks
 * into money on the existing revenue rail.
 *
 * Payouts are BATCHED per stream per sweep (one queued payment covering
 * all unpaid checks) rather than queued per check: the transaction *count*
 * the economy optimizes for is the check-ins themselves, while on-chain
 * dispatch stays gas-sane. The bounty's reward_usdc is the stream's total
 * budget; when spent, the stream completes, the claim verifies, and the
 * bounty fulfills — same terminal states as a one-shot, so tiers and DPSV
 * count streams with zero special-casing.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/bounty-streams");

export type StreamSweepResult = {
  paymentsQueued: number;
  checksPaid: number;
  usdQueued: number;
  streamsCompleted: number;
};

type ActiveStream = {
  id: string;
  bounty_id: string;
  poster_pubkey: string;
  hunter_pubkey: string;
  per_check_usdc: number;
  checks_total: number;
  checks_paid: number;
  reward_usdc: number;
  hunter_wallet: string;
  is_local: number;
};

/**
 * Queue batched payouts for unpaid heartbeat checks on locally-posted
 * streams. Runs in the consolidation tick beside the other bounty sweeps.
 */
export function sweepStreamPayouts(opts: {
  db: DatabaseSync;
  economics: {
    queueRevenuePayment: (p: {
      skillCrystalId: string;
      purchaseId: string;
      recipientPeerId: string;
      amountUsdc: number;
      role: string;
    }) => void;
  };
  now?: number;
  limit?: number;
}): StreamSweepResult {
  const now = opts.now ?? Date.now();
  const result: StreamSweepResult = {
    paymentsQueued: 0,
    checksPaid: 0,
    usdQueued: 0,
    streamsCompleted: 0,
  };

  const streams = opts.db
    .prepare(
      `SELECT s.id, s.bounty_id, s.poster_pubkey, s.hunter_pubkey, s.per_check_usdc,
              s.checks_total, s.checks_paid, b.reward_usdc, c.hunter_wallet, b.is_local
         FROM bounty_streams s
         JOIN bounty_posts b ON b.bounty_id = s.bounty_id
         JOIN bounty_claims c ON c.id = s.id
        WHERE s.status = 'active' AND s.checks_total > s.checks_paid AND b.is_local = 1
        ORDER BY s.updated_at LIMIT ?`,
    )
    .all(opts.limit ?? 25) as unknown as ActiveStream[];

  for (const s of streams) {
    const unpaid = s.checks_total - s.checks_paid;
    const budgetLeftUsd = s.reward_usdc - s.checks_paid * s.per_check_usdc;
    const affordable = Math.min(unpaid, Math.floor(budgetLeftUsd / s.per_check_usdc));
    if (affordable <= 0) {
      completeStream(opts.db, s, now);
      result.streamsCompleted++;
      continue;
    }
    const amount = affordable * s.per_check_usdc;
    const batchId = crypto.randomUUID();

    // Make the hunter payable (same best-effort upsert as one-shot settle).
    try {
      opts.db
        .prepare(
          `INSERT INTO peer_reputation (peer_pubkey, wallet_address, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(peer_pubkey) DO UPDATE SET wallet_address = excluded.wallet_address`,
        )
        .run(s.hunter_pubkey, s.hunter_wallet, now, now);
    } catch (err) {
      log.warn(`Could not record hunter wallet for stream payout: ${String(err)}`);
    }

    // One settlement row per batch: streams show up in DPSV/tier history as
    // real settled value, one row per payout rather than per check.
    opts.db
      .prepare(
        `INSERT INTO bounty_settlements
           (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
            amount_usdc, oracle_verdict, oracle_evidence, judge_capped, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pass', ?, 0, 'queued', ?)
         ON CONFLICT(claim_id) DO UPDATE SET
           amount_usdc = amount_usdc + excluded.amount_usdc,
           created_at = excluded.created_at`,
      )
      .run(
        batchId,
        s.bounty_id,
        s.id,
        s.poster_pubkey,
        s.hunter_pubkey,
        s.hunter_wallet,
        amount,
        JSON.stringify({ kind: "stream_batch", checks: affordable }),
        now,
      );
    opts.economics.queueRevenuePayment({
      skillCrystalId: `bounty:${s.bounty_id}`,
      purchaseId: batchId,
      recipientPeerId: s.hunter_pubkey,
      amountUsdc: amount,
      role: "stream_check",
    });
    opts.db
      .prepare(
        `UPDATE bounty_streams SET checks_paid = checks_paid + ?, updated_at = ? WHERE id = ?`,
      )
      .run(affordable, now, s.id);

    result.paymentsQueued++;
    result.checksPaid += affordable;
    result.usdQueued += amount;

    // Budget exhausted after this batch → graceful completion.
    const spent = (s.checks_paid + affordable) * s.per_check_usdc;
    if (spent + s.per_check_usdc > s.reward_usdc) {
      completeStream(opts.db, { ...s, checks_paid: s.checks_paid + affordable }, now);
      result.streamsCompleted++;
    }
  }

  if (result.paymentsQueued > 0 || result.streamsCompleted > 0) {
    log.info(
      `Stream sweep: ${result.paymentsQueued} batch payouts ($${result.usdQueued.toFixed(2)} / ` +
        `${result.checksPaid} checks), ${result.streamsCompleted} streams completed`,
    );
  }
  return result;
}

function completeStream(db: DatabaseSync, s: ActiveStream, now: number): void {
  db.prepare(`UPDATE bounty_streams SET status = 'completed', updated_at = ? WHERE id = ?`).run(
    now,
    s.id,
  );
  db.prepare(
    `UPDATE bounty_claims SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'claimed'`,
  ).run(now, s.id);
  db.prepare(
    `UPDATE bounty_posts SET status = 'fulfilled', updated_at = ? WHERE bounty_id = ?`,
  ).run(now, s.bounty_id);
  log.info(`Stream ${s.id} completed (budget spent) on bounty ${s.bounty_id}`);
}
