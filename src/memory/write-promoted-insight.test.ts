/**
 * PLAN-34 Phase 4 adversarial fix: the REAL writePromotedInsightChunk path
 * (the e2e suite used a hand-written stub). Verifies the chunk is stamped
 * with the live embedding model + a configured MemorySource, and that
 * chunks_vec / chunks_fts rows are written for immediate searchability —
 * and that a failed insert returns false (so the caller never counts a
 * phantom promotion).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function makeDb(fts: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: fts,
  });
  return db;
}

function writer(
  db: DatabaseSync,
  opts: { model?: string; sources?: Set<string>; ftsAvailable?: boolean } = {},
) {
  const fake = {
    db,
    provider: { model: opts.model ?? "openai/text-embedding-3-small" },
    sources: opts.sources ?? new Set(["memory"]),
    fts: { enabled: true, available: opts.ftsAvailable ?? false },
  };
  const proto = MemoryIndexManager.prototype as unknown as {
    writePromotedInsightChunk(this: typeof fake, row: unknown): boolean;
  };
  return (row: {
    text: string;
    embedding: number[];
    importanceScore: number;
    evidenceRefs: string;
  }) => proto.writePromotedInsightChunk.call(fake, row);
}

describe("writePromotedInsightChunk", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb(false);
  });

  it("stamps origin/semantic_type/layer, the live model, and a configured source", () => {
    const ok = writer(db, { model: "prov/model-x", sources: new Set(["memory", "sessions"]) })({
      text: "sparse coding folds context",
      embedding: [1, 0, 0, 0],
      importanceScore: 0.4,
      evidenceRefs: "[]",
    });
    expect(ok).toBe(true);
    const row = db
      .prepare(
        `SELECT origin, semantic_type, epistemic_layer, source, model, importance_score
         FROM chunks WHERE origin = 'dream' AND semantic_type = 'insight'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      origin: "dream",
      semantic_type: "insight",
      epistemic_layer: "mental_model",
      source: "memory", // in the configured MemorySource set
      model: "prov/model-x", // the LIVE embedding model (search filters on it)
      importance_score: 0.4,
    });
  });

  it("falls back to the first configured source when 'memory' is not enabled", () => {
    writer(db, { sources: new Set(["sessions"]) })({
      text: "x",
      embedding: [1, 0, 0, 0],
      importanceScore: 0.4,
      evidenceRefs: "[]",
    });
    const row = db.prepare(`SELECT source FROM chunks WHERE origin = 'dream'`).get() as {
      source: string;
    };
    expect(row.source).toBe("sessions");
  });

  it("writes an FTS row when FTS is available (immediate keyword searchability)", () => {
    const ftsDb = makeDb(true);
    writer(ftsDb, { ftsAvailable: true })({
      text: "unique dreamy token qwzx",
      embedding: [1, 0, 0, 0],
      importanceScore: 0.4,
      evidenceRefs: "[]",
    });
    const hit = ftsDb
      .prepare(`SELECT id FROM chunks_fts WHERE chunks_fts MATCH 'qwzx'`)
      .all() as unknown[];
    expect(hit.length).toBe(1);
  });

  it("returns false when the chunk insert fails (no phantom promotion counted)", () => {
    db.exec(`DROP TABLE chunks`);
    const ok = writer(db)({
      text: "x",
      embedding: [1, 0, 0, 0],
      importanceScore: 0.4,
      evidenceRefs: "[]",
    });
    expect(ok).toBe(false);
  });
});
