/**
 * PLAN-43 Phase 4 (I5/I6): contributor standing comes only from verified
 * signals this node observed; tiers unlock privileges, never money.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { revokeInvitesForTarget } from "../circles/invites.js";
import { generateKeyPair, pubkeyId } from "../commerce/envelope.js";
import {
  ContributorStatusLedger,
  contributorTierOf,
  inviteMaxUsesFor,
  TIER_PRIVILEGES,
  tierFor,
} from "./contributor-status.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";
import { PeerReputationManager } from "./peer-reputation.js";
import {
  ATTEST_PROTOCOL,
  signAttestation,
  skillContentSha256,
  storeAttestation,
} from "./skill-evolution/attestation.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

const ME = generateKeyPair();

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db: d, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
  ensureColumn(d, "chunks", "semantic_type", "TEXT");
  ensureColumn(d, "chunks", "governance_json", "TEXT");
  ensureColumn(d, "chunks", "download_count", "INTEGER DEFAULT 0");
  d.exec(`CREATE TABLE IF NOT EXISTS skill_executions (
    id TEXT PRIMARY KEY, skill_crystal_id TEXT NOT NULL, session_id TEXT,
    started_at INTEGER NOT NULL, completed_at INTEGER, success INTEGER,
    reward_score REAL, error_type TEXT, error_detail TEXT,
    execution_time_ms INTEGER, tool_calls_count INTEGER, user_feedback INTEGER)`);
  d.exec(`CREATE TABLE IF NOT EXISTS peer_reputation (
    peer_pubkey TEXT PRIMARY KEY, peer_id TEXT, skills_received INTEGER DEFAULT 0,
    skills_accepted INTEGER DEFAULT 0, skills_rejected INTEGER DEFAULT 0, avg_skill_quality REAL DEFAULT 0,
    reputation_score REAL DEFAULT 0.5, trust_level TEXT DEFAULT 'provisional', first_seen_at INTEGER,
    last_seen_at INTEGER, is_banned INTEGER DEFAULT 0, is_trusted INTEGER DEFAULT 0,
    eigentrust_score REAL DEFAULT 0.5, anomaly_flag INTEGER DEFAULT 0, wallet_address TEXT)`);
  return d;
}

function skill(d: DatabaseSync, id: string, author: string, downloads = 0): void {
  d.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, semantic_type, governance_json, download_count)
     VALUES (?, ?, 'memory', 0, 0, ?, 'test', ?, '[]', 1, 'skill', ?, ?)`,
  ).run(id, `s/${id}`, `h-${id}`, `# ${id}`, JSON.stringify({ peerOrigin: author }), downloads);
}

/** Directly attributed executions with a stamped run outcome (PLAN-45 Phase 1.1). */
function runs(d: DatabaseSync, id: string, ok: number, bad = 0): void {
  for (let i = 0; i < ok + bad; i += 1) {
    d.prepare(
      `INSERT INTO skill_executions (id, skill_crystal_id, started_at, success, evidence, run_outcome_label, run_outcome_level)
       VALUES (?, ?, ?, ?, 'run', ?, 1)`,
    ).run(`${id}-${i}`, id, 1, i < ok ? 1 : 0, i < ok ? "pass" : "fail");
  }
}

function attest(d: DatabaseSync, id: string, verdict: "accepted" | "regression", key = ME): void {
  storeAttestation(
    d,
    signAttestation(
      {
        protocol: ATTEST_PROTOCOL,
        content_sha256: skillContentSha256(`# ${id}`),
        corpus_version: "canonical-g3-s1",
        corpus_seed: 1,
        private_suite_sha256: null,
        verdict,
        wins: verdict === "accepted" ? 5 : 0,
        losses: 0,
        ties: 0,
        p_value: 0.01,
        regressions: verdict === "regression" ? 2 : 0,
        trials_per_task: 1,
        model: null,
        attested_at: Date.now(),
        node_pubkey: null,
      },
      key,
    ),
    key === ME ? "local" : "peer",
  );
}

