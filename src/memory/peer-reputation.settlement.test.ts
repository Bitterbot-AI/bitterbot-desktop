import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { PeerReputationManager } from "./peer-reputation.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

// PLAN-26 §7.2 — commerce-grade counterparty reputation: settlement outcomes
// feed a "commerce"-scoped trust signal, separate from skill-sharing trust.

function openRep(): { db: DatabaseSync; rep: PeerReputationManager } {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return { db, rep: new PeerReputationManager(db, new SkillExecutionTracker(db)) };
}

function edgeWeight(db: DatabaseSync, trustee: string): number | undefined {
  const row = db
    .prepare(
      `SELECT trust_weight FROM peer_trust_edges WHERE truster_pubkey='local' AND trustee_pubkey=?`,
    )
    .get(trustee) as { trust_weight: number } | undefined;
  return row?.trust_weight;
}

describe("recordSettlementOutcome", () => {
  let db: DatabaseSync;
  let rep: PeerReputationManager;
  beforeEach(() => {
    ({ db, rep } = openRep());
  });

  it("a full settled order lifts commerce reputation and trust", () => {
    rep.recordSettlementOutcome("ed25519:buyer", "buyer", "settled", 100);
    expect(rep.getCategoryReputation("ed25519:buyer", "commerce")).toBeGreaterThan(0.5);
    expect(edgeWeight(db, "ed25519:buyer")).toBeCloseTo(1.0, 5);
  });

  it("a default tanks commerce reputation and trust", () => {
    rep.recordSettlementOutcome("ed25519:flake", "buyer", "defaulted", 50);
    expect(rep.getCategoryReputation("ed25519:flake", "commerce")).toBeLessThan(0.5);
    expect(edgeWeight(db, "ed25519:flake")).toBeCloseTo(0.2, 5);
  });

  it("a dispute records a middling penalty", () => {
    rep.recordSettlementOutcome("ed25519:supplier", "supplier", "disputed", 200);
    expect(edgeWeight(db, "ed25519:supplier")).toBeCloseTo(0.35, 5);
  });

  it("scales settled trust by amount (deposit size matters)", () => {
    rep.recordSettlementOutcome("ed25519:small", "buyer", "settled", 50); // factor 0.5 -> 0.75
    expect(edgeWeight(db, "ed25519:small")).toBeCloseTo(0.75, 5);
  });

  it("does not touch skill-sharing trust categories", () => {
    rep.recordSettlementOutcome("ed25519:buyer", "buyer", "settled", 100);
    // commerce score is set; an unrelated category stays at the 0.5 default
    expect(rep.getCategoryReputation("ed25519:buyer", "skill")).toBe(0.5);
    expect(rep.getCategoryReputation("ed25519:buyer", "commerce")).toBeGreaterThan(0.5);
  });

  it("logs a role-tagged settlement activity event", () => {
    rep.recordSettlementOutcome("ed25519:buyer", "buyer", "settled", 100);
    const row = db
      .prepare(`SELECT event_type FROM peer_activity_log WHERE peer_pubkey='ed25519:buyer'`)
      .get() as { event_type: string } | undefined;
    expect(row?.event_type).toBe("settlement_buyer_settled");
  });
});
