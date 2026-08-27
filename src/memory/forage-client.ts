/**
 * PLAN-29 Phase 5: the Night Shift — hunter-side Forage client.
 *
 * Everything so far served OTHER hunters against OUR bounties. This module
 * is our node going out to earn: it scans mesh-ingested open bounties,
 * claims the ones it can complete mechanically, does the work, and polls
 * for verdicts. v1 hunts HEARTBEAT MONITORING bounties only — fetch the
 * target, hash the content, check in — because that loop is provable
 * end-to-end with zero LLM judgment and bounded cost. One-shot categories
 * (extraction etc.) need the dream engine's LLM and land with the
 * biology-gated bounty_hunt dream mode.
 *
 * Conservative by design (this is autonomous work-taking, not spending):
 * receive-only money flow, hard cap on concurrent hunts and per-bounty
 * reward, monitoring category only, kill switch forage.nightShift.enabled.
 * The poster's A2A callback URL rides in the bounty's machine block
 * ("posterA2aUrl"), so hunting needs no out-of-band discovery.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { parseHeartbeatTerms } from "../gateway/a2a/forage.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { contentDigest, simhash64 } from "./bounty-audit.js";

const log = createSubsystemLogger("memory/forage-client");

export const NIGHT_SHIFT_DEFAULTS = {
  maxConcurrentHunts: 2,
  maxRewardUsdc: 2,
  categories: ["monitoring"],
};

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Extract the poster's A2A callback URL from the bounty's machine block. */
export function parsePosterA2aUrl(specPublic: string): string | null {
  const match = /"posterA2aUrl"\s*:\s*"(https?:\/\/[^"]+)"/.exec(specPublic);
  return match ? match[1] : null;
}

/** Extract the monitored target URL from the heartbeat machine block. */
export function parseMonitorUrl(specPublic: string): string | null {
  const match = /"url"\s*:\s*"(https?:\/\/[^"]+)"/.exec(specPublic);
  return match ? match[1] : null;
}

