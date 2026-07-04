import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

function openTestDb(): DatabaseSync {
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

function tables(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("migration v22 — Forage bounty economy tables (PLAN-29)", () => {
  it("creates the four bounty tables", () => {
    const present = tables(openTestDb());
    for (const t of ["bounty_posts", "bounty_claims", "bounty_settlements", "bounty_streams"]) {
      expect(present.has(t)).toBe(true);
    }
  });

  it("bounty_posts carries the funding + oracle contract columns", () => {
    const cols = columns(openTestDb(), "bounty_posts");
    for (const c of [
      "poster_wallet",
      "kind",
      "category",
      "oracle_commitment",
      "oracle_type",
      "reward_usdc",
      "funding_proof",
      "claim_stake_usdc",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("bounty_settlements links claims to the revenue payment queue", () => {
    const cols = columns(openTestDb(), "bounty_settlements");
    expect(cols).toContain("payment_queue_id");
    expect(cols).toContain("oracle_verdict");
    expect(cols).toContain("judge_capped");
  });

  it("enforces one settlement per claim", () => {
    const db = openTestDb();
    const insert = db.prepare(
      `INSERT INTO bounty_settlements
         (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
          amount_usdc, oracle_verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("s1", "b1", "c1", "pk-a", "pk-b", "0xabc", 5, "pass", Date.now());
    expect(() =>
      insert.run("s2", "b1", "c1", "pk-a", "pk-b", "0xabc", 5, "pass", Date.now()),
    ).toThrow(/UNIQUE/);
  });

  it("bounty_streams tracks observation chain and audit counters", () => {
    const cols = columns(openTestDb(), "bounty_streams");
    for (const c of [
      "cadence_seconds",
      "per_check_usdc",
      "observation_head",
      "checks_paid",
      "audits_failed",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("is idempotent and lands schema version >= 22", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(22);
  });
});
