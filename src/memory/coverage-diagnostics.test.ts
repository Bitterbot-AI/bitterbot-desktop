import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  chunkPresence,
  classifyCoverage,
  extractKeyTerms,
  runCoverageDiagnostic,
} from "./coverage-diagnostics.js";
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

function insertChunk(db: DatabaseSync, id: string, text: string): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
      importance_score, lifecycle, semantic_type, epistemic_layer, access_count, created_at, updated_at)
     VALUES (?, '/s', 'sessions', 0, 0, ?, ?, 'pending', '[]', 0.5, 'generated', 'fact', 'world_fact', 0, 0, 0)`,
  ).run(id, text, id);
}

function auditEvents(db: DatabaseSync): string[] {
  return (
    db.prepare(`SELECT event FROM memory_audit_log ORDER BY timestamp`).all() as Array<{
      event: string;
    }>
  ).map((r) => r.event);
}

describe("extractKeyTerms", () => {
  it("keeps salient content terms, drops stopwords and short tokens", () => {
    expect(extractKeyTerms("What is the Postgres deployment region?")).toEqual([
      "postgres",
      "deployment",
      "region",
    ]);
  });
  it("dedupes and caps", () => {
    expect(extractKeyTerms("alpha alpha beta gamma delta epsilon zeta eta", 3)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("classifyCoverage", () => {
  it("routes present-in-chunks to endogenous", () => {
    expect(classifyCoverage({ chunkPresent: true, presentInRaw: true })).toBe("endogenous");
  });
  it("routes raw-only to exogenous", () => {
    expect(classifyCoverage({ chunkPresent: false, presentInRaw: true })).toBe("exogenous");
  });
  it("routes nowhere to gap", () => {
    expect(classifyCoverage({ chunkPresent: false, presentInRaw: false })).toBe("gap");
  });
});

describe("chunkPresence", () => {
  it("finds a unique chunk containing all terms", () => {
    const db = openTestDb();
    insertChunk(db, "c1", "the postgres database lives in frankfurt");
    const p = chunkPresence(db, ["postgres", "frankfurt"]);
    expect(p).toEqual({ present: true, unique: true, chunkId: "c1" });
  });
  it("reports present-but-not-unique when several chunks match", () => {
    const db = openTestDb();
    insertChunk(db, "c1", "postgres frankfurt one");
    insertChunk(db, "c2", "postgres frankfurt two");
    const p = chunkPresence(db, ["postgres", "frankfurt"]);
    expect(p.present).toBe(true);
    expect(p.unique).toBe(false);
  });
  it("absent when terms are nowhere", () => {
    const db = openTestDb();
    insertChunk(db, "c1", "unrelated content");
    expect(chunkPresence(db, ["postgres", "frankfurt"]).present).toBe(false);
  });
});

describe("runCoverageDiagnostic", () => {
  it("endogenous: indexed but not retrieved → training pair + audit", async () => {
    const db = openTestDb();
    insertChunk(db, "c1", "deploy target is frankfurt region");
    const res = await runCoverageDiagnostic({
      db,
      query: "what is the frankfurt deploy region",
      scanRaw: async () => true,
      now: 1,
    });
    expect(res?.verdict).toBe("endogenous");
    expect(auditEvents(db)).toContain("coverage_endogenous");
    const pairs = db
      .prepare(`SELECT query, ground_truth_chunk_id, source FROM graph_gate_training_pairs`)
      .all() as Array<{ query: string; ground_truth_chunk_id: string; source: string }>;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ ground_truth_chunk_id: "c1", source: "coverage_miss" });
  });

  it("exogenous: in raw but not indexed → construction_feedback", async () => {
    const db = openTestDb();
    const res = await runCoverageDiagnostic({
      db,
      query: "what is the frankfurt deploy region",
      scanRaw: async () => true,
      now: 1,
    });
    expect(res?.verdict).toBe("exogenous");
    expect(auditEvents(db)).toContain("construction_feedback");
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM graph_gate_training_pairs`).get() as { c: number },
    ).toEqual({ c: 0 });
  });

  it("gap: nowhere → coverage_gap", async () => {
    const db = openTestDb();
    const res = await runCoverageDiagnostic({
      db,
      query: "what is the frankfurt deploy region",
      scanRaw: async () => false,
      now: 1,
    });
    expect(res?.verdict).toBe("gap");
    expect(auditEvents(db)).toContain("coverage_gap");
  });

  it("returns null for a query too thin to diagnose", async () => {
    const db = openTestDb();
    const res = await runCoverageDiagnostic({
      db,
      query: "what is it",
      scanRaw: async () => true,
      now: 1,
    });
    expect(res).toBeNull();
    expect(auditEvents(db)).toHaveLength(0);
  });
});
