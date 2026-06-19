/**
 * Consolidation does O(n^2) pairwise cosine for near-merge / merge-candidate
 * discovery. Over the full active set (thousands of embedded chunks) that is
 * tens of seconds of synchronous CPU per cycle, which froze the gateway event
 * loop and dropped the Control UI connection. The input is now capped to the
 * most-important chunks; this verifies the cap is applied and selects the top
 * chunks by importance.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ConsolidationEngine } from "./consolidation.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

const CAP = 500;

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

function unitEmbedding(dim = 8): number[] {
  const v = Array.from({ length: dim }, () => Math.random() - 0.5);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

function insertChunk(db: DatabaseSync, id: string, importance: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, importance_score, access_count, last_accessed_at, semantic_type, lifecycle)
     VALUES (?, 'test.md', 'memory', 0, 1, ?, 'test', ?, ?, ?, ?, 5, ?, 'general', 'generated')`,
  ).run(id, "h-" + id, "text " + id, JSON.stringify(unitEmbedding()), now, importance, now);
}

describe("consolidation pairwise-merge cap", () => {
  it("caps near-merge discovery to the top-N most important chunks", () => {
    const db = createDb();
    const N = 600; // > CAP
    for (let i = 0; i < N; i += 1) {
      // importance climbs with i, so the highest-importance chunks are the last.
      insertChunk(db, `c${String(i).padStart(4, "0")}`, 0.5 + (i / N) * 0.49);
    }

    // forgetThreshold 0 → nothing decays away, so all 600 survive into the
    // near-merge phase; the cap (not forgetting) is what bounds the input.
    const engine = new ConsolidationEngine(db, { forgetThreshold: 0, promoteThreshold: 0.4 });
    const spy = vi.spyOn(
      engine as unknown as {
        discoverNearMerges: (chunks: Array<{ id: string }>) => unknown;
      },
      "discoverNearMerges",
    );

    engine.run();

    expect(spy).toHaveBeenCalled();
    const passed = spy.mock.calls[0]![0] as Array<{ id: string }>;
    expect(passed.length).toBe(CAP); // 600 candidates → capped to 500
    const ids = new Set(passed.map((c) => c.id));
    expect(ids.has("c0599")).toBe(true); // highest importance kept
    expect(ids.has("c0000")).toBe(false); // lowest importance dropped
    db.close();
  });
});
