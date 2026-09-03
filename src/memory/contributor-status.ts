/**
 * PLAN-43 Phase 4 (D-D, invariant I5): status-based rewards for FREE
 * contribution. Never cash, never micro-tips. A contributor's standing on
 * this node is computed only from VERIFIED signals this node observed:
 *
 *   - skills of theirs this node holds (accepted through ingestion)
 *   - real executions of those skills here, and how many succeeded
 *   - attestations with measured verdicts on those skills (accepted vs
 *     regression), from this node and trusted peers
 *   - lineage credits: paid listings here that cite them as the source
 *     author (the gate's evidence, not a seller's claim)
 *   - penalties: corroborated fraud verdicts, bans
 *
 * Downloads, stars, view counts, and self-reported numbers never enter
 * (invariant I6). Tiers unlock PRIVILEGES, not money: ingestion trust
 * floor, a publication-rate lift on the anomaly detector, and multi-use
 * circle invites.
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./memory-schema.js";
import { isMeasuredVerdict, skillContentSha256 } from "./skill-evolution/attestation.js";

export type ContributorTier =
  | "newcomer"
  | "contributor"
  | "trusted_contributor"
  | "core"
  | "flagged";

export interface ContributorPrivileges {
  /** Ingestion trust floor applied by PeerReputationManager.getTrustLevel. */
  ingestTrustFloor: "none" | "trusted";
  /** Multiplier on the publication-rate anomaly threshold (3x average by default). */
  publicationRateMultiplier: 1 | 2 | 3;
  /** Max uses on a circle invite created for this contributor. */
  inviteMaxUses: 1 | 3 | 10;
}

export const TIER_PRIVILEGES: Record<ContributorTier, ContributorPrivileges> = {
  flagged: { ingestTrustFloor: "none", publicationRateMultiplier: 1, inviteMaxUses: 1 },
  newcomer: { ingestTrustFloor: "none", publicationRateMultiplier: 1, inviteMaxUses: 1 },
  contributor: { ingestTrustFloor: "none", publicationRateMultiplier: 2, inviteMaxUses: 3 },
  trusted_contributor: {
    ingestTrustFloor: "trusted",
    publicationRateMultiplier: 2,
    inviteMaxUses: 3,
  },
  core: { ingestTrustFloor: "trusted", publicationRateMultiplier: 3, inviteMaxUses: 10 },
};

const lastRecomputeAt = new WeakMap<DatabaseSync, number>();

export interface ContributorStanding {
  peerPubkey: string;
  tier: ContributorTier;
  /** 1 = highest score on this node; null when flagged/banned. */
  rank: number | null;
  score: number;
  skillsHeld: number;
  executions: number;
  successes: number;
  attestedAccepted: number;
  attestedRegressions: number;
  lineageCredits: number;
  fraudVerdicts: number;
  banned: boolean;
  /** Sticky flag timestamp; only clearFlag() removes it. */
  flaggedAt: number | null;
  computedAt: number;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name),
  );
}

/** Verified-signal score; every term is something this node measured. */
export function contributorScore(s: {
  successes: number;
  attestedAccepted: number;
  attestedRegressions: number;
  lineageCredits: number;
}): number {
  return (
    Math.min(s.successes, 200) +
    5 * s.attestedAccepted +
    3 * s.lineageCredits -
    8 * s.attestedRegressions
  );
}

/** Successes credited per skill are capped: one popular (or hijacked) skill cannot buy standing alone. */
export const MAX_SUCCESSES_PER_SKILL = 5;

export function tierFor(s: {
  skillsHeld: number;
  successes: number;
  attestedAccepted: number;
  attestedRegressions: number;
  fraudVerdicts: number;
  banned: boolean;
  flagged?: boolean;
}): ContributorTier {
  if (s.banned || s.fraudVerdicts > 0 || s.flagged) {
    return "flagged";
  }
  if (s.attestedRegressions > s.attestedAccepted) {
    return "newcomer";
  }
  // Every tier above "contributor" needs a MEASURED verdict (this node's
  // own re-scoring, or a trusted attester's): execution counts alone are
  // farmable (a skill named after a built-in tool inherits that tool's
  // successes), a rollout verdict on our corpus is not.
  if (s.attestedAccepted >= 3 && s.successes >= 20) {
    return "core";
  }
  if (s.attestedAccepted >= 1 && s.successes >= 5) {
    return "trusted_contributor";
  }
  if (s.skillsHeld >= 1 && (s.successes >= 1 || s.attestedAccepted >= 1)) {
    return "contributor";
  }
  return "newcomer";
}

