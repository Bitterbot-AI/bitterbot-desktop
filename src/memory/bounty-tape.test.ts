import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getForageStats, getMorningReportLine, getTape } from "./bounty-tape.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 3: The Tape derives lifecycle events straight from the
// ledger tables (no separate event log to drift), and the scoreboard
// reports DPSV-first honest metrics, never raw GMV.

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

function seedLifecycle(db: DatabaseSync) {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, claim_stake_usdc, max_claims,
        is_local, status, expires_at, created_at, updated_at)
     VALUES ('b-1', 'poster-pubkey-aaaa', '0x1', 'oneshot', 'extraction', 's',
             'sha256:x', 'mechanical', 5, 0, 1, 1, 'fulfilled', ?, ?, ?)`,
  ).run(NOW + 86_400_000, NOW - 5000, NOW - 500);
  db.prepare(
    `INSERT INTO bounty_claims
       (id, bounty_id, hunter_pubkey, hunter_wallet, stake_usdc, status,
        claimed_at, delivered_at, updated_at)
     VALUES ('c-1', 'b-1', 'hunter-pubkey-bbbb', '0x2', 0, 'verified', ?, ?, ?)`,
  ).run(NOW - 4000, NOW - 2000, NOW - 500);
  db.prepare(
    `INSERT INTO bounty_settlements
       (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
        amount_usdc, oracle_verdict, status, created_at)
     VALUES ('s-1', 'b-1', 'c-1', 'poster-pubkey-aaaa', 'hunter-pubkey-bbbb', '0x2',
             5, 'pass', 'queued', ?)`,
  ).run(NOW - 1000);
}

describe("getTape", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    seedLifecycle(db);
  });

  it("derives the full lifecycle from the ledger, newest first", () => {
    const events = getTape(db);
    const types = events.map((e) => e.type);
    expect(types).toContain("posted");
    expect(types).toContain("claimed");
    expect(types).toContain("delivered");
    expect(types).toContain("settled");
    expect(types).toContain("fulfilled");
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].ts).toBeGreaterThanOrEqual(events[i].ts);
    }
  });

  it("truncates actor pubkeys and carries amounts on money events", () => {
    const settled = getTape(db).find((e) => e.type === "settled");
    expect(settled?.amountUsdc).toBe(5);
    expect(settled?.actor).toBe("hunter-pubke…");
    expect(settled?.actor?.length).toBeLessThan("hunter-pubkey-bbbb".length);
  });

  it("respects the limit", () => {
    expect(getTape(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("getForageStats", () => {
  it("reports DPSV-first metrics over the ledger", () => {
    const db = openDb();
    seedLifecycle(db);
    const stats = getForageStats(db, NOW);
    expect(stats.dpsvAllTime.totalUsd).toBe(5);
    expect(stats.dpsv7d.totalUsd).toBe(5);
    expect(stats.distinctEarners).toBe(1);
    expect(stats.settlements).toBe(1);
    expect(stats.fillRate).toBe(1);
    expect(stats.medianTimeToFillMs).toBe(1000); // claimed 4000ms ago, posted 5000ms ago
    expect(stats.openBounties).toBe(0);
  });

  it("handles an empty ledger without dividing by zero", () => {
    const stats = getForageStats(openDb(), NOW);
    expect(stats.fillRate).toBeNull();
    expect(stats.medianTimeToFillMs).toBeNull();
    expect(stats.dpsvAllTime.totalUsd).toBe(0);
  });
});

describe("getMorningReportLine", () => {
  it("summarizes 24h activity in one line", () => {
    const db = openDb();
    seedLifecycle(db);
    const line = getMorningReportLine(db, NOW);
    expect(line).toMatch(/^Forage: 1 bounty settlement \(\$5\.00\) in the last 24h\./);
  });

  it("stays silent on a quiet node", () => {
    expect(getMorningReportLine(openDb(), NOW)).toBeNull();
  });

  it("ignores stale settlements outside the window", () => {
    const db = openDb();
    seedLifecycle(db);
    const line = getMorningReportLine(db, NOW + 3 * 86_400_000);
    expect(line).toBeNull();
  });
});
