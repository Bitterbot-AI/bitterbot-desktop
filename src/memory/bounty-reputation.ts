/**
 * PLAN-29 Phase 1.4: progressive trust tiers and DPSV accounting.
 *
 * Trust tiers gate EXPOSURE, not participation: any hunter can work, but
 * the reward size an unproven hunter may claim is capped until completed,
 * counterparty-diverse settlement history earns more. Research-backed
 * (agent marketplaces are demand-constrained and new agents are asset-poor,
 * so progressive caps beat pure staking) and the ladder is the substrate
 * the apprenticeship mechanic lands on later.
 *
 *   T0 apprentice  — no settled history        → claims ≤ $1
 *   T1 proven      — ≥ 1 settled               → claims ≤ $5
 *   T2 established — ≥ 5 settled, ≥ $10 total,
 *                    ≥ 2 distinct posters      → claims ≤ $50
 *   T3 trusted     — ≥ 20 settled, ≥ $100,
 *                    ≥ 5 distinct posters      → uncapped
 *
 * DPSV (Distinct-Party Settled Value) is THE headline metric of the Forage
 * economy: USDC settled between counterparties whose identities differ.
 * Self-loops (poster == hunter) are excluded entirely — with a zero-fee
 * protocol, raw counts are free to fake, so nothing that matters (metrics,
 * tiers, leaderboards) may ever key off unfiltered volume. Pair-diversity
 * weighting: repeat settlements between the same pair count at full value
 * up to a per-pair cap share, so two colluding nodes cannot farm DPSV by
 * ping-ponging the same dollar.
 */

import type { DatabaseSync } from "node:sqlite";

export type TrustTier = 0 | 1 | 2 | 3;

export const TIER_CLAIM_CAPS_USD: Record<TrustTier, number> = {
  0: 1,
  1: 5,
  2: 50,
  3: Number.POSITIVE_INFINITY,
};

const SETTLED_STATUSES = "('queued','paid','held_review')";

/** Compute a hunter's trust tier from its settled bounty history. */
export function computeTrustTier(db: DatabaseSync, hunterPubkey: string): TrustTier {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usdc), 0) AS vol,
              COUNT(DISTINCT poster_pubkey) AS posters
         FROM bounty_settlements
        WHERE hunter_pubkey = ? AND oracle_verdict = 'pass'
          AND status IN ${SETTLED_STATUSES}
          AND poster_pubkey != hunter_pubkey`,
    )
    .get(hunterPubkey) as { n: number; vol: number; posters: number };
  if (row.n >= 20 && row.vol >= 100 && row.posters >= 5) return 3;
  if (row.n >= 5 && row.vol >= 10 && row.posters >= 2) return 2;
  if (row.n >= 1) return 1;
  return 0;
}

/** Max reward a hunter at its current tier may claim. */
export function claimCapUsd(db: DatabaseSync, hunterPubkey: string): number {
  return TIER_CLAIM_CAPS_USD[computeTrustTier(db, hunterPubkey)];
}

export type DpsvReport = {
  /** Distinct-party settled value in the window (USD). */
  totalUsd: number;
  /** Settlements contributing to the total. */
  settlements: number;
  /** Distinct (poster, hunter) pairs. */
  distinctPairs: number;
  /** Value excluded because poster == hunter (wash volume made visible). */
  selfLoopExcludedUsd: number;
  /** Value trimmed by the per-pair concentration cap. */
  concentrationTrimmedUsd: number;
};

/**
 * Compute DPSV over a time window. `maxPairShare` caps any single
 * counterparty pair's contribution to that fraction of the raw
 * distinct-party total (default 25%) — the concentration guard that makes
 * two-node ping-pong farming pointless.
 */
export function computeDpsv(
  db: DatabaseSync,
  opts: { sinceMs?: number; untilMs?: number; maxPairShare?: number } = {},
): DpsvReport {
  const since = opts.sinceMs ?? 0;
  const until = opts.untilMs ?? Number.MAX_SAFE_INTEGER;
  const maxPairShare = opts.maxPairShare ?? 0.25;

  const selfLoop = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS v FROM bounty_settlements
        WHERE oracle_verdict = 'pass' AND status IN ${SETTLED_STATUSES}
          AND poster_pubkey = hunter_pubkey
          AND created_at >= ? AND created_at < ?`,
    )
    .get(since, until) as { v: number };

  const pairs = db
    .prepare(
      `SELECT poster_pubkey, hunter_pubkey, COALESCE(SUM(amount_usdc), 0) AS v, COUNT(*) AS n
         FROM bounty_settlements
        WHERE oracle_verdict = 'pass' AND status IN ${SETTLED_STATUSES}
          AND poster_pubkey != hunter_pubkey
          AND created_at >= ? AND created_at < ?
        GROUP BY poster_pubkey, hunter_pubkey`,
    )
    .all(since, until) as unknown as Array<{ v: number; n: number }>;

  const rawTotal = pairs.reduce((s, p) => s + p.v, 0);
  const pairCap = rawTotal * maxPairShare;
  let totalUsd = 0;
  let trimmed = 0;
  let settlements = 0;
  for (const p of pairs) {
    // With few pairs the cap is meaningless (1 pair == 100% share), so it
    // only engages once there are enough pairs for the share to be a
    // meaningful concentration signal.
    const contribution = pairs.length >= 4 ? Math.min(p.v, pairCap) : p.v;
    totalUsd += contribution;
    trimmed += p.v - contribution;
    settlements += p.n;
  }

  return {
    totalUsd,
    settlements,
    distinctPairs: pairs.length,
    selfLoopExcludedUsd: selfLoop.v,
    concentrationTrimmedUsd: trimmed,
  };
}
