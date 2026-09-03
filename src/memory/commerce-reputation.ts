/**
 * PLAN-43 Phase 3 (§3.7): off-chain COMMERCE reputation, from this node's
 * own outbound A2A outcomes. Nothing here is a peer's claim about itself:
 * every row is a task THIS node sent, and whether the peer answered.
 *
 *   answerRate = answered / attempts       (did the peer deliver a result)
 *   uptime     = 1 - dialFailures / attempts (was the peer reachable at all)
 *
 * A peer that stops answering is QUARANTINED for a cooling period: the
 * A2A client refuses to spend on it until the window passes. Quarantine is
 * a ledger state, not a ban (bans are the skill-ingestion reputation's
 * job, PeerReputationManager); the two are deliberately separate so a
 * flaky seller does not lose its free-skill standing and a poisoned
 * publisher does not keep selling.
 */

import type { DatabaseSync } from "node:sqlite";

export const COMMERCE_MIN_ATTEMPTS_FOR_QUARANTINE = 5;
export const COMMERCE_QUARANTINE_ANSWER_RATE = 0.5;
export const COMMERCE_QUARANTINE_MS = 24 * 60 * 60 * 1000;

export type CommerceOutcome = "answered" | "dial_failure" | "failed";

export interface CommercePeerStanding {
  peerKey: string;
  peerPubkey: string | null;
  agentUrl: string | null;
  attempts: number;
  answered: number;
  dialFailures: number;
  answerRate: number | null;
  uptime: number | null;
  /** Attempts since the last quarantine (the auto-quarantine rule's window). */
  windowAttempts: number;
  windowAnswerRate: number | null;
  avgLatencyMs: number | null;
  lastAttemptAt: number | null;
  lastAnsweredAt: number | null;
  quarantinedUntil: number | null;
  quarantineReason: string | null;
}

/**
 * Stable key for a peer: the URL origin (scheme + host + port) for http(s)
 * endpoints; any other identifier (e.g. `peer:<pubkey>`) is used verbatim,
 * trimmed and lowercased. (A non-http scheme through `new URL` yields the
 * origin "null" for EVERY value — the 3d adversarial pass caught all fraud
 * quarantines collapsing onto one row.)
 */
export function commercePeerKey(id: string): string {
  const trimmed = id.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  return trimmed.toLowerCase();
}

/** Key for a seller identified by pubkey (fraud verdicts, marketplace authors). */
export function commercePubkeyKey(pubkey: string): string {
  return `peer:${pubkey.trim().toLowerCase()}`;
}

