/**
 * PLAN-54 follow-up: "person" entities that are not names ("here",
 * "commands", a peer id) are filed as concepts, at write time and by
 * migration v75. The curiosity egress filter blocks every known person's
 * name from outgoing search phrases, so this noise blocked ordinary words.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { KnowledgeGraphManager, looksLikePersonName } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

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

describe("person-name hygiene", () => {
  it("tells names from the extractor's vocabulary and ids", () => {
    for (const ok of [
      "sylvia",
      "donna",
      "victor m. gil",
      "lena o'brien",
      "jean-luc picard",
      "李雷",
    ]) {
      expect(looksLikePersonName(ok), ok).toBe(true);
    }
    for (const bad of [
      "here",
      "commands",
      "the bitterbot",
      "knowledge crystals",
      "12d3koowrnqmpkjuc2w2gzgblk59w7znzk4rq1p38ufygpemqbfz",
      "peer 12d3koowrnqmpkjuc2w2gzgblk59w7znzk4rq1p38ufygpemqbfz",
      "human friend",
      "me",
      "a",
    ]) {
      expect(looksLikePersonName(bad), bad).toBe(false);
    }
  });

  it("files a non-name 'person' as a concept at write time", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    expect(kg.upsertEntity({ name: "Here", type: "person", properties: {} }).entityType).toBe(
      "concept",
    );
    expect(kg.upsertEntity({ name: "Sylvia", type: "person", properties: {} }).entityType).toBe(
      "person",
    );
  });

  it("migration v75 reclassifies existing noise and keeps real people", () => {
    const db = openDb();
    const ins = db.prepare(
      `INSERT INTO entities (id, name, entity_type, properties, first_seen_at, last_seen_at, mention_count, importance)
       VALUES (?, ?, 'person', '{}', 0, 0, 1, 0.5)`,
    );
    ins.run("e1", "here");
    ins.run("e2", "sylvia");
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run("74");
    runMigrations(db);
    const types = Object.fromEntries(
      (
        db.prepare(`SELECT id, entity_type FROM entities`).all() as Array<{
          id: string;
          entity_type: string;
        }>
      ).map((r) => [r.id, r.entity_type]),
    );
    expect(types).toEqual({ e1: "concept", e2: "person" });
  });
});