async function forageRpc(
  fetchImpl: FetchLike,
  a2aUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetchImpl(a2aUrl.replace(/\/$/, "") + "/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const body = JSON.parse(await res.text()) as {
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    if (body.error) return { ok: false, error: body.error.message ?? "rpc error" };
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type NightShiftConfig = {
  enabled?: boolean;
  maxConcurrentHunts?: number;
  maxRewardUsdc?: number;
};

export type NightShiftResult = {
  claimed: number;
  checksSent: number;
  verdictsSeen: number;
  earnedUsdc: number;
  errors: number;
};

/**
 * One Night Shift pass: poll verdicts, send due heartbeat checks, claim
 * new work under the caps. Runs in the consolidation tick; every network
 * call is awaited (event-loop yield rule) and failures never throw.
 */
export async function nightShiftSweep(opts: {
  db: DatabaseSync;
  hunterPubkey: string;
  hunterWallet: string;
  fetchImpl: FetchLike;
  config?: NightShiftConfig;
  now?: number;
}): Promise<NightShiftResult> {
  const now = opts.now ?? Date.now();
  const cfg = opts.config ?? {};
  const result: NightShiftResult = {
    claimed: 0,
    checksSent: 0,
    verdictsSeen: 0,
    earnedUsdc: 0,
    errors: 0,
  };
  // V1 default flip (PLAN-41 D-D): night-shift hunting is opt-in.
  if (cfg.enabled !== true) return result;
  const maxHunts = cfg.maxConcurrentHunts ?? NIGHT_SHIFT_DEFAULTS.maxConcurrentHunts;
  const maxReward = cfg.maxRewardUsdc ?? NIGHT_SHIFT_DEFAULTS.maxRewardUsdc;

  // 1. Send due heartbeat checks on active hunts.
  const active = opts.db
    .prepare(
      `SELECT claim_id, bounty_id, poster_a2a_url, monitor_url, cadence_seconds,
              per_check_usdc, checks_sent, last_action_at, claim_nonce, last_content_digest
         FROM forage_hunts WHERE status = 'claimed' AND kind = 'heartbeat'`,
    )
    .all() as unknown as Array<{
    claim_id: string;
    bounty_id: string;
    poster_a2a_url: string;
    monitor_url: string | null;
    cadence_seconds: number | null;
    per_check_usdc: number | null;
    checks_sent: number;
    last_action_at: number | null;
    claim_nonce: string | null;
    last_content_digest: string | null;
  }>;
  for (const hunt of active) {
    if (!hunt.monitor_url || !hunt.cadence_seconds) continue;
    if (hunt.last_action_at !== null && now - hunt.last_action_at < hunt.cadence_seconds * 1000) {
      continue; // not due yet
    }
    try {
      const res = await opts.fetchImpl(hunt.monitor_url, { method: "GET" });
      const body = await res.text();
      // PLAN-30 G0.3: normalized digest + simhash so the poster's auditor
      // tolerates page nondeterminism, sealed with the claim nonce so only
      // this hunter can check in on its stream. Alert fires on content
      // change vs the previous observation (alert bonus, G0.5).
      const contentHash = contentDigest(body, "norm-v1");
      const alert = hunt.last_content_digest !== null && hunt.last_content_digest !== contentHash;
      const sealedDigest = hunt.claim_nonce
        ? crypto
            .createHash("sha256")
            .update(hunt.claim_nonce + contentHash, "utf-8")
            .digest("hex")
        : undefined;
      const checkin = await forageRpc(opts.fetchImpl, hunt.poster_a2a_url, "forage/checkin", {
        bountyId: hunt.bounty_id,
        claimId: hunt.claim_id,
        hunterPubkey: opts.hunterPubkey,
        observation: {
          url: hunt.monitor_url,
          contentHash,
          observedAt: now,
          digestScheme: "norm-v1",
          simhash: simhash64(body),
          ...(sealedDigest ? { sealedDigest } : {}),
          ...(alert ? { alert: true } : {}),
        },
      });
      if (checkin.ok) {
        opts.db
          .prepare(
            `UPDATE forage_hunts
                SET checks_sent = checks_sent + 1, earned_usdc = earned_usdc + ?,
                    last_action_at = ?, updated_at = ?, last_content_digest = ?
              WHERE claim_id = ?`,
          )
          .run(hunt.per_check_usdc ?? 0, now, now, contentHash, hunt.claim_id);
        result.checksSent++;
        result.earnedUsdc += hunt.per_check_usdc ?? 0;
      } else if (/not active/i.test(checkin.error ?? "")) {
        // Stream ended poster-side (budget spent): our work here is done.
        opts.db
          .prepare(
            `UPDATE forage_hunts SET status = 'completed', updated_at = ? WHERE claim_id = ?`,
          )
          .run(now, hunt.claim_id);
      } else {
        result.errors++;
      }
    } catch (err) {
      log.debug(`Night Shift check failed on ${hunt.claim_id}: ${String(err)}`);
      result.errors++;
    }
  }

  // 2. Poll verdicts on delivered one-shot hunts (future LLM path) — cheap
  //    and keeps earned_usdc honest for the morning report.
  const delivered = opts.db
    .prepare(
      `SELECT claim_id, bounty_id, poster_a2a_url, reward_usdc
         FROM forage_hunts WHERE status = 'delivered'`,
    )
    .all() as unknown as Array<{
    claim_id: string;
    bounty_id: string;
    poster_a2a_url: string;
    reward_usdc: number;
  }>;
  for (const hunt of delivered) {
    const verdict = await forageRpc(opts.fetchImpl, hunt.poster_a2a_url, "forage/verdict", {
      bountyId: hunt.bounty_id,
      claimId: hunt.claim_id,
      hunterPubkey: opts.hunterPubkey,
    });
    if (!verdict.ok) continue;
    result.verdictsSeen++;
    const v = verdict.result as { verdict?: string | null } | undefined;
    if (v?.verdict === "pass") {
      opts.db
        .prepare(
          `UPDATE forage_hunts SET status = 'verified', earned_usdc = ?, updated_at = ? WHERE claim_id = ?`,
        )
        .run(hunt.reward_usdc, now, hunt.claim_id);
      result.earnedUsdc += hunt.reward_usdc;
    } else if (v?.verdict === "fail") {
      opts.db
        .prepare(`UPDATE forage_hunts SET status = 'failed', updated_at = ? WHERE claim_id = ?`)
        .run(now, hunt.claim_id);
    }
  }

  // 2b. PLAN-30 G0.5: settlement reconciliation for earning hunts. The
  //     poster's forage/verdict now returns settlementStatus + txHash
  //     (tx_hash backfill landed with this phase); mirroring them locally
  //     is what lets the morning report distinguish accrued from PAID.
  const reconcilable = opts.db
    .prepare(
      `SELECT claim_id, bounty_id, poster_a2a_url
         FROM forage_hunts
        WHERE earned_usdc > 0
          AND (settlement_status IS NULL OR settlement_status != 'paid')`,
    )
    .all() as unknown as Array<{ claim_id: string; bounty_id: string; poster_a2a_url: string }>;
  for (const hunt of reconcilable) {
    const verdict = await forageRpc(opts.fetchImpl, hunt.poster_a2a_url, "forage/verdict", {
      bountyId: hunt.bounty_id,
      claimId: hunt.claim_id,
      hunterPubkey: opts.hunterPubkey,
    });
    if (!verdict.ok) continue;
    const v = verdict.result as
      | { settlementStatus?: string | null; txHash?: string | null }
      | undefined;
    if (v?.settlementStatus) {
      opts.db
        .prepare(
          `UPDATE forage_hunts
              SET settlement_status = ?, settlement_tx = ?, updated_at = ?
            WHERE claim_id = ?`,
        )
        .run(v.settlementStatus, v.txHash ?? null, now, hunt.claim_id);
    }
  }

  // 3. Claim new heartbeat monitoring bounties under the caps.
  const activeCount = (
    opts.db
      .prepare(`SELECT COUNT(*) AS n FROM forage_hunts WHERE status IN ('claimed','delivered')`)
      .get() as { n: number }
  ).n;
  if (activeCount >= maxHunts) return result;

  const candidates = opts.db
    .prepare(
      `SELECT bounty_id, poster_pubkey, category, kind, spec_public, reward_usdc
         FROM bounty_posts
        WHERE is_local = 0 AND status = 'open' AND kind = 'heartbeat'
          AND category = 'monitoring' AND reward_usdc <= ? AND expires_at > ?
          AND bounty_id NOT IN (SELECT bounty_id FROM forage_hunts)
        ORDER BY reward_usdc DESC LIMIT ?`,
    )
    .all(maxReward, now, maxHunts - activeCount) as unknown as Array<{
    bounty_id: string;
    poster_pubkey: string;
    category: string;
    kind: string;
    spec_public: string;
    reward_usdc: number;
  }>;
  for (const bounty of candidates) {
    const posterUrl = parsePosterA2aUrl(bounty.spec_public);
    const monitorUrl = parseMonitorUrl(bounty.spec_public);
    const terms = parseHeartbeatTerms(bounty.spec_public);
    if (!posterUrl || !monitorUrl || !terms) continue; // not autonomously huntable
    const claim = await forageRpc(opts.fetchImpl, posterUrl, "forage/claim", {
      bountyId: bounty.bounty_id,
      hunterPubkey: opts.hunterPubkey,
      hunterWallet: opts.hunterWallet,
    });
    if (!claim.ok || typeof claim.result?.claimId !== "string") {
      result.errors++;
      continue;
    }
    opts.db
      .prepare(
        `INSERT INTO forage_hunts
           (claim_id, bounty_id, poster_pubkey, poster_a2a_url, category, kind,
            reward_usdc, per_check_usdc, monitor_url, cadence_seconds, claim_nonce,
            status, checks_sent, earned_usdc, last_action_at, claimed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 0, 0, NULL, ?, ?)`,
      )
      .run(
        claim.result.claimId,
        bounty.bounty_id,
        bounty.poster_pubkey,
        posterUrl,
        bounty.category,
        bounty.kind,
        bounty.reward_usdc,
        terms.perCheckUsdc,
        monitorUrl,
        terms.cadenceSeconds,
        typeof claim.result.claimNonce === "string" ? claim.result.claimNonce : null,
        now,
        now,
      );
    result.claimed++;
    log.info(
      `Night Shift claimed ${bounty.bounty_id} ($${bounty.reward_usdc} budget, ` +
        `$${terms.perCheckUsdc}/check on ${monitorUrl})`,
    );
  }

  return result;
}

/** Hunter-side earnings for the morning report ("you earned $X"). */
export function getNightShiftEarnings(
  db: DatabaseSync,
  sinceMs: number,
): { earnedUsdc: number; hunts: number; checks: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(earned_usdc), 0) AS usd, COUNT(*) AS hunts,
              COALESCE(SUM(checks_sent), 0) AS checks
         FROM forage_hunts WHERE updated_at >= ? AND earned_usdc > 0`,
    )
    .get(sinceMs) as { usd: number; hunts: number; checks: number };
  return { earnedUsdc: row.usd, hunts: row.hunts, checks: row.checks };
}
