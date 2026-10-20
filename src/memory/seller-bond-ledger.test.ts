/**
 * PLAN-43 Phase 3 (§3.7): the seller bond is a LEDGER (no funds move);
 * this node's own regression attestation is the validated-fraud trigger
 * that slashes it and quarantines the seller.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../commerce/envelope.js";
import { CommerceReputationLedger } from "./commerce-reputation.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";
import { SellerBondLedger } from "./seller-bond-ledger.js";
import {
  ATTEST_PROTOCOL,
  signAttestation,
  skillContentSha256,
  storeAttestation,
} from "./skill-evolution/attestation.js";

const ME = generateKeyPair();

describe("SellerBondLedger", () => {
  it("posts, releases, and slashes bonds as ledger rows only", () => {
    const ledger = new SellerBondLedger(new DatabaseSync(":memory:"));
    const a = ledger.postBond("pk-seller", 5);
    const b = ledger.postBond("pk-seller", 2);
    expect(() => ledger.postBond("pk-seller", 0)).toThrow();
    expect(ledger.summary()).toMatchObject({ posted: 2, slashed: 0, released: 0, atRiskUsdc: 7 });
    expect(ledger.releaseBond(b.id)).toBe(true);
    expect(ledger.releaseBond(b.id)).toBe(false);
    expect(ledger.slashSeller("pk-seller", "fraud", { why: "test" })).toBe(1);
    expect(ledger.get(a.id)?.status).toBe("slashed");
    expect(ledger.get(a.id)?.evidence).toEqual({ why: "test" });
    expect(ledger.summary()).toMatchObject({ posted: 0, slashed: 1, released: 1, atRiskUsdc: 0 });
    expect(ledger.list("pk-seller")).toHaveLength(2);
  });

  it("applyRegressionVerdicts slashes + quarantines the seller of a skill we attested as a regression, once", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
    ensureColumn(db, "chunks", "semantic_type", "TEXT");
    ensureColumn(db, "chunks", "governance_json", "TEXT");
    const text = "# Peer skill\nbreaks things";
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, semantic_type, governance_json)
       VALUES ('p1', 's/p1', 'memory', 0, 0, 'h', 'test', ?, '[]', 1, 'skill', ?)`,
    ).run(text, JSON.stringify({ peerOrigin: "pk-bad" }));
    const bonds = new SellerBondLedger(db);
    const commerce = new CommerceReputationLedger(db);
    bonds.postBond("pk-bad", 3);

    // No verdict yet: nothing happens.
    expect(bonds.applyRegressionVerdicts({ ownAttesterPubkey: pubkeyId(ME), commerce })).toEqual({
      verdicts: 0,
      sellersSlashed: [],
    });

    storeAttestation(
      db,
      signAttestation(
        {
          protocol: ATTEST_PROTOCOL,
          content_sha256: skillContentSha256(text),
          corpus_version: "canonical-g3-s1",
          corpus_seed: 1,
          private_suite_sha256: null,
          verdict: "regression",
          wins: 0,
          losses: 2,
          ties: 0,
          p_value: 1,
          regressions: 2,
          trials_per_task: 1,
          model: null,
          attested_at: Date.now(),
          node_pubkey: null,
        },
        ME,
      ),
      "local",
    );
    const r = bonds.applyRegressionVerdicts({
      ownAttesterPubkey: pubkeyId(ME),
      commerce,
      now: 5000,
    });
    expect(r).toEqual({ verdicts: 1, sellersSlashed: ["pk-bad"] });
    expect(bonds.summary().slashed).toBe(1);
    expect(commerce.quarantineFor("peer:pk-bad", 5001)?.reason).toContain("regression attested");
    // Idempotent per (skill, seller).
    expect(
      bonds.applyRegressionVerdicts({ ownAttesterPubkey: pubkeyId(ME), commerce }).verdicts,
    ).toBe(0);
  });

  it("keeps sellers on distinct quarantine rows and needs corroboration for a single-task regression", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, embeddingCacheTable: "ec", ftsTable: "fts", ftsEnabled: false });
    ensureColumn(db, "chunks", "semantic_type", "TEXT");
    ensureColumn(db, "chunks", "governance_json", "TEXT");
    const ins = db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, semantic_type, governance_json)
       VALUES (?, ?, 'memory', 0, 0, ?, 'test', ?, '[]', 1, 'skill', ?)`,
    );
    ins.run("a", "s/a", "ha", "# A", JSON.stringify({ peerOrigin: "pk-a" }));
    ins.run("b", "s/b", "hb", "# B", JSON.stringify({ peerOrigin: "pk-b" }));
    const attest = (text: string, regressions: number, key = ME) =>
      storeAttestation(
        db,
        signAttestation(
          {
            protocol: ATTEST_PROTOCOL,
            content_sha256: skillContentSha256(text),
            corpus_version: "canonical-g3-s1",
            corpus_seed: 1,
            private_suite_sha256: null,
            verdict: "regression",
            wins: 0,
            losses: 1,
            ties: 0,
            p_value: 1,
            regressions,
            trials_per_task: 1,
            model: null,
            attested_at: Date.now(),
            node_pubkey: null,
          },
          key,
        ),
        key === ME ? "local" : "peer",
      );
    attest("# A", 3);
    attest("# B", 1); // single task: not corroborated yet
    const bonds = new SellerBondLedger(db);
    const commerce = new CommerceReputationLedger(db);
    expect(bonds.applyRegressionVerdicts({ ownAttesterPubkey: pubkeyId(ME), commerce })).toEqual({
      verdicts: 1,
      sellersSlashed: ["pk-a"],
    });
    // A second attester's regression corroborates B.
    attest("# B", 1, generateKeyPair());
    expect(
      bonds.applyRegressionVerdicts({ ownAttesterPubkey: pubkeyId(ME), commerce }).sellersSlashed,
    ).toEqual(["pk-b"]);
    const rows = commerce
      .listPeers()
      .map((p) => p.peerKey)
      .toSorted();
    expect(rows).toEqual(["peer:pk-a", "peer:pk-b"]);
    expect(bonds.summary()).toMatchObject({
      fraudVerdicts: 2,
      sellersWithVerdicts: ["pk-a", "pk-b"],
    });
  });
});
