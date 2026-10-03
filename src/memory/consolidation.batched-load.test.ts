/**
 * Consolidation loads the live chunk set in rowid-ordered batches with a yield
 * between them (a cold scan of a few thousand rows is seconds of synchronous
 * I/O on the gateway loop). The set loaded must be the same as one SELECT:
 * every live chunk once, frozen and forgotten ones excluded.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConsolidationEngine } from "./consolidation.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "lifecycle", "TEXT");
  ensureColumn(db, "chunks", "semantic_type", "TEXT");
  return db;
}

function insertChunk(db: DatabaseSync, id: string, lifecycle: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, importance_score, access_count, last_accessed_at, semantic_type, lifecycle)
     VALUES (?, 'test.md', 'memory', 0, 1, ?, 'test', ?, '[1,0,0]', ?, 0.5, 1, ?, 'general', ?)`,
  ).run(id, `hash-${id}`, `text ${id}`, now, now, lifecycle);
}

describe("consolidation live-chunk load", () => {
  it("loads every live chunk once across batch boundaries and skips frozen and expired ones", async () => {
    const db = createDb();
    // 1,203 live rows: many full batches of 50 plus a partial one.
    for (let i = 0; i < 1_203; i++) {
      insertChunk(db, `live-${i}`, i % 2 === 0 ? "generated" : "activated");
    }
    insertChunk(db, "frozen-skill", "frozen");
    insertChunk(db, "expired", "expired");
    insertChunk(db, "archived", "archived");
    const engine = new ConsolidationEngine(db) as unknown as {
      loadLiveChunks(): Promise<Array<{ id: string }>>;
    };
    const loaded = await engine.loadLiveChunks();
    const ids = loaded.map((c) => c.id);
    expect(ids).toHaveLength(1_203);
    expect(new Set(ids).size).toBe(1_203);
    expect(ids).not.toContain("frozen-skill");
    expect(ids).not.toContain("expired");
    expect(ids).not.toContain("archived");
    expect(loaded[0]).not.toHaveProperty("rid");
  });

  it("run() still scores the whole live set", async () => {
    const db = createDb();
    for (let i = 0; i < 1_001; i++) {
      insertChunk(db, `c-${i}`, "generated");
    }
    const stats = await new ConsolidationEngine(db).run();
    expect(stats.totalChunks).toBe(1_001);
    expect(stats.scoredChunks).toBe(1_001);
  });
});
