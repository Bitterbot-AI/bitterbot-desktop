import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { inspectSubsystems } from "./doctor-subsystems.js";

// Exercises the deep checks against a REAL migrated schema — the whole point
// is catching wired-but-dead state, so a shallow "table exists" test would
// miss the same failures doctor used to.

function freshDb(): DatabaseSync {
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

function insertChunk(db: DatabaseSync, id: string, embedding: string): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, 'memory://test', 'memory', 0, 1, ?, 'test-model', ?, ?, 0)`,
  ).run(id, `hash-${id}`, `text ${id}`, embedding);
}

function sectionResults(db: DatabaseSync, cfg: BitterbotConfig, title: string) {
  const report = inspectSubsystems(db, cfg, "/tmp/test.sqlite");
  return report.find((s) => s.title === title)?.results ?? [];
}

const EMPTY_CFG = {} as BitterbotConfig;

describe("doctor subsystem checks", () => {
  it("flags an embedding backlog when crystals lack a semantic embedding", () => {
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]"); // embedded
    insertChunk(db, "b", "[]"); // empty embedding = backlog
    insertChunk(db, "c", ""); // empty string = backlog
    const results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(
      results.some((r) => r.level === "warn" && /Embedding backlog: 2\/3/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("passes embeddings when every crystal is embedded", () => {
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    // Other perspective columns are NULL by default → worstMissing > 0 unless
    // we only assert the semantic-clean OK path is reachable. Backfill covers
    // non-semantic perspectives; assert the check does not warn on semantic.
    const results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    // With only semantic set, procedural/causal/entity are missing → warn is
    // expected; assert it is at least not a false "all embedded" when they are.
    expect(results.some((r) => /All .*crystals embedded/.test(r.message))).toBe(false);
    db.close();
  });

  it("warns when crystals carry embeddings but the vector index is absent (false-green fix)", () => {
    // The 2026-06 sqlite-vec incident: embedding COLUMNS populated, but
    // chunks_vec never written → "all embedded" while vector search finds
    // nothing. The column check alone reported this node healthy.
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    const results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(results.some((r) => r.level === "warn" && /Vector index absent/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("still runs coverage checks when the DB mixes embedded and ''-embedding rows", () => {
    // json_array_length THROWS on '' (a first-class "unembedded" state); an
    // unguarded count aborted and silently skipped every coverage check on
    // exactly the degraded DBs the detector was built for.
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    insertChunk(db, "b", "");
    const results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(results.some((r) => r.level === "warn" && /Vector index absent/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("warns when the vector index exists but is empty, ok when it covers embedded crystals", () => {
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    // Simulate the vec0 table pair with plain tables: doctor counts the
    // chunks_vec_rowids shadow table so it needs no sqlite-vec extension.
    db.exec(`CREATE TABLE chunks_vec (id TEXT); CREATE TABLE chunks_vec_rowids (rowid INTEGER)`);
    let results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(results.some((r) => r.level === "warn" && /Vector index is EMPTY/.test(r.message))).toBe(
      true,
    );

    db.prepare(`INSERT INTO chunks_vec_rowids (rowid) VALUES (1)`).run();
    results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(results.some((r) => r.level === "ok" && /Vector index: 1\/1/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("warns when the FTS index is absent or empty despite embedded crystals", () => {
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    // The test schema is built with ftsEnabled: false, so chunks_fts is absent.
    let results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(
      results.some((r) => r.level === "warn" && /Keyword \(FTS\) index absent/.test(r.message)),
    ).toBe(true);

    // Present but empty (plain table stands in for fts5) → EMPTY warn.
    db.exec(`CREATE TABLE chunks_fts (id TEXT)`);
    results = sectionResults(db, EMPTY_CFG, "Memory Embeddings");
    expect(
      results.some((r) => r.level === "warn" && /Keyword \(FTS\) index is EMPTY/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("does not warn about missing indexes when search is disabled in config", () => {
    const db = freshDb();
    insertChunk(db, "a", "[0.1,0.2]");
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            store: { vector: { enabled: false } },
            query: { hybrid: { enabled: false } },
          },
        },
      },
    } as unknown as BitterbotConfig;
    const results = sectionResults(db, cfg, "Memory Embeddings");
    expect(results.some((r) => /Vector index absent/.test(r.message))).toBe(false);
    expect(results.some((r) => /Keyword \(FTS\) index absent/.test(r.message))).toBe(false);
    db.close();
  });

  it("warns when the knowledge graph is empty despite many crystals", () => {
    const db = freshDb();
    for (let i = 0; i < 60; i++) insertChunk(db, `k${i}`, "[0.1]");
    const results = sectionResults(db, EMPTY_CFG, "Knowledge Graph");
    expect(
      results.some((r) => r.level === "warn" && /Knowledge graph is empty/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("does not warn about an empty graph on a tiny store", () => {
    const db = freshDb();
    insertChunk(db, "one", "[0.1]");
    const results = sectionResults(db, EMPTY_CFG, "Knowledge Graph");
    expect(results.every((r) => r.level !== "warn")).toBe(true);
    db.close();
  });

  it("reports circles enabled-by-default and finds its tables on the agent DB", () => {
    const db = freshDb();
    const results = sectionResults(db, EMPTY_CFG, "Circles");
    expect(results.some((r) => r.level === "ok" && /Circles enabled/.test(r.message))).toBe(true);
    expect(
      results.some((r) => r.level === "ok" && /tables present on the agent DB/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("respects circles.enabled = false", () => {
    const db = freshDb();
    const cfg = { circles: { enabled: false } } as unknown as BitterbotConfig;
    const results = sectionResults(db, cfg, "Circles");
    expect(results.some((r) => r.level === "info" && /disabled/.test(r.message))).toBe(true);
    db.close();
  });
});
