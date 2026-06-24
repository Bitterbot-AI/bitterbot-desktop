/**
 * Regression test for the 2026-06-24 gateway flake: the dream engine's replay
 * mode applied its per-seed importance boosts as N separate implicit
 * transactions. On a large/contended memory DB each commit stalled on the write
 * lock, turning ~20 single-row UPDATEs into a ~90s synchronous loop block that
 * starved the gateway's WebSocket keepalive and bounced the Control UI.
 *
 * The fix batches all seed writes into ONE explicit transaction. This test
 * asserts the replay opens exactly one transaction (not one per seed) and still
 * boosts importance scores.
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EmbedBatchFn, SynthesizeFn } from "./dream-types.js";
import { DreamEngine } from "./dream-engine.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function fakeEmbedding(seed: number): number[] {
  const norm = Math.sqrt(seed * seed + 1 + 4 + 9);
  return [seed / norm, 1 / norm, 2 / norm, 3 / norm];
}

function insertChunk(db: DatabaseSync, importance: number, valence: number): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
      importance_score, access_count, lifecycle_state, lifecycle, memory_type,
      semantic_type, emotional_valence, curiosity_boost, dream_count, origin,
      governance_json, created_at, version, parent_id, last_dreamed_at, last_accessed_at,
      hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin, provenance_chain
    ) VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
  ).run(
    id,
    "memory/test.md",
    "memory",
    1,
    10,
    crypto.randomUUID(),
    "test-model",
    "replay seed chunk",
    JSON.stringify(fakeEmbedding(1)),
    now,
    importance,
    0,
    "active",
    "generated",
    "plaintext",
    "general",
    valence,
    0,
    0,
    "indexed",
    "{}",
    now,
    1,
    null,
    null,
    null,
    0,
    0,
    0,
    "[]",
  );
  return id;
}

const noopEmbedBatch: EmbedBatchFn = async (texts) => texts.map(() => fakeEmbedding(1));
const noopSynthesize: SynthesizeFn = async () => [];

let db: DatabaseSync;

beforeEach(() => {
  db = createTestDb();
});

describe("dream replay mode — single-transaction seed writes", () => {
  it("opens exactly one transaction regardless of seed count, and boosts importance", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(insertChunk(db, 0.4 + (i % 5) * 0.1, 0.5));
    }
    const before = db.prepare("SELECT id, importance_score FROM chunks").all() as Array<{
      id: string;
      importance_score: number;
    }>;

    const execSpy = vi.spyOn(db, "exec");
    const engine = new DreamEngine(db, undefined, noopSynthesize, noopEmbedBatch);
    const stats = await engine.run({ modes: ["replay"] });
    expect(stats).not.toBeNull();

    const begins = execSpy.mock.calls.filter((c) => /\bBEGIN\b/i.test(String(c[0]))).length;
    const commits = execSpy.mock.calls.filter((c) => /\bCOMMIT\b/i.test(String(c[0]))).length;
    expect(begins).toBe(1); // one transaction for ALL seeds, not one per row
    expect(commits).toBe(1);

    // At least some chunks got their importance boosted by the replay.
    const boosted = before.filter((b) => {
      const after = db.prepare("SELECT importance_score FROM chunks WHERE id = ?").get(b.id) as {
        importance_score: number;
      };
      return after.importance_score > b.importance_score;
    });
    expect(boosted.length).toBeGreaterThan(0);
  });
});