export class ContributorStatusLedger {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contributor_status (
        peer_pubkey TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        rank INTEGER,
        score REAL NOT NULL,
        skills_held INTEGER NOT NULL,
        executions INTEGER NOT NULL,
        successes INTEGER NOT NULL,
        attested_accepted INTEGER NOT NULL,
        attested_regressions INTEGER NOT NULL,
        lineage_credits INTEGER NOT NULL,
        fraud_verdicts INTEGER NOT NULL,
        banned INTEGER NOT NULL,
        flagged_at INTEGER,
        computed_at INTEGER NOT NULL
      );
    `);
    ensureColumn(this.db, "contributor_status", "flagged_at", "INTEGER");
    if (tableExists(this.db, "peer_reputation")) {
      ensureColumn(this.db, "peer_reputation", "contributor_tier", "TEXT");
    }
  }

  /**
   * Recompute every contributor's standing from the tables of record and
   * mirror the tier onto peer_reputation (where the privileges are read).
   * Bounded: 5000 peer-origin skill rows.
   */
  recompute(opts: { now?: number; trustedAttesters?: ReadonlySet<string> } = {}): number {
    const now = opts.now ?? Date.now();
    const rows = this.db
      .prepare(
        `SELECT id, text, governance_json FROM chunks
          WHERE semantic_type IN ('skill', 'task_pattern')
            AND governance_json LIKE '%"peerOrigin"%'
            AND COALESCE(deprecated, 0) = 0
            AND COALESCE(lifecycle_state, 'active') = 'active'
          ORDER BY updated_at DESC LIMIT 5000`,
      )
      .all() as Array<{ id: string; text: string; governance_json: string | null }>;
    // Sticky flags: only an explicit operator clear removes one.
    const sticky = new Set(
      (
        this.db
          .prepare(`SELECT peer_pubkey FROM contributor_status WHERE flagged_at IS NOT NULL`)
          .all() as Array<{ peer_pubkey: string }>
      ).map((r) => r.peer_pubkey),
    );
    const hasExec = tableExists(this.db, "skill_executions");
    const hasAtt = tableExists(this.db, "skill_attestations");
    const hasListings = tableExists(this.db, "marketplace_listings");
    const hasFraud = tableExists(this.db, "fraud_verdicts");
    const hasRep = tableExists(this.db, "peer_reputation");
    // Executions credited to a skill only when the tracker attributed them
    // to that skill directly; rows recorded by the after_tool_call hook
    // are name matches on a built-in tool and are exactly the hijack path
    // (a peer skill named `browser` inheriting every browser call).
    const execStmt = hasExec
      ? this.db.prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS ok
             FROM skill_executions
            WHERE skill_crystal_id = ?
              AND COALESCE(recorded_by, '') != 'after_tool_call'`,
        )
      : null;
    const attStmt = hasAtt
      ? this.db.prepare(
          `SELECT attester_pubkey, verdict, source FROM skill_attestations WHERE content_sha256 = ?`,
        )
      : null;

    const acc = new Map<
      string,
      {
        skillsHeld: number;
        executions: number;
        successes: number;
        attestedAccepted: number;
        attestedRegressions: number;
      }
    >();
    for (const row of rows) {
      let author = "";
      try {
        const g = JSON.parse(row.governance_json ?? "{}") as { peerOrigin?: unknown };
        author = typeof g.peerOrigin === "string" ? g.peerOrigin : "";
      } catch {
        /* ignore */
      }
      if (!author) {
        continue;
      }
      const a = acc.get(author) ?? {
        skillsHeld: 0,
        executions: 0,
        successes: 0,
        attestedAccepted: 0,
        attestedRegressions: 0,
      };
      a.skillsHeld += 1;
      if (execStmt) {
        const e = execStmt.get(row.id) as { n: number; ok: number };
        a.executions += e.n;
        a.successes += Math.min(e.ok, MAX_SUCCESSES_PER_SKILL);
      }
      if (attStmt) {
        for (const att of attStmt.all(skillContentSha256(row.text)) as Array<{
          attester_pubkey: string;
          verdict: string;
          source: string;
        }>) {
          // Own verdicts always count; peer verdicts only from trusted attesters.
          const counts =
            att.source === "local" || opts.trustedAttesters?.has(att.attester_pubkey) === true;
          if (!counts || !isMeasuredVerdict(att.verdict)) {
            continue;
          }
          if (att.verdict === "accepted") {
            a.attestedAccepted += 1;
          } else if (att.verdict === "regression") {
            a.attestedRegressions += 1;
          }
        }
      }
      acc.set(author, a);
    }

    // Lineage credits: listings whose gate evidence names the author.
    const lineage = new Map<string, number>();
    if (hasListings) {
      try {
        for (const r of this.db
          .prepare(
            `SELECT lineage_author_pubkey AS a, COUNT(*) AS c FROM marketplace_listings
              WHERE lineage_author_pubkey IS NOT NULL GROUP BY lineage_author_pubkey`,
          )
          .all() as Array<{ a: string; c: number }>) {
          lineage.set(r.a, r.c);
        }
      } catch {
        /* older schema */
      }
    }
    const fraud = new Map<string, number>();
    if (hasFraud) {
      for (const r of this.db
        .prepare(
          `SELECT seller_pubkey AS a, COUNT(*) AS c FROM fraud_verdicts GROUP BY seller_pubkey`,
        )
        .all() as Array<{ a: string; c: number }>) {
        fraud.set(r.a, r.c);
      }
    }
    const banned = new Set<string>();
    if (hasRep) {
      for (const r of this.db
        .prepare(`SELECT peer_pubkey FROM peer_reputation WHERE is_banned = 1`)
        .all() as Array<{ peer_pubkey: string }>) {
        banned.add(r.peer_pubkey);
      }
    }
    for (const a of [...lineage.keys(), ...fraud.keys(), ...banned, ...sticky]) {
      if (!acc.has(a)) {
        acc.set(a, {
          skillsHeld: 0,
          executions: 0,
          successes: 0,
          attestedAccepted: 0,
          attestedRegressions: 0,
        });
      }
    }

    const standings: ContributorStanding[] = [...acc.entries()].map(([peerPubkey, a]) => {
      // Lineage credits capped: a near-duplicate flood must not farm them.
      const lineageCredits = Math.min(lineage.get(peerPubkey) ?? 0, 10);
      const fraudVerdicts = fraud.get(peerPubkey) ?? 0;
      const isBanned = banned.has(peerPubkey);
      const tier = tierFor({
        ...a,
        fraudVerdicts,
        banned: isBanned,
        flagged: sticky.has(peerPubkey),
      });
      return {
        peerPubkey,
        tier,
        rank: null,
        score: contributorScore({ ...a, lineageCredits }),
        ...a,
        lineageCredits,
        fraudVerdicts,
        banned: isBanned,
        flaggedAt: tier === "flagged" ? now : null,
        computedAt: now,
      };
    });
    const ranked = standings
      .filter((s) => s.tier !== "flagged")
      .toSorted((x, y) => y.score - x.score || x.peerPubkey.localeCompare(y.peerPubkey));
    ranked.forEach((s, i) => {
      s.rank = i + 1;
    });

    const upsert = this.db.prepare(
      `INSERT INTO contributor_status
         (peer_pubkey, tier, rank, score, skills_held, executions, successes, attested_accepted,
          attested_regressions, lineage_credits, fraud_verdicts, banned, flagged_at, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const mirror = hasRep
      ? this.db.prepare(`UPDATE peer_reputation SET contributor_tier = ? WHERE peer_pubkey = ?`)
      : null;
    // SAVEPOINT (not BEGIN): composable inside a caller's transaction.
    this.db.exec("SAVEPOINT contributor_status");
    try {
      // Preserve the first flagged_at for sticky rows.
      const firstFlagged = new Map(
        (
          this.db
            .prepare(
              `SELECT peer_pubkey, flagged_at FROM contributor_status WHERE flagged_at IS NOT NULL`,
            )
            .all() as Array<{ peer_pubkey: string; flagged_at: number }>
        ).map((r) => [r.peer_pubkey, r.flagged_at]),
      );
      this.db.prepare(`DELETE FROM contributor_status`).run();
      // Stale tiers must not outlive their evidence (a peer whose skills
      // were purged, or who fell past the row limit, keeps nothing).
      if (hasRep) {
        this.db.prepare(`UPDATE peer_reputation SET contributor_tier = NULL`).run();
      }
      for (const s of standings) {
        upsert.run(
          s.peerPubkey,
          s.tier,
          s.rank,
          s.score,
          s.skillsHeld,
          s.executions,
          s.successes,
          s.attestedAccepted,
          s.attestedRegressions,
          s.lineageCredits,
          s.fraudVerdicts,
          s.banned ? 1 : 0,
          s.flaggedAt === null ? null : (firstFlagged.get(s.peerPubkey) ?? s.flaggedAt),
          s.computedAt,
        );
        mirror?.run(s.tier, s.peerPubkey);
      }
      this.db.exec("RELEASE contributor_status");
    } catch (err) {
      this.db.exec("ROLLBACK TO contributor_status");
      this.db.exec("RELEASE contributor_status");
      throw err;
    }
    lastRecomputeAt.set(this.db, now);
    return standings.length;
  }

  /** Operator action: clear a sticky flag (the next recompute re-evaluates from evidence). */
  clearFlag(peerPubkey: string): boolean {
    const r = this.db
      .prepare(`UPDATE contributor_status SET flagged_at = NULL WHERE peer_pubkey = ?`)
      .run(peerPubkey) as { changes: number };
    return r.changes > 0;
  }

  /** True when a recompute ran within `minIntervalMs` (RPC throttle). */
  recomputedRecently(minIntervalMs: number, now: number = Date.now()): boolean {
    const last = lastRecomputeAt.get(this.db);
    return last !== undefined && now - last < minIntervalMs;
  }

  get(peerPubkey: string): ContributorStanding | null {
    const row = this.db
      .prepare(`SELECT * FROM contributor_status WHERE peer_pubkey = ?`)
      .get(peerPubkey) as Record<string, unknown> | undefined;
    return row ? rowToStanding(row) : null;
  }

  list(limit = 50): ContributorStanding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contributor_status ORDER BY rank IS NULL, rank ASC, score DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.map(rowToStanding);
  }

  privilegesFor(peerPubkey: string): ContributorPrivileges {
    return TIER_PRIVILEGES[this.get(peerPubkey)?.tier ?? "newcomer"];
  }
}

/** Read the mirrored tier straight off peer_reputation (cheap; used on hot paths). */
export function contributorTierOf(db: DatabaseSync, peerPubkey: string): ContributorTier {
  try {
    const row = db
      .prepare(`SELECT contributor_tier FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(peerPubkey) as { contributor_tier: string | null } | undefined;
    const t = row?.contributor_tier;
    return t && t in TIER_PRIVILEGES ? (t as ContributorTier) : "newcomer";
  } catch {
    return "newcomer";
  }
}

