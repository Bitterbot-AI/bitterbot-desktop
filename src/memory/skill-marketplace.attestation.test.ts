/**
 * PLAN-43 Phase 3 (3c): the free browse layer surfaces the verified-outcome
 * aggregate on every entry and can rank by it ("attested") — never by price.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../commerce/envelope.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";
import { PeerReputationManager } from "./peer-reputation.js";
import {
  ATTEST_PROTOCOL,
  signAttestation,
  skillContentSha256,
  storeAttestation,
  type SkillAttestation,
} from "./skill-evolution/attestation.js";
import { makeAttesterWeight } from "./skill-evolution/attester-weight.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { SkillMarketplace } from "./skill-marketplace.js";

const TRUSTED = generateKeyPair();

function att(text: string, over: Partial<SkillAttestation>, key = TRUSTED): SkillAttestation {
  return signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: skillContentSha256(text),
      corpus_version: "canonical-g3-s5",
      corpus_seed: 5,
      private_suite_sha256: null,
      verdict: "accepted",
      wins: 5,
      losses: 0,
      ties: 1,
      p_value: 0.02,
      regressions: 0,
      trials_per_task: 3,
      model: null,
      attested_at: Date.now(),
      node_pubkey: null,
      ...over,
    },
    key,
  );
}

function insertSkill(db: DatabaseSync, id: string, text: string): void {
  db.prepare(
    `INSERT INTO chunks (id, stable_skill_id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
       semantic_type, governance_json, importance_score)
     VALUES (?, ?, ?, 'skills', 0, 0, ?, 'test', ?, '[]', ?, 'skill', ?, 0.8)`,
  ).run(
    id,
    id,
    `skills/${id}`,
    `h-${id}`,
    text,
    Date.now(),
    JSON.stringify({ accessScope: "shared", sensitivity: "normal", provenanceChain: [] }),
  );
}

describe("SkillMarketplace attestation surface", () => {
  it("exposes the aggregate per entry and ranks 'attested' by verified outcome", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
    ensureColumn(db, "chunks", "publish_visibility", "TEXT");
    const tracker = new SkillExecutionTracker(db);
    const rep = new PeerReputationManager(db, tracker);
    const marketplace = new SkillMarketplace(db, tracker, rep, {
      attesterWeight: makeAttesterWeight({ trustedAttesters: [pubkeyId(TRUSTED)] }),
      contributorStatus: (pk) => (pk === "pk-core" ? { tier: "core", rank: 1 } : null),
    });
    const good = "# Good skill\nDeploy with docker.";
    const bad = "# Bad skill\nDeploy with docker badly.";
    const none = "# Unscored skill\nDeploy with docker too.";
    insertSkill(db, "good", good);
    insertSkill(db, "bad", bad);
    insertSkill(db, "none", none);
    for (const id of ["good", "bad", "none"]) {
      expect(marketplace.listSkill(id, "docker")).toBe(true);
    }
    storeAttestation(db, att(good, {}), "local");
    storeAttestation(
      db,
      att(bad, { verdict: "regression", wins: 0, losses: 3, ties: 0, regressions: 2 }),
      "peer",
    );
    // A stale-generation verdict for `none` must not count.
    storeAttestation(
      db,
      att(none, { corpus_version: "canonical-g2-s5" }, generateKeyPair()),
      "peer",
    );

    const ranked = marketplace.search("docker", { sortBy: "attested" });
    expect(ranked.map((e) => e.stableSkillId)).toEqual(["good", "none", "bad"]);
    const byId = new Map(ranked.map((e) => [e.stableSkillId, e.attestation]));
    expect(byId.get("good")?.score).toBeCloseTo(5 / 6);
    expect(byId.get("good")).toMatchObject({ attesters: 1, regressions: 0 });
    expect(byId.get("bad")).toMatchObject({ score: -1, attesters: 1, regressions: 1 });
    expect(byId.get("none")?.score).toBeNull();
    // Phase 4: entries carry the author's standing when known.
    db.prepare(`UPDATE chunks SET governance_json = ? WHERE id = 'good'`).run(
      JSON.stringify({ accessScope: "shared", sensitivity: "normal", peerOrigin: "pk-core" }),
    );
    const withStanding = marketplace.search("docker").find((e) => e.stableSkillId === "good");
    expect(withStanding?.contributor).toEqual({ tier: "core", rank: 1 });
  });

  it("a banned publisher's skills leave the browse layer with the ban (§3.7)", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
    ensureColumn(db, "chunks", "publish_visibility", "TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS peer_reputation (
      peer_pubkey TEXT PRIMARY KEY, peer_id TEXT, skills_received INTEGER DEFAULT 0,
      skills_accepted INTEGER DEFAULT 0, skills_rejected INTEGER DEFAULT 0, avg_skill_quality REAL DEFAULT 0,
      reputation_score REAL DEFAULT 0.5, trust_level TEXT DEFAULT 'provisional', first_seen_at INTEGER,
      last_seen_at INTEGER, is_banned INTEGER DEFAULT 0, eigentrust_score REAL DEFAULT 0, wallet_address TEXT)`);
    const tracker = new SkillExecutionTracker(db);
    const rep = new PeerReputationManager(db, tracker);
    const marketplace = new SkillMarketplace(db, tracker, rep);
    db.prepare(
      `INSERT INTO chunks (id, stable_skill_id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
         semantic_type, governance_json, importance_score)
       VALUES ('peer-skill', 'peer-skill', 'skills/peer', 'skills', 0, 0, 'h', 'test', '# Peer docker skill', '[]', 1, 'skill', ?, 0.8)`,
    ).run(JSON.stringify({ accessScope: "shared", sensitivity: "normal", peerOrigin: "pk-evil" }));
    expect(marketplace.listSkill("peer-skill", "docker")).toBe(true);
    expect(marketplace.search("docker").map((e) => e.stableSkillId)).toEqual(["peer-skill"]);
    rep.banPeer("pk-evil");
    expect(marketplace.search("docker")).toEqual([]);
  });
});
