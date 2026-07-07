/**
 * PLAN-29 Phase 3: The Tape and the Forage scoreboard.
 *
 * The spectator layer is a first-class feature, not telemetry: a live feed
 * of bounty lifecycle events (The Tape) plus the honest scoreboard the
 * research said to measure instead of GMV — DPSV, fill rate, time-to-fill,
 * distinct earners. Everything derives from the bounty tables; there is no
 * separate event log to drift out of sync with the ledger.
 */

import type { DatabaseSync } from "node:sqlite";
import { computeDpsv, type DpsvReport } from "./bounty-reputation.js";

export type TapeEvent = {
  ts: number;
  type: "posted" | "opened" | "claimed" | "delivered" | "settled" | "stream_checked" | "fulfilled";
  bountyId: string;
  category: string;
  kind: string;
  /** USD amount for money events (settled), reward for posted/opened. */
  amountUsdc?: number;
  /** Truncated actor pubkey for display (never full identity material). */
  actor?: string;
};

function shortId(pubkey: string | null | undefined): string | undefined {
  return pubkey ? `${pubkey.slice(0, 12)}…` : undefined;
}

/** Recent bounty lifecycle events, newest first. */
export function getTape(db: DatabaseSync, opts: { limit?: number } = {}): TapeEvent[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const events: TapeEvent[] = [];

  const posts = db
    .prepare(
      `SELECT bounty_id, category, kind, reward_usdc, poster_pubkey, status,
              created_at, updated_at
         FROM bounty_posts ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, never>>;
  for (const p of posts) {
    events.push({
      ts: p.created_at,
      type: "posted",
      bountyId: p.bounty_id,
      category: p.category,
      kind: p.kind,
      amountUsdc: p.reward_usdc,
      actor: shortId(p.poster_pubkey),
    });
    if (p.status === "open" || p.status === "fulfilled") {
      events.push({
        ts: p.updated_at,
        type: p.status === "fulfilled" ? "fulfilled" : "opened",
        bountyId: p.bounty_id,
        category: p.category,
        kind: p.kind,
        amountUsdc: p.reward_usdc,
      });
    }
  }

  const claims = db
    .prepare(
      `SELECT c.bounty_id, c.hunter_pubkey, c.claimed_at, c.delivered_at,
              b.category, b.kind
         FROM bounty_claims c JOIN bounty_posts b ON b.bounty_id = c.bounty_id
        ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, never>>;
  for (const c of claims) {
    events.push({
      ts: c.claimed_at,
      type: "claimed",
      bountyId: c.bounty_id,
      category: c.category,
      kind: c.kind,
      actor: shortId(c.hunter_pubkey),
    });
    if (c.delivered_at) {
      events.push({
        ts: c.delivered_at,
        type: "delivered",
        bountyId: c.bounty_id,
        category: c.category,
        kind: c.kind,
        actor: shortId(c.hunter_pubkey),
      });
    }
  }

  const settlements = db
    .prepare(
      `SELECT s.bounty_id, s.hunter_pubkey, s.amount_usdc, s.created_at, b.category, b.kind
         FROM bounty_settlements s JOIN bounty_posts b ON b.bounty_id = s.bounty_id
        WHERE s.oracle_verdict = 'pass'
        ORDER BY s.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, never>>;
  for (const s of settlements) {
    events.push({
      ts: s.created_at,
      type: "settled",
      bountyId: s.bounty_id,
      category: s.category,
      kind: s.kind,
      amountUsdc: s.amount_usdc,
      actor: shortId(s.hunter_pubkey),
    });
  }

  const streams = db
    .prepare(
      `SELECT s.bounty_id, s.hunter_pubkey, s.checks_total, s.last_check_at, b.category
         FROM bounty_streams s JOIN bounty_posts b ON b.bounty_id = s.bounty_id
        WHERE s.last_check_at IS NOT NULL
        ORDER BY s.last_check_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, never>>;
  for (const s of streams) {
    events.push({
      ts: s.last_check_at,
      type: "stream_checked",
      bountyId: s.bounty_id,
      category: s.category,
      kind: "heartbeat",
      actor: shortId(s.hunter_pubkey),
    });
  }

  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, limit);
}

export type ForageStats = {
  dpsv7d: DpsvReport;
  dpsvAllTime: DpsvReport;
  openBounties: number;
  openRewardUsdc: number;
  activeStreams: number;
  totalChecks: number;
  /** Share of ever-opened bounties that received >= 1 claim. */
  fillRate: number | null;
  /** Median ms from bounty creation to first claim. */
  medianTimeToFillMs: number | null;
  /** Distinct hunters with at least one passing settlement. */
  distinctEarners: number;
  settlements: number;
  /**
   * PLAN-30 G0.4: the split ledger. Settled value split by whether the
   * poster wallet is on the PUBLISHED treasury list — seeded (operator
   * money) vs organic (everyone else). Keyed on the wallet list, never on
   * self-declared flags; blended totals are deliberately not rendered
   * anywhere seeded/organic can be shown instead.
   */
  seededSettledUsd7d: number;
  organicSettledUsd7d: number;
  seededSettledUsdAllTime: number;
  organicSettledUsdAllTime: number;
};

/**
 * One-line Forage summary for the new-main-session system block (the
 * "while you were away" moment). Returns null when there is nothing to
 * say, so quiet nodes stay quiet. v1 reports the local ledger's truth:
 * settlements queued to hunters and open demand. Hunter-side "you earned
 * $X" needs a client-side claim mirror and lands with the Night Shift.
 */
export function getMorningReportLine(db: DatabaseSync, now: number = Date.now()): string | null {
  const since = now - 86_400_000;
  const settled = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usdc), 0) AS usd
         FROM bounty_settlements WHERE oracle_verdict = 'pass' AND created_at >= ?`,
    )
    .get(since) as { n: number; usd: number };
  const checks = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bounty_streams WHERE last_check_at IS NOT NULL AND last_check_at >= ?`,
    )
    .get(since) as { n: number };
  const open = db.prepare(`SELECT COUNT(*) AS n FROM bounty_posts WHERE status = 'open'`).get() as {
    n: number;
  };
  // Hunter-side earnings (Night Shift claim mirror). Table exists from
  // migration v24; guard anyway so a partially-migrated db stays quiet.
  // PLAN-30 G0.5: 'confirmed' = hunts whose settlement the poster reports
  // PAID (tx dispatched); the rest of the accrual is reported as pending
  // so the morning report never overstates money that could still be
  // withheld by an audit.
  let earned = { earnedUsdc: 0, confirmedUsdc: 0, hunts: 0, checks: 0 };
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(earned_usdc), 0) AS usd,
                COALESCE(SUM(CASE WHEN settlement_status = 'paid' THEN earned_usdc ELSE 0 END), 0) AS confirmed,
                COUNT(*) AS hunts,
                COALESCE(SUM(checks_sent), 0) AS checks
           FROM forage_hunts WHERE updated_at >= ? AND earned_usdc > 0`,
      )
      .get(since) as { usd: number; confirmed: number; hunts: number; checks: number };
    earned = {
      earnedUsdc: row.usd,
      confirmedUsdc: row.confirmed,
      hunts: row.hunts,
      checks: row.checks,
    };
  } catch {
    /* pre-v24 db */
  }
  if (settled.n === 0 && checks.n === 0 && open.n === 0 && earned.earnedUsdc === 0) return null;
  const parts: string[] = [];
  if (earned.confirmedUsdc > 0) {
    const pending = earned.earnedUsdc - earned.confirmedUsdc;
    parts.push(
      `earned $${earned.confirmedUsdc.toFixed(2)} hunting ${earned.hunts} bount${earned.hunts === 1 ? "y" : "ies"} while you were away` +
        (pending > 0.005 ? ` (plus $${pending.toFixed(2)} pending verification)` : ""),
    );
  } else if (earned.earnedUsdc > 0) {
    parts.push(
      `accrued $${earned.earnedUsdc.toFixed(2)} (pending verification) hunting ${earned.hunts} bount${earned.hunts === 1 ? "y" : "ies"} while you were away`,
    );
  }
  if (settled.n > 0) {
    parts.push(
      `${settled.n} bounty settlement${settled.n === 1 ? "" : "s"} ($${settled.usd.toFixed(2)}) in the last 24h`,
    );
  }
  if (checks.n > 0) {
    parts.push(`${checks.n} monitor stream${checks.n === 1 ? "" : "s"} reporting`);
  }
  if (open.n > 0) {
    parts.push(`${open.n} open bount${open.n === 1 ? "y" : "ies"} on the mesh`);
  }
  return `Forage: ${parts.join("; ")}.`;
}

export function getForageStats(
  db: DatabaseSync,
  now: number = Date.now(),
  opts: { treasuryWallets?: string[] } = {},
): ForageStats {
  const weekAgo = now - 7 * 86_400_000;
  const treasury = (opts.treasuryWallets ?? []).map((w) => w.toLowerCase());

  const settledSplit = (sinceMs: number): { seeded: number; organic: number } => {
    if (treasury.length === 0) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS usd FROM bounty_settlements
            WHERE oracle_verdict = 'pass' AND status IN ('queued','paid','held_review')
              AND created_at >= ?`,
        )
        .get(sinceMs) as { usd: number };
      return { seeded: 0, organic: row.usd };
    }
    const placeholders = treasury.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN lower(b.poster_wallet) IN (${placeholders})
                             THEN s.amount_usdc ELSE 0 END), 0) AS seeded,
           COALESCE(SUM(CASE WHEN lower(b.poster_wallet) NOT IN (${placeholders})
                             THEN s.amount_usdc ELSE 0 END), 0) AS organic
           FROM bounty_settlements s
           JOIN bounty_posts b ON b.bounty_id = s.bounty_id
          WHERE s.oracle_verdict = 'pass' AND s.status IN ('queued','paid','held_review')
            AND s.created_at >= ?`,
      )
      .get(...treasury, ...treasury, sinceMs) as { seeded: number; organic: number };
    return { seeded: row.seeded, organic: row.organic };
  };
  const split7d = settledSplit(weekAgo);
  const splitAll = settledSplit(0);

  const open = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(reward_usdc), 0) AS reward
         FROM bounty_posts WHERE status = 'open'`,
    )
    .get() as { n: number; reward: number };

  const streams = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(checks_total), 0) AS checks
         FROM bounty_streams WHERE status IN ('active','completed')`,
    )
    .get() as { n: number; checks: number };

  const fill = db
    .prepare(
      `SELECT COUNT(*) AS opened,
              SUM(EXISTS (SELECT 1 FROM bounty_claims c WHERE c.bounty_id = b.bounty_id)) AS filled
         FROM bounty_posts b WHERE b.status IN ('open','fulfilled','expired')`,
    )
    .get() as { opened: number; filled: number | null };

  const ttf = db
    .prepare(
      `SELECT c.claimed_at - b.created_at AS ms
         FROM bounty_posts b
         JOIN bounty_claims c ON c.bounty_id = b.bounty_id
        WHERE c.claimed_at >= b.created_at
        GROUP BY b.bounty_id
        HAVING c.claimed_at = MIN(c.claimed_at)
        ORDER BY ms`,
    )
    .all() as unknown as Array<{ ms: number }>;

  const earners = db
    .prepare(
      `SELECT COUNT(DISTINCT hunter_pubkey) AS n, COUNT(*) AS settlements
         FROM bounty_settlements
        WHERE oracle_verdict = 'pass' AND poster_pubkey != hunter_pubkey`,
    )
    .get() as { n: number; settlements: number };

  return {
    dpsv7d: computeDpsv(db, { sinceMs: weekAgo, untilMs: now + 1 }),
    dpsvAllTime: computeDpsv(db),
    openBounties: open.n,
    openRewardUsdc: open.reward,
    activeStreams: streams.n,
    totalChecks: streams.checks,
    fillRate: fill.opened > 0 ? (fill.filled ?? 0) / fill.opened : null,
    medianTimeToFillMs: ttf.length > 0 ? ttf[Math.floor(ttf.length / 2)].ms : null,
    distinctEarners: earners.n,
    settlements: earners.settlements,
    seededSettledUsd7d: split7d.seeded,
    organicSettledUsd7d: split7d.organic,
    seededSettledUsdAllTime: splitAll.seeded,
    organicSettledUsdAllTime: splitAll.organic,
  };
}