function rowToStanding(row: Record<string, unknown>): ContributorStanding {
  return {
    peerPubkey: String(row.peer_pubkey),
    tier: String(row.tier) as ContributorTier,
    rank: (row.rank as number | null) ?? null,
    score: Number(row.score),
    skillsHeld: Number(row.skills_held),
    executions: Number(row.executions),
    successes: Number(row.successes),
    attestedAccepted: Number(row.attested_accepted),
    attestedRegressions: Number(row.attested_regressions),
    lineageCredits: Number(row.lineage_credits),
    fraudVerdicts: Number(row.fraud_verdicts),
    banned: Number(row.banned) === 1,
    flaggedAt: (row.flagged_at as number | null) ?? null,
    computedAt: Number(row.computed_at),
  };
}

/**
 * Invite uses for a target-bound circle invite: the contributor's tier
 * privilege, unless the peer is banned (always 1). Reads the live rows so
 * a ban takes effect before the next recompute.
 */
export function inviteMaxUsesFor(db: DatabaseSync, peerPubkey: string): number {
  try {
    const row = db
      .prepare(`SELECT is_banned FROM peer_reputation WHERE peer_pubkey = ?`)
      .get(peerPubkey) as { is_banned: number } | undefined;
    if (row?.is_banned === 1) {
      return 1;
    }
  } catch {
    return 1;
  }
  return TIER_PRIVILEGES[contributorTierOf(db, peerPubkey)].inviteMaxUses;
}
