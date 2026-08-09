/**
 * Tests for ensureMemoryIndexSchema — specifically the self-healing FTS
 * backfill (chunks written outside the embedding sync path must become
 * keyword-searchable on the next schema pass).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function insertChunk(db: DatabaseSync, id: string, text: string): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, 'memory/test.md', 'memory', 1, 2, 'h', 'pending', ?, '[]', ?)`,
  ).run(id, text, Date.now());
}

describe("ensureMemoryIndexSchema FTS backfill", () => {
  it("backfills chunks missing from the FTS table and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    const first = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });
    expect(first.ftsAvailable).toBe(true);
    expect(first.ftsBackfilled).toBe(0);

    // Simulate drift: chunks inserted directly (scratch crystals, migrations)
    insertChunk(db, "c1", "the staging relay hint is cobalt-fern");
    insertChunk(db, "c2", "demo day moved to august twenty-first");
    expect((db.prepare("SELECT count(*) c FROM chunks_fts").get() as { c: number }).c).toBe(0);

    const second = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });
    expect(second.ftsBackfilled).toBe(2);

    // The backfilled rows are actually searchable
    const hits = db
      .prepare("SELECT id FROM chunks_fts WHERE chunks_fts MATCH 'cobalt'")
      .all() as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toEqual(["c1"]);

    // Idempotent: a third pass backfills nothing
    const third = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });
    expect(third.ftsBackfilled).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM chunks_fts").get() as { c: number }).c).toBe(2);
  });

  it("reports zero backfill when FTS is disabled", () => {
    const db = new DatabaseSync(":memory:");
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    expect(result.ftsAvailable).toBe(false);
    expect(result.ftsBackfilled).toBe(0);
  });
});
