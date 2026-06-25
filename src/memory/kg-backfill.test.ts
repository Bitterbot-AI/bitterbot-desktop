import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillTypedRelationships } from "./kg-backfill.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

let db: DatabaseSync;
let kg: KnowledgeGraphManager;

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return d;
}

function seedFact(id: string, text: string, semanticType = "fact", lifecycle = "activated"): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, lifecycle, semantic_type, created_at, updated_at)
     VALUES (?, 'mem', 'sessions', 0, 0, ?, ?, 'm', '[]', 0.6, ?, ?, ?, ?)`,
  ).run(id, text, `h_${id}`, lifecycle, semanticType, now, now);
}

beforeEach(() => {
  db = freshDb();
  kg = new KnowledgeGraphManager(db);
});
afterEach(() => {
  db.close();
});

describe("backfillTypedRelationships (PLAN-28 A3)", () => {
  it("produces typed edges from seeded fact chunks", () => {
    seedFact("c1", "Victor uses Docker for builds");
    seedFact("c2", "Alice manages Bob");
    const created = backfillTypedRelationships(db, kg, {});
    expect(created).toBe(2);
    expect(kg.getStats().relationshipCount).toBe(2);
  });

  it("skips chunks with no typed relation (conservative)", () => {
    seedFact("c1", "Victor and Bob exist together"); // related_to -> skipped
    seedFact("c2", "The weather is nice today"); // no entities
    const created = backfillTypedRelationships(db, kg, {});
    expect(created).toBe(0);
    expect(kg.getStats().relationshipCount).toBe(0);
  });

  it("is bounded by the limit", () => {
    const names = ["Alice", "Bob", "Carol", "Dave", "Erin"];
    for (let i = 0; i < 5; i++) {
      seedFact(`c${i}`, `${names[i]} manages the ${names[(i + 1) % 5]} project`);
    }
    const created = backfillTypedRelationships(db, kg, { limit: 2 });
    expect(created).toBe(2);
  });

  it("is idempotent: a second pass adds no new edges (upsert)", () => {
    seedFact("c1", "Victor uses Docker daily");
    backfillTypedRelationships(db, kg, {});
    const after1 = kg.getStats().relationshipCount;
    backfillTypedRelationships(db, kg, {});
    const after2 = kg.getStats().relationshipCount;
    expect(after1).toBe(1);
    expect(after2).toBe(1);
  });

  it("ignores expired/forgotten lifecycle chunks", () => {
    seedFact("c1", "Victor uses Docker", "fact", "expired");
    const created = backfillTypedRelationships(db, kg, {});
    expect(created).toBe(0);
  });
});
