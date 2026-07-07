/**
 * PLAN-30 G0.1/G0.2: heartbeat stream auditing + earnings forfeiture.
 *
 * The economic spine of Forage Genesis: check-ins are cheap claims, so a
 * random fraction of them is independently re-observed by the poster node.
 * The audit rate follows BOINC's adaptive replication schedule (verified
 * against the BOINC docs during PLAN-30 review): a hunter's first 10 checks
 * are always audited (apprenticeship), after which the rate decays as
 * max(floor, 1/CV) where CV counts consecutive AUDITED-AND-PASSED checks.
 * Unaudited checks never increment CV, so an active cheater cannot decay
 * its own audit rate.
 *
 * Verdicts are two-tier by design (PLAN-30 review finding: raw-hash
 * forfeiture would routinely confiscate honest earnings because live pages
 * are nondeterministic):
 *
 *   pass         — auditor digest matches, or simhash within tolerance.
 *   unverifiable — the auditor's own two fetches disagree (page is
 *                  nondeterministic) or the auditor could not fetch
 *                  reliably. Never punished.
 *   failed       — auditor observed STABLE content that contradicts the
 *                  hunter's claim. Resets CV to 0 (back to 100% audit,
 *                  release-gated) but does NOT seize anything.
 *   fraud        — provable lie only (e.g. a sealed digest that is
 *                  internally inconsistent, G0.3; or golden-task failure,
 *                  G2). Triggers forfeiture of all held bounty earnings.
 *
 * Deterrence comes from the CV release gate (marketplace-economics):
 * bounty-role payments release only when the hunter's CV is at or above
 * RELEASE_CV_FLOOR, so a hunter whose CV was reset re-earns trust through
 * fully-audited checks before any further money moves. Belenkiy et al.
 * (2008): the forfeitable amount must exceed reward x (1-p)/p; the frozen
 * pipeline plus the apprenticeship is the self-assembling bond. The
 * refundable capital bond (PLAN-30 G0.2) layers on top in a follow-up.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/bounty-audit");

/** Audit probability floor once a hunter is past the apprenticeship. */
export const AUDIT_FLOOR_RATE = 0.05;
/** Checks below this CV are always audited (BOINC apprenticeship). */
export const APPRENTICESHIP_CV = 10;
/** Bounty-role payments release only at or above this CV. */
export const RELEASE_CV_FLOOR = 10;
/** Max Hamming distance between simhashes still considered the same page. */
export const SIMHASH_TOLERANCE = 6;
/** Cap on audited response bodies; larger pages compare on the prefix. */
const MAX_AUDIT_BODY_BYTES = 2 * 1024 * 1024;

export type AuditVerdict = "pass" | "unverifiable" | "failed" | "fraud";

export type HunterAuditState = {
  cv: number;
  auditsTotal: number;
  auditsPassed: number;
  auditsFailed: number;
  auditsUnverifiable: number;
  frauds: number;
};

// ---------------------------------------------------------------------------
// Content normalization ('norm-v1') + digests
// ---------------------------------------------------------------------------

/**
 * Canonical normalization pipeline, scheme id 'norm-v1'. Both hunter and
 * auditor run this before hashing so rotating ads, inline tokens, and
 * asset cache-busters do not read as content changes. Deliberately
 * conservative: text content survives, volatile markup does not.
 */
export function normalizeContent(raw: string): string {
  return raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /\s(src|href)=("([^"?]*)\?[^"]*"|'([^'?]*)\?[^']*')/gi,
      (_m, attr: string, _q: string, dq?: string, sq?: string) => ` ${attr}="${dq ?? sq ?? ""}"`,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 hex of content under the named scheme. */
export function contentDigest(raw: string, scheme: string): string {
  const material = scheme === "norm-v1" ? normalizeContent(raw) : raw;
  return crypto.createHash("sha256").update(material, "utf-8").digest("hex");
}

/**
 * 64-bit simhash over word 4-gram shingles of the normalized content,
 * returned as 16 hex chars. Near-duplicate pages land within a small
 * Hamming distance, which is how the auditor distinguishes "page drifted
 * slightly between the hunter's fetch and mine" from "hunter reported a
 * different page".
 */
