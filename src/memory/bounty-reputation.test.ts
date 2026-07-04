import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { computeDpsv, computeTrustTier, TIER_CLAIM_CAPS_USD } from "./bounty-reputation.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 1.4: tiers climb only on settled, counterparty-diverse
// history; DPSV excludes self-loops entirely and trims pair concentration.

const NOW = 1_800_000_000_000;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

let seq = 0;
function settle(
  db: DatabaseSync,
  over: Partial<{
    poster: string;
    hunter: string;
    amount: number;
    verdict: string;
    status: string;
    at: number;
  }> = {},
) {
  seq += 1;
  db.prepare(
    `INSERT INTO bounty_settlements
       (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
        amount_usdc, oracle_verdict, status, created_at)
     VALUES (?, ?, ?, ?, ?, '0x2222222222222222222222222222222222222222', ?, ?, ?, ?)`,
  ).run(
    `s-${seq}`,
    `b-${seq}`,
    `c-${seq}`,
    over.poster ?? "poster-1",
    over.hunter ?? "hunter-1",
    over.amount ?? 2,
    over.verdict ?? "pass",
    over.status ?? "paid",
    over.at ?? NOW,
  );
}

describe("computeTrustTier", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    seq = 0;
  });

  it("T0 with no history, T1 after one settlement", () => {
    expect(computeTrustTier(db, "hunter-1")).toBe(0);
    settle(db);
    expect(computeTrustTier(db, "hunter-1")).toBe(1);
  });

  it("T2 needs volume AND poster diversity", () => {
    for (let i = 0; i < 5; i++) settle(db, { amount: 3, poster: "poster-1" });
    // 5 settlements, $15, but a single poster: still T1.
    expect(computeTrustTier(db, "hunter-1")).toBe(1);
    settle(db, { amount: 3, poster: "poster-2" });
    expect(computeTrustTier(db, "hunter-1")).toBe(2);
  });

  it("self-dealt settlements never climb the ladder", () => {
    for (let i = 0; i < 25; i++) {
      settle(db, { poster: "hunter-1", hunter: "hunter-1", amount: 10 });
    }
    expect(computeTrustTier(db, "hunter-1")).toBe(0);
  });

  it("failed verdicts do not count", () => {
    settle(db, { verdict: "fail", status: "rejected" });
    expect(computeTrustTier(db, "hunter-1")).toBe(0);
  });

  it("caps are monotonic in tier", () => {
    expect(TIER_CLAIM_CAPS_USD[0]).toBeLessThan(TIER_CLAIM_CAPS_USD[1]);
    expect(TIER_CLAIM_CAPS_USD[1]).toBeLessThan(TIER_CLAIM_CAPS_USD[2]);
    expect(TIER_CLAIM_CAPS_USD[2]).toBeLessThan(TIER_CLAIM_CAPS_USD[3]);
  });
});

describe("computeDpsv", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    seq = 0;
  });

  it("excludes self-loops and reports them", () => {
    settle(db, { poster: "a", hunter: "b", amount: 10 });
    settle(db, { poster: "a", hunter: "a", amount: 500 });
    const report = computeDpsv(db);
    expect(report.totalUsd).toBe(10);
    expect(report.selfLoopExcludedUsd).toBe(500);
    expect(report.distinctPairs).toBe(1);
  });

  it("trims pair concentration once enough pairs exist", () => {
    // Four pairs; one tries to dominate with 70% of raw volume.
    settle(db, { poster: "a", hunter: "b", amount: 70 });
    settle(db, { poster: "c", hunter: "d", amount: 10 });
    settle(db, { poster: "e", hunter: "f", amount: 10 });
    settle(db, { poster: "g", hunter: "h", amount: 10 });
    const report = computeDpsv(db, { maxPairShare: 0.25 });
    // Raw 100; cap per pair = 25; dominant pair trimmed from 70 to 25.
    expect(report.totalUsd).toBe(55);
    expect(report.concentrationTrimmedUsd).toBe(45);
    expect(report.distinctPairs).toBe(4);
  });

  it("does not trim when there are too few pairs for share to mean anything", () => {
    settle(db, { poster: "a", hunter: "b", amount: 100 });
    const report = computeDpsv(db, { maxPairShare: 0.25 });
    expect(report.totalUsd).toBe(100);
    expect(report.concentrationTrimmedUsd).toBe(0);
  });

  it("respects the time window", () => {
    settle(db, { poster: "a", hunter: "b", amount: 10, at: NOW - 10_000 });
    settle(db, { poster: "a", hunter: "b", amount: 7, at: NOW });
    const report = computeDpsv(db, { sinceMs: NOW - 5_000 });
    expect(report.totalUsd).toBe(7);
  });
});
