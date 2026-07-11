/**
 * PLAN-34 Phase 2 adversarial fix: the REAL consumeResearchFindings SQL
 * (the mock-splice test proved nothing about the query). Drains unsurfaced
 * findings exactly once, newest first, marking surfaced_at.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function insertFinding(db: DatabaseSync, id: string, finding: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO research_findings (id, target_id, finding, source_url, relevance, created_at)
     VALUES (?, 't', ?, 'https://docs.example.com/x', 0.9, ?)`,
  ).run(id, finding, createdAt);
}

// consumeResearchFindings is an instance method; exercise it against a bare
// object carrying just the db (the method only touches this.db).
function consume(db: DatabaseSync, limit = 3) {
  const proto = MemoryIndexManager.prototype as unknown as {
    consumeResearchFindings(this: { db: DatabaseSync }, limit?: number): unknown;
  };
  return proto.consumeResearchFindings.call({ db }, limit) as Array<{
    finding: string;
    sourceUrl: string | null;
  }>;
}

describe("consumeResearchFindings (real SQL)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
  });

  it("drains unsurfaced findings newest-first and marks them surfaced exactly once", () => {
    insertFinding(db, "f1", "older finding", 1000);
    insertFinding(db, "f2", "newer finding", 2000);

    const first = consume(db, 3);
    expect(first.map((f) => f.finding)).toEqual(["newer finding", "older finding"]);
    expect(first[0].sourceUrl).toBe("https://docs.example.com/x");

    // Second drain returns nothing — surfaced_at was set.
    expect(consume(db, 3)).toHaveLength(0);
    const remaining = db
      .prepare(`SELECT COUNT(*) AS c FROM research_findings WHERE surfaced_at IS NULL`)
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("respects the limit and leaves the rest unsurfaced for the next drain", () => {
    for (let i = 0; i < 5; i++) {
      insertFinding(db, `f${i}`, `finding ${i}`, 1000 + i);
    }
    expect(consume(db, 2)).toHaveLength(2);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM research_findings WHERE surfaced_at IS NULL`)
      .get() as { c: number };
    expect(left.c).toBe(3);
  });
});