export function simhash64(raw: string): string {
  const words = normalizeContent(raw).toLowerCase().split(" ");
  const weights = Array.from({ length: 64 }, () => 0);
  const n = Math.max(1, words.length - 3);
  for (let i = 0; i < n; i++) {
    const shingle = words.slice(i, i + 4).join(" ");
    let h = 0xcbf29ce484222325n; // FNV-1a 64-bit
    for (let j = 0; j < shingle.length; j++) {
      h ^= BigInt(shingle.charCodeAt(j));
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    for (let b = 0; b < 64; b++) {
      weights[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (weights[b] > 0) out |= 1n << BigInt(b);
  }
  return out.toString(16).padStart(16, "0");
}

/** Hamming distance between two 16-hex-char simhashes. */
export function simhashDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let d = 0;
  while (x > 0n) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Hunter audit state (CV counter)
// ---------------------------------------------------------------------------

export function getHunterAuditState(db: DatabaseSync, hunterPubkey: string): HunterAuditState {
  const row = db
    .prepare(
      `SELECT cv, audits_total, audits_passed, audits_failed, audits_unverifiable, frauds
         FROM forage_hunter_audit WHERE hunter_pubkey = ?`,
    )
    .get(hunterPubkey) as
    | {
        cv: number;
        audits_total: number;
        audits_passed: number;
        audits_failed: number;
        audits_unverifiable: number;
        frauds: number;
      }
    | undefined;
  return {
    cv: row?.cv ?? 0,
    auditsTotal: row?.audits_total ?? 0,
    auditsPassed: row?.audits_passed ?? 0,
    auditsFailed: row?.audits_failed ?? 0,
    auditsUnverifiable: row?.audits_unverifiable ?? 0,
    frauds: row?.frauds ?? 0,
  };
}

/** Probability the next check from this hunter is audited. */
export function auditProbability(cv: number): number {
  if (cv < APPRENTICESHIP_CV) return 1;
  return Math.max(AUDIT_FLOOR_RATE, 1 / cv);
}

export function recordAuditOutcome(
  db: DatabaseSync,
  hunterPubkey: string,
  verdict: AuditVerdict,
  now: number,
): void {
  const passInc = verdict === "pass" ? 1 : 0;
  const failInc = verdict === "failed" ? 1 : 0;
  const unvInc = verdict === "unverifiable" ? 1 : 0;
  const fraudInc = verdict === "fraud" ? 1 : 0;
  // pass: cv+1. failed/fraud: cv resets to 0. unverifiable: cv unchanged.
  const cvExpr = verdict === "pass" ? "cv + 1" : verdict === "unverifiable" ? "cv" : "0";
  db.prepare(
    `INSERT INTO forage_hunter_audit
       (hunter_pubkey, cv, audits_total, audits_passed, audits_failed,
        audits_unverifiable, frauds, last_audit_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hunter_pubkey) DO UPDATE SET
       cv = ${cvExpr},
       audits_total = audits_total + 1,
       audits_passed = audits_passed + ${passInc},
       audits_failed = audits_failed + ${failInc},
       audits_unverifiable = audits_unverifiable + ${unvInc},
       frauds = frauds + ${fraudInc},
       last_audit_at = excluded.last_audit_at,
       updated_at = excluded.updated_at`,
  ).run(hunterPubkey, verdict === "pass" ? 1 : 0, passInc, failInc, unvInc, fraudInc, now, now);
}

// ---------------------------------------------------------------------------
// Forfeiture (G0.2)
// ---------------------------------------------------------------------------

export type ForfeitResult = {
  heldPaymentsForfeited: number;
  heldUsdForfeited: number;
  settlementsForfeited: number;
};

/**
 * Seize everything not yet paid to a hunter caught in provable fraud:
 * held bounty-role payments flip to 'forfeited' (never dispatched),
 * queued settlements flip to 'forfeited' (excluded from tiers and DPSV by
 * bounty-reputation), and CV resets so any future work is fully audited.
 * Already-dispatched money is not clawed back; the release gate exists to
 * keep that exposure to at most the pipeline.
 */
export function forfeitHunter(
  db: DatabaseSync,
  hunterPubkey: string,
  reason: string,
  now: number = Date.now(),
): ForfeitResult {
  const held = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS usd, COUNT(*) AS n
         FROM revenue_payment_queue
        WHERE recipient_peer_id = ? AND status = 'held'
          AND role IN ('bounty_reward', 'stream_check')`,
    )
    .get(hunterPubkey) as { usd: number; n: number };
  db.prepare(
    `UPDATE revenue_payment_queue SET status = 'forfeited', error = ?
      WHERE recipient_peer_id = ? AND status = 'held'
        AND role IN ('bounty_reward', 'stream_check')`,
  ).run(`forfeited: ${reason}`, hunterPubkey);
  const settlements = db
    .prepare(
      `UPDATE bounty_settlements SET status = 'forfeited', error = ?
        WHERE hunter_pubkey = ? AND status = 'queued'`,
    )
    .run(`forfeited: ${reason}`, hunterPubkey);
  recordAuditOutcome(db, hunterPubkey, "fraud", now);
  log.warn(
    `Forfeited hunter ${hunterPubkey.slice(0, 12)}…: $${held.usd.toFixed(4)} held across ` +
      `${held.n} payments, ${Number(settlements.changes)} settlements (${reason})`,
  );
  return {
    heldPaymentsForfeited: held.n,
    heldUsdForfeited: held.usd,
    settlementsForfeited: Number(settlements.changes),
  };
}

// ---------------------------------------------------------------------------
// The audit itself
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type AuditOutcome = {
  audited: boolean;
  verdict?: AuditVerdict;
  detail?: string;
};

async function fetchDigest(
  fetchImpl: FetchLike,
  url: string,
  scheme: string,
): Promise<{ digest: string; simhash: string; body: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (!res.ok) return { error: `http ${res.status}` };
    let body = await res.text();
    if (Buffer.byteLength(body, "utf-8") > MAX_AUDIT_BODY_BYTES) {
      body = body.slice(0, MAX_AUDIT_BODY_BYTES);
    }
    return { digest: contentDigest(body, scheme), simhash: simhash64(body), body };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Probabilistically audit the newest unaudited check on a stream. Runs
 * async in the HTTP layer AFTER the checkin response is sent (the sync
 * handler cannot fetch, and blocking the response would leak audit
 * timing). Every network call is awaited; failures never throw.
 */
export async function auditCheckinIfDue(opts: {
  db: DatabaseSync;
  streamId: string;
  fetchImpl: FetchLike;
  now?: number;
  /** Test seam: override the audit dice roll (0..1). */
  roll?: number;
}): Promise<AuditOutcome> {
  const now = opts.now ?? Date.now();
  const check = opts.db
    .prepare(
      `SELECT c.stream_id, c.seq, c.content_digest, c.digest_scheme, c.simhash,
              s.hunter_pubkey, b.spec_public
         FROM bounty_stream_checks c
         JOIN bounty_streams s ON s.id = c.stream_id
         JOIN bounty_posts b ON b.bounty_id = s.bounty_id
        WHERE c.stream_id = ? AND c.audit_status = 'unaudited'
        ORDER BY c.seq DESC LIMIT 1`,
    )
    .get(opts.streamId) as
    | {
        stream_id: string;
        seq: number;
        content_digest: string;
        digest_scheme: string;
        simhash: string | null;
        hunter_pubkey: string;
        spec_public: string;
      }
    | undefined;
  if (!check) return { audited: false };

  const state = getHunterAuditState(opts.db, check.hunter_pubkey);
  const p = auditProbability(state.cv);
  const roll = opts.roll ?? Math.random();
  if (roll >= p) return { audited: false };

  // The monitored URL rides in the bounty's machine block, same source the
  // hunter parsed at claim time.
  const urlMatch = /"url"\s*:\s*"(https?:\/\/[^"]+)"/.exec(check.spec_public);
  if (!urlMatch) return { audited: false };
  const monitorUrl = urlMatch[1];

  let verdict: AuditVerdict;
  let detail: string;
  const a = await fetchDigest(opts.fetchImpl, monitorUrl, check.digest_scheme);
  if ("error" in a) {
    const b = await fetchDigest(opts.fetchImpl, monitorUrl, check.digest_scheme);
    if ("error" in b) {
      // Both auditor fetches failed hard. NOT provable fraud (could be our
      // network, split DNS, an origin outage between checkin and audit) —
      // conservative verdict is 'failed': CV resets, nothing seized.
      verdict = "failed";
      detail = `auditor could not fetch: ${a.error} / ${b.error}`;
    } else {
      // One fetch worked; without a stability pair we cannot distinguish
      // page drift from a lie.
      verdict = b.digest === check.content_digest ? "pass" : "unverifiable";
      detail = `single-fetch ${verdict} (first fetch: ${a.error})`;
    }
  } else if (a.digest === check.content_digest) {
    verdict = "pass";
    detail = "digest match";
  } else {
    const b = await fetchDigest(opts.fetchImpl, monitorUrl, check.digest_scheme);
    if ("error" in b) {
      verdict = "unverifiable";
      detail = `mismatch but stability fetch failed: ${b.error}`;
    } else if (b.digest !== a.digest) {
      verdict = "unverifiable";
      detail = "page nondeterministic (auditor fetches disagree)";
    } else if (check.simhash && simhashDistance(a.simhash, check.simhash) <= SIMHASH_TOLERANCE) {
      verdict = "pass";
      detail = `simhash within tolerance (d=${simhashDistance(a.simhash, check.simhash)})`;
    } else {
      verdict = "failed";
      detail = "stable auditor content contradicts hunter digest";
    }
  }

  opts.db
    .prepare(
      `UPDATE bounty_stream_checks
          SET audit_status = ?, audited_at = ?, auditor_note = ?
        WHERE stream_id = ? AND seq = ?`,
    )
    .run(verdict, now, detail, check.stream_id, check.seq);
  opts.db
    .prepare(
      `UPDATE bounty_streams
          SET audits_total = audits_total + 1,
              audits_failed = audits_failed + ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(verdict === "failed" ? 1 : 0, now, check.stream_id);
  recordAuditOutcome(opts.db, check.hunter_pubkey, verdict, now);
  if (verdict === "failed") {
    log.warn(
      `Audit FAILED on stream ${check.stream_id} seq ${check.seq} ` +
        `(hunter ${check.hunter_pubkey.slice(0, 12)}…): ${detail}`,
    );
  }
  return { audited: true, verdict, detail };
}