export class CommerceReputationLedger {
  constructor(private readonly db: DatabaseSync) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commerce_reputation (
        peer_key TEXT PRIMARY KEY,
        peer_pubkey TEXT,
        agent_url TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        answered INTEGER NOT NULL DEFAULT 0,
        dial_failures INTEGER NOT NULL DEFAULT 0,
        total_latency_ms INTEGER NOT NULL DEFAULT 0,
        window_attempts INTEGER NOT NULL DEFAULT 0,
        window_answered INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_answered_at INTEGER,
        quarantined_until INTEGER,
        quarantine_reason TEXT
      );
    `);
  }

  /** Record one outbound attempt and apply the auto-quarantine rule. */
  recordOutcome(params: {
    agentUrl: string;
    peerPubkey?: string | null;
    outcome: CommerceOutcome;
    latencyMs?: number;
    now?: number;
  }): CommercePeerStanding {
    const now = params.now ?? Date.now();
    const key = commercePeerKey(params.agentUrl);
    const answered = params.outcome === "answered" ? 1 : 0;
    const dial = params.outcome === "dial_failure" ? 1 : 0;
    const latency = Math.max(0, Math.round(params.latencyMs ?? 0));
    this.db
      .prepare(
        `INSERT INTO commerce_reputation
           (peer_key, peer_pubkey, agent_url, attempts, answered, dial_failures, total_latency_ms,
            window_attempts, window_answered, last_attempt_at, last_answered_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(peer_key) DO UPDATE SET
           peer_pubkey = COALESCE(excluded.peer_pubkey, commerce_reputation.peer_pubkey),
           agent_url = excluded.agent_url,
           attempts = commerce_reputation.attempts + 1,
           answered = commerce_reputation.answered + excluded.answered,
           window_attempts = commerce_reputation.window_attempts + 1,
           window_answered = commerce_reputation.window_answered + excluded.answered,
           dial_failures = commerce_reputation.dial_failures + excluded.dial_failures,
           total_latency_ms = commerce_reputation.total_latency_ms + excluded.total_latency_ms,
           last_attempt_at = excluded.last_attempt_at,
           last_answered_at = COALESCE(excluded.last_answered_at, commerce_reputation.last_answered_at)`,
      )
      .run(
        key,
        params.peerPubkey ?? null,
        params.agentUrl,
        answered,
        dial,
        latency,
        answered,
        now,
        answered ? now : null,
      );
    const standing = this.getPeer(key)!;
    // The rule runs over the CURRENT window (attempts since the last
    // quarantine), not lifetime totals: a peer that recovers after one
    // outage must be able to earn its way back in a handful of calls.
    if (
      standing.windowAttempts >= COMMERCE_MIN_ATTEMPTS_FOR_QUARANTINE &&
      (standing.windowAnswerRate ?? 1) < COMMERCE_QUARANTINE_ANSWER_RATE &&
      (standing.quarantinedUntil ?? 0) < now
    ) {
      this.quarantine(
        key,
        now + COMMERCE_QUARANTINE_MS,
        `answer rate ${((standing.windowAnswerRate ?? 0) * 100).toFixed(0)}% over ${standing.windowAttempts} recent attempts`,
      );
      return this.getPeer(key)!;
    }
    return standing;
  }

  quarantine(peerKeyOrUrl: string, untilMs: number, reason: string): void {
    const key = commercePeerKey(peerKeyOrUrl);
    this.db
      .prepare(
        `INSERT INTO commerce_reputation (peer_key, quarantined_until, quarantine_reason)
         VALUES (?, ?, ?)
         ON CONFLICT(peer_key) DO UPDATE SET
           quarantined_until = excluded.quarantined_until,
           quarantine_reason = excluded.quarantine_reason,
           window_attempts = 0,
           window_answered = 0`,
      )
      .run(key, untilMs, reason.slice(0, 200));
  }

  clearQuarantine(peerKeyOrUrl: string): void {
    this.db
      .prepare(
        `UPDATE commerce_reputation SET quarantined_until = NULL, quarantine_reason = NULL WHERE peer_key = ?`,
      )
      .run(commercePeerKey(peerKeyOrUrl));
  }

  /** Active quarantine (with reason) or null. */
  /**
   * Checks the endpoint row AND the seller-pubkey row (`peer:<pubkey>`),
   * using the pubkey given or the one remembered for that endpoint — so a
   * fraud quarantine keyed by author pubkey actually blocks dialing the
   * seller's endpoint.
   */
  quarantineFor(
    peerKeyOrUrl: string,
    now: number = Date.now(),
    peerPubkey?: string | null,
  ): { until: number; reason: string } | null {
    const p = this.getPeer(commercePeerKey(peerKeyOrUrl));
    if (p?.quarantinedUntil && p.quarantinedUntil > now) {
      return { until: p.quarantinedUntil, reason: p.quarantineReason ?? "quarantined" };
    }
    const pubkey = peerPubkey ?? p?.peerPubkey ?? null;
    if (pubkey) {
      const q = this.getPeer(commercePubkeyKey(pubkey));
      if (q?.quarantinedUntil && q.quarantinedUntil > now) {
        return { until: q.quarantinedUntil, reason: q.quarantineReason ?? "quarantined" };
      }
    }
    return null;
  }

  getPeer(peerKeyOrUrl: string): CommercePeerStanding | null {
    const row = this.db
      .prepare(`SELECT * FROM commerce_reputation WHERE peer_key = ?`)
      .get(commercePeerKey(peerKeyOrUrl)) as Record<string, unknown> | undefined;
    return row ? rowToStanding(row) : null;
  }

  listPeers(limit = 20): CommercePeerStanding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM commerce_reputation ORDER BY COALESCE(last_attempt_at, 0) DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
    return rows.map(rowToStanding);
  }
}

function rowToStanding(row: Record<string, unknown>): CommercePeerStanding {
  const attempts = Number(row.attempts ?? 0);
  const answered = Number(row.answered ?? 0);
  const dial = Number(row.dial_failures ?? 0);
  const latency = Number(row.total_latency_ms ?? 0);
  return {
    peerKey: String(row.peer_key),
    peerPubkey: (row.peer_pubkey as string | null) ?? null,
    agentUrl: (row.agent_url as string | null) ?? null,
    attempts,
    answered,
    dialFailures: dial,
    answerRate: attempts > 0 ? answered / attempts : null,
    uptime: attempts > 0 ? 1 - dial / attempts : null,
    windowAttempts: Number(row.window_attempts ?? 0),
    windowAnswerRate:
      Number(row.window_attempts ?? 0) > 0
        ? Number(row.window_answered ?? 0) / Number(row.window_attempts ?? 0)
        : null,
    avgLatencyMs: answered > 0 ? Math.round(latency / answered) : null,
    lastAttemptAt: (row.last_attempt_at as number | null) ?? null,
    lastAnsweredAt: (row.last_answered_at as number | null) ?? null,
    quarantinedUntil: (row.quarantined_until as number | null) ?? null,
    quarantineReason: (row.quarantine_reason as string | null) ?? null,
  };
}
