/**
 * `ConsolidationEngine.purgeExpired` physically deletes forgotten/expired
 * tombstone chunks past a retention window. It was implemented but never called,
 * so forgotten chunks (and their dead vec/fts rows) accumulated indefinitely —
 * bloating the DB and leaving thousands of blank-embedding rows. It is now wired
 * into the consolidation cycle; this verifies its retention semantics.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConsolidationEngine } from "./consolidation.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

const DAY = 24 * 60 * 60 * 1000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "lifecycle", "TEXT");
  ensureColumn(db, "chunks", "lifecycle_state", "TEXT");
  return db;
}

function insertChunk(
  db: DatabaseSync,
  id: string,
  opts: { lifecycle: string; lifecycleState: string | null; updatedAt: number },
): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, lifecycle, lifecycle_state)
     VALUES (?, 'test.md', 'memory', 0, 1, ?, 'test', ?, '[]', ?, ?, ?)`,
  ).run(id, "h-" + id, "text " + id, opts.updatedAt, opts.lifecycle, opts.lifecycleState);
}

describe("ConsolidationEngine.purgeExpired", () => {
  it("deletes forgotten/expired tombstones older than retention, keeps active + recent", () => {
    const db = createDb();
    const now = Date.now();
    insertChunk(db, "active", { lifecycle: "generated", lifecycleState: "active", updatedAt: now });
    insertChunk(db, "old-forgotten", {
      lifecycle: "expired",
      lifecycleState: "forgotten",
      updatedAt: now - 30 * DAY,
    });
    insertChunk(db, "old-expired-only", {
      lifecycle: "expired",
      lifecycleState: null,
      updatedAt: now - 30 * DAY,
    });
    insertChunk(db, "recent-forgotten", {
      lifecycle: "expired",
      lifecycleState: "forgotten",
      updatedAt: now - 2 * DAY,
    });

    const purged = new ConsolidationEngine(db).purgeExpired(14 * DAY);

    expect(purged).toBe(2); // the two 30-day-old tombstones
    const ids = (db.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids.toSorted()).toEqual(["active", "recent-forgotten"]);
    db.close();
  });

  it("never deletes active chunks regardless of age", () => {
    const db = createDb();
    insertChunk(db, "ancient-active", {
      lifecycle: "generated",
      lifecycleState: "active",
      updatedAt: Date.now() - 365 * DAY,
    });

    const purged = new ConsolidationEngine(db).purgeExpired(0);

    expect(purged).toBe(0);
    expect(db.prepare("SELECT count(*) c FROM chunks").get()).toEqual({ c: 1 });
    db.close();
  });
});