describe("tierFor", () => {
  it("climbs on verified signals only and flags fraud/bans", () => {
    const base = {
      skillsHeld: 1,
      successes: 0,
      attestedAccepted: 0,
      attestedRegressions: 0,
      fraudVerdicts: 0,
      banned: false,
    };
    expect(tierFor(base)).toBe("newcomer");
    expect(tierFor({ ...base, successes: 1 })).toBe("contributor");
    // Execution counts alone never climb past contributor (they are farmable).
    expect(tierFor({ ...base, successes: 10_000 })).toBe("contributor");
    expect(tierFor({ ...base, attestedAccepted: 1 })).toBe("contributor");
    expect(tierFor({ ...base, attestedAccepted: 1, successes: 5 })).toBe("trusted_contributor");
    expect(tierFor({ ...base, successes: 5, flagged: true })).toBe("flagged");
    expect(tierFor({ ...base, attestedAccepted: 3, successes: 20 })).toBe("core");
    expect(tierFor({ ...base, attestedAccepted: 3, successes: 20, attestedRegressions: 4 })).toBe(
      "newcomer",
    );
    expect(tierFor({ ...base, attestedAccepted: 3, successes: 20, fraudVerdicts: 1 })).toBe(
      "flagged",
    );
    expect(tierFor({ ...base, attestedAccepted: 3, successes: 20, banned: true })).toBe("flagged");
    expect(TIER_PRIVILEGES.core.inviteMaxUses).toBe(10);
    expect(TIER_PRIVILEGES.flagged.ingestTrustFloor).toBe("none");
  });
});

