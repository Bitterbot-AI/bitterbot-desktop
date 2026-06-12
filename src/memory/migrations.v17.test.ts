import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

describe("migration v17 — HORMA provenance pointers", () => {
  it("adds the evidence_refs column to chunks", () => {
    const db = openTestDb();
    const names = (db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(names).toContain("evidence_refs");
  });

  it("evidence_refs is null-tolerant and round-trips JSON", () => {
    const db = openTestDb();
    const refs = JSON.stringify([{ kind: "session", path: "/s.jsonl", line: 12 }]);
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
        importance_score, lifecycle, semantic_type, epistemic_layer, evidence_refs,
        access_count, created_at, updated_at)
       VALUES (?, ?, 'sessions', 0, 0, ?, ?, 'pending', '[]', 0.7, 'generated', 'fact', 'world_fact', ?, 0, 0, 0)`,
    ).run("c1", "/s.jsonl", "the fact", "h1", refs);
    // A legacy row with no provenance stays NULL.
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
        importance_score, lifecycle, semantic_type, epistemic_layer,
        access_count, created_at, updated_at)
       VALUES (?, ?, 'sessions', 5, 9, ?, ?, 'pending', '[]', 0.5, 'generated', 'episode', 'experience', 0, 0, 0)`,
    ).run("c2", "/s.jsonl", "raw chunk", "h2");

    const r1 = db.prepare(`SELECT evidence_refs FROM chunks WHERE id='c1'`).get() as {
      evidence_refs: string | null;
    };
    const r2 = db.prepare(`SELECT evidence_refs FROM chunks WHERE id='c2'`).get() as {
      evidence_refs: string | null;
    };
    expect(JSON.parse(r1.evidence_refs!)).toEqual([
      { kind: "session", path: "/s.jsonl", line: 12 },
    ]);
    expect(r2.evidence_refs).toBeNull();
  });

  it("is idempotent and lands schema version >= 17", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(17);
  });
});
