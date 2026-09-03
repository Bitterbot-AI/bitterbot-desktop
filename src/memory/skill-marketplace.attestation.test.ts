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
  });
});