describe("ContributorStatusLedger", () => {
  it("ranks by executions, attestations, and lineage credits; downloads are worth nothing", () => {
    const d = db();
    skill(d, "a1", "pk-alice");
    skill(d, "a2", "pk-alice");
    for (let i = 3; i <= 6; i += 1) {
      skill(d, `a${i}`, "pk-alice");
      runs(d, `a${i}`, 5);
    }
    runs(d, "a1", 25); // capped to 5 per skill: 5 skills x 5 = 25 successes
    attest(d, "a1", "accepted");
    attest(d, "a2", "accepted");
    attest(d, "a2", "accepted", generateKeyPair()); // untrusted peer verdict: ignored
    skill(d, "b1", "pk-bob", 100_000); // a download farm
    runs(d, "b1", 2);
    skill(d, "c1", "pk-carol");
    const ledger = new ContributorStatusLedger(d);
    expect(ledger.recompute()).toBe(3);
    const [first, second, third] = ledger.list();
    expect(first?.peerPubkey).toBe("pk-alice");
    expect(first?.tier).toBe("trusted_contributor"); // 2 accepted (own), 25 capped successes: not yet core
    expect(first?.successes).toBe(25);
    expect(first?.attestedAccepted).toBe(2);
    expect(first?.rank).toBe(1);
    expect(second?.peerPubkey).toBe("pk-bob");
    expect(second?.tier).toBe("contributor");
    expect(third?.peerPubkey).toBe("pk-carol");
    expect(third?.tier).toBe("newcomer");
    expect(contributorTierOf(d, "pk-alice")).toBe("newcomer"); // no peer_reputation row yet: default
    d.prepare(
      `INSERT INTO peer_reputation (peer_pubkey, first_seen_at, last_seen_at) VALUES ('pk-alice', 1, 1)`,
    ).run();
    ledger.recompute();
    expect(contributorTierOf(d, "pk-alice")).toBe("trusted_contributor");
    // A trusted peer's verdict counts once configured as trusted.
    const trusted = generateKeyPair();
    attest(d, "a1", "accepted", trusted);
    ledger.recompute({ trustedAttesters: new Set([pubkeyId(trusted)]) });
    expect(ledger.get("pk-alice")?.tier).toBe("core");
  });

  it("a regression or ban strips standing; a fraud verdict flags and stays flagged until cleared", () => {
    const d = db();
    skill(d, "x1", "pk-x");
    runs(d, "x1", 30);
    attest(d, "x1", "accepted");
    attest(d, "x1", "regression", generateKeyPair());
    const ledger = new ContributorStatusLedger(d);
    ledger.recompute();
    expect(ledger.get("pk-x")?.tier).toBe("trusted_contributor"); // untrusted regression ignored
    attest(d, "x1", "regression");
    ledger.recompute();
    // Own regression replaces own accepted (one record per attester): regressions > accepted.
    expect(ledger.get("pk-x")?.tier).toBe("newcomer");
    d.exec(
      `CREATE TABLE fraud_verdicts (content_sha256 TEXT, seller_pubkey TEXT, attester_pubkey TEXT, recorded_at INTEGER)`,
    );
    d.prepare(`INSERT INTO fraud_verdicts VALUES ('s', 'pk-x', 'me', 1)`).run();
    ledger.recompute();
    expect(ledger.get("pk-x")?.tier).toBe("flagged");
    expect(ledger.get("pk-x")?.rank).toBeNull();
    // Sticky: deleting the verdict rows does not clear the flag; an operator clear does.
    d.prepare(`DELETE FROM fraud_verdicts`).run();
    ledger.recompute();
    expect(ledger.get("pk-x")?.tier).toBe("flagged");
    expect(ledger.clearFlag("pk-x")).toBe(true);
    ledger.recompute();
    expect(ledger.get("pk-x")?.tier).toBe("newcomer");
  });

  it("ignores hook-attributed tool-name matches, clears stale tiers, and bans reach invites", () => {
    const d = db();
    skill(d, "h1", "pk-hijack");
    // 40 "successes" recorded by the after_tool_call name match: worth nothing.
    for (let i = 0; i < 40; i += 1) {
      d.prepare(
        `INSERT INTO skill_executions (id, skill_crystal_id, started_at, success, recorded_by) VALUES (?, 'h1', 1, 1, 'after_tool_call')`,
      ).run(`h1-${i}`);
    }
    const ledger = new ContributorStatusLedger(d);
    ledger.recompute();
    expect(ledger.get("pk-hijack")?.tier).toBe("newcomer");
    expect(ledger.get("pk-hijack")?.successes).toBe(0);

    // Stale tier: a peer whose skills vanish keeps nothing.
    d.prepare(
      `INSERT INTO peer_reputation (peer_pubkey, first_seen_at, last_seen_at, contributor_tier) VALUES ('pk-gone', 1, 1, 'core')`,
    ).run();
    ledger.recompute();
    expect(contributorTierOf(d, "pk-gone")).toBe("newcomer");

    // Ban: invites drop to one use immediately, and open target-bound invites are revoked.
    d.prepare(
      `INSERT INTO circle_invites
         (invite_id, circle_id, inviter_pubkey, token_hash, scopes_json, max_uses, uses, expires_at, status, created_at, target_pubkey)
       VALUES ('i1', 'c1', 'me', 'th', '[]', 10, 0, 9999999999999, 'open', 1, 'pk-t')`,
    ).run();
    d.prepare(
      `INSERT INTO peer_reputation (peer_pubkey, first_seen_at, last_seen_at, contributor_tier) VALUES ('pk-t', 1, 1, 'core')`,
    ).run();
    expect(inviteMaxUsesFor(d, "pk-t")).toBe(10);
    const rep = new PeerReputationManager(d, new SkillExecutionTracker(d));
    rep.onBan((pk) => revokeInvitesForTarget(d, pk));
    rep.banPeer("pk-t");
    expect(inviteMaxUsesFor(d, "pk-t")).toBe(1);
    expect(
      (
        d.prepare(`SELECT status FROM circle_invites WHERE invite_id = 'i1'`).get() as {
          status: string;
        }
      ).status,
    ).toBe("revoked");
  });

  it("mirrors the tier into peer reputation: trusted contributors get the ingestion floor and rate lift", () => {
    const d = db();
    skill(d, "t1", "pk-t");
    runs(d, "t1", 12);
    attest(d, "t1", "accepted");
    d.prepare(
      `INSERT INTO peer_reputation (peer_pubkey, skills_received, skills_accepted, first_seen_at, last_seen_at, reputation_score)
       VALUES ('pk-t', 5, 5, ?, ?, 0.4)`,
    ).run(Date.now(), Date.now());
    const tracker = new SkillExecutionTracker(d);
    const rep = new PeerReputationManager(d, tracker);
    expect(rep.getTrustLevel("pk-t")).toBe("provisional");
    new ContributorStatusLedger(d).recompute();
    expect(rep.getTrustLevel("pk-t")).toBe("trusted");
    expect(rep.publicationRateMultiplier("pk-t")).toBe(2);
    // Never above trusted: verification stays earned the reputation way.
    d.prepare(
      `UPDATE peer_reputation SET contributor_tier = 'core' WHERE peer_pubkey = 'pk-t'`,
    ).run();
    expect(rep.getTrustLevel("pk-t")).toBe("trusted");
    expect(rep.publicationRateMultiplier("pk-t")).toBe(3);
    // A ban always wins.
    rep.banPeer("pk-t");
    expect(rep.getTrustLevel("pk-t")).toBe("banned");
  });
});
