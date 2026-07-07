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
  alert_bonus_usdc: number;
  checks_total: number;
  checks_paid: number;
  spent_usdc: number;
  reward_usdc: number;
  hunter_wallet: string;
  poster_wallet: string;
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
  /**
   * PLAN-30 G0.4: seed-pool farming guard. When set, a hunter's daily
   * take from streams posted by the published treasury wallets is capped;
   * enforced here (poster-side) because the cadence floor still allows
   * 2x-rate check-ins, so client-side pacing is not a guard.
   */
  genesis?: {
    treasuryWallets: string[];
    maxDailyTreasuryUsdcPerHunter?: number;
  };
}): StreamSweepResult {
  const now = opts.now ?? Date.now();
  const treasuryWallets = (opts.genesis?.treasuryWallets ?? []).map((w) => w.toLowerCase());
  const maxDailyTreasury = opts.genesis?.maxDailyTreasuryUsdcPerHunter ?? 1;
  const result: StreamSweepResult = {
    paymentsQueued: 0,
    checksPaid: 0,
    usdQueued: 0,
    streamsCompleted: 0,
  };

  const streams = opts.db
    .prepare(
      `SELECT s.id, s.bounty_id, s.poster_pubkey, s.hunter_pubkey, s.per_check_usdc,
              s.alert_bonus_usdc, s.checks_total, s.checks_paid, s.spent_usdc,
              b.reward_usdc, c.hunter_wallet, b.poster_wallet, b.is_local
         FROM bounty_streams s
         JOIN bounty_posts b ON b.bounty_id = s.bounty_id
         JOIN bounty_claims c ON c.id = s.id
        WHERE s.status = 'active' AND s.checks_total > s.checks_paid AND b.is_local = 1
        ORDER BY s.updated_at LIMIT ?`,
    )
    .all(opts.limit ?? 25) as unknown as ActiveStream[];

  for (const s of streams) {
    const unpaid = s.checks_total - s.checks_paid;
    // PLAN-30 G0.5: the bounty's reward is ONE budget shared by ALL its
    // streams (with max_claims > 1, per-stream accounting paid each claim
    // the full budget — a K-times overpayment). spent_usdc is the precise
    // ledger; summing it across the bounty is the only correct remaining-
    // budget calculation once alert bonuses ride the same budget.
    const spentAcrossBounty = (
      opts.db
        .prepare(
          `SELECT COALESCE(SUM(spent_usdc), 0) AS usd FROM bounty_streams WHERE bounty_id = ?`,
        )
        .get(s.bounty_id) as { usd: number }
    ).usd;
    const budgetLeftUsd = s.reward_usdc - spentAcrossBounty;
    let affordable = Math.min(unpaid, Math.floor(budgetLeftUsd / s.per_check_usdc));
    if (affordable <= 0) {
      completeStream(opts.db, s, now);
      result.streamsCompleted++;
      continue;
    }
    // PLAN-30 G0.4: per-hunter daily cap on treasury-posted streams. The
    // stream stays active (checks keep accruing); payment resumes when the
    // 24h window rolls.
    let treasuryRemaining = Number.POSITIVE_INFINITY;
    if (treasuryWallets.includes(s.poster_wallet.toLowerCase())) {
      const placeholders = treasuryWallets.map(() => "?").join(",");
      const paidToday = (
        opts.db
          .prepare(
            `SELECT COALESCE(SUM(q.amount_usdc), 0) AS usd
               FROM revenue_payment_queue q
              WHERE q.recipient_peer_id = ? AND q.role = 'stream_check' AND q.queued_at >= ?
                AND q.purchase_id IN
                  (SELECT s2.id FROM bounty_streams s2
                     JOIN bounty_posts b2 ON b2.bounty_id = s2.bounty_id
                    WHERE lower(b2.poster_wallet) IN (${placeholders}))`,
          )
          .get(s.hunter_pubkey, now - 86_400_000, ...treasuryWallets) as { usd: number }
      ).usd;
      treasuryRemaining = Math.max(0, maxDailyTreasury - paidToday);
      affordable = Math.min(affordable, Math.floor(treasuryRemaining / s.per_check_usdc));
      if (affordable <= 0) {
        continue; // capped for today, not completed
      }
    }
    // Alert bonus: paid per alert check in this batch that an audit
    // CONFIRMED (alert checks are always audited — bounty-audit.ts). An
    // unaudited or failed alert pays the plain per-check rate only, so the
    // alert flag cannot be farmed. Bonuses are skipped entirely when the
    // remaining budget cannot cover them.
    let bonusUsd = 0;
    if (s.alert_bonus_usdc > 0) {
      const confirmedAlerts = (
        opts.db
          .prepare(
            `SELECT COUNT(*) AS n FROM bounty_stream_checks
              WHERE stream_id = ? AND seq > ? AND seq <= ?
                AND alert = 1 AND audit_status = 'pass'`,
          )
          .get(s.id, s.checks_paid, s.checks_paid + affordable) as { n: number }
      ).n;
      const candidate = confirmedAlerts * s.alert_bonus_usdc;
      if (
        affordable * s.per_check_usdc + candidate <= budgetLeftUsd &&
        affordable * s.per_check_usdc + candidate <= treasuryRemaining
      ) {
        bonusUsd = candidate;
      }
    }
    const amount = affordable * s.per_check_usdc + bonusUsd;
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
        JSON.stringify({ kind: "stream_batch", checks: affordable, bonusUsd }),
        now,
      );
    // purchaseId = the stream/claim id (stable across batches) so payment
    // dispatch can backfill tx_hash onto the settlement row by claim_id
    // (PLAN-30 G0.5: forage/verdict finally returns receipts).
    opts.economics.queueRevenuePayment({
      skillCrystalId: `bounty:${s.bounty_id}`,
      purchaseId: s.id,
      recipientPeerId: s.hunter_pubkey,
      amountUsdc: amount,
      role: "stream_check",
    });
    opts.db
      .prepare(
        `UPDATE bounty_streams
            SET checks_paid = checks_paid + ?, spent_usdc = spent_usdc + ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(affordable, amount, now, s.id);

    result.paymentsQueued++;
    result.checksPaid += affordable;
    result.usdQueued += amount;

    // Budget exhausted after this batch → graceful completion.
    if (spentAcrossBounty + amount + s.per_check_usdc > s.reward_usdc) {
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
