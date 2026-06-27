/**
 * `multiPerspectiveSearchWithEmbeddings` runs a synchronous cosine/RRF sweep
 * over up to 1000 chunks × 4 perspectives on every recall. It was made async so
 * the sweep can yield to the event loop between slices (keeping the gateway
 * keepalive alive during large recalls). Yielding must be behavior-preserving:
 * this verifies the async pass still ranks by similarity and honors the limit.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { MultiPerspectiveEmbedding } from "./crystal-types.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";
import { multiPerspectiveSearchWithEmbeddings } from "./multi-perspective-search.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  for (const [col, type] of [
    ["embedding_procedural", "TEXT"],
    ["embedding_causal", "TEXT"],
    ["embedding_entity", "TEXT"],
    ["importance_score", "REAL"],
    ["steering_reward", "REAL"],
    ["lifecycle", "TEXT"],
    ["lifecycle_state", "TEXT"],
    ["deprecated", "INTEGER"],
  ] as const) {
    ensureColumn(db, "chunks", col, type);
  }
  return db;
}

function insert(db: DatabaseSync, id: string, semantic: number[]): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, importance_score, steering_reward, lifecycle, deprecated)
     VALUES (?, 'test.md', 'memory', 0, 1, ?, 'test', ?, ?, ?, 0.5, 0, 'generated', 0)`,
  ).run(id, "h-" + id, "text " + id, JSON.stringify(semantic), Date.now());
}

const SEMANTIC_ONLY = { semantic: 1, procedural: 0, causal: 0, entity: 0 };

describe("multiPerspectiveSearchWithEmbeddings (async, yielding)", () => {
  it("ranks the most similar chunk first and honors the limit", async () => {
    const db = createDb();
    insert(db, "match", [1, 0, 0, 0]); // identical to query → highest similarity
    insert(db, "orthogonal", [0, 1, 0, 0]); // sim 0
    insert(db, "opposite", [-1, 0, 0, 0]); // sim -1

    const query: MultiPerspectiveEmbedding = {
      semantic: [1, 0, 0, 0],
      procedural: [],
      causal: [],
      entity: [],
    };

    const results = await multiPerspectiveSearchWithEmbeddings(query, SEMANTIC_ONLY, db, 2);

    expect(results).toHaveLength(2); // limit honored
    expect(results[0]!.id).toBe("match"); // best match ranks first
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    db.close();
  });

  it("returns empty for an empty store without throwing", async () => {
    const db = createDb();
    const query: MultiPerspectiveEmbedding = {
      semantic: [1, 0, 0, 0],
      procedural: [],
      causal: [],
      entity: [],
    };
    await expect(
      multiPerspectiveSearchWithEmbeddings(query, SEMANTIC_ONLY, db, 10),
    ).resolves.toEqual([]);
    db.close();
  });

  it("stays correct across a yield boundary (> SEARCH_YIELD_EVERY chunks)", async () => {
    const db = createDb();
    // 300 chunks forces multiple yield ticks (every 128). The planted exact
    // match must still rank first after resuming across those boundaries.
    for (let i = 0; i < 300; i += 1) {
      // i + 1 so no filler is exactly [1,0,0,0] (cos(int>=1) !== 1) and thus
      // none ties the planted needle.
      const v = [Math.cos(i + 1), Math.sin(i + 1), 0, 0];
      insert(db, `c${String(i).padStart(3, "0")}`, v);
    }
    insert(db, "needle", [1, 0, 0, 0]);
    const query: MultiPerspectiveEmbedding = {
      semantic: [1, 0, 0, 0],
      procedural: [],
      causal: [],
      entity: [],
    };
    const results = await multiPerspectiveSearchWithEmbeddings(query, SEMANTIC_ONLY, db, 5);
    expect(results[0]!.id).toBe("needle");
    db.close();
  });
});
