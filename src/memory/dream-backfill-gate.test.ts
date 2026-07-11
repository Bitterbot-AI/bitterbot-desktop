/**
 * PLAN-34 §6.2 — the run()-level decision that gates the historical
 * backfill: DreamEngine.run() drains the pre-Phase-4 backlog ONLY in cycles
 * that spent no live promotion budget, so the per-cycle LLM envelope never
 * doubles. Drives the REAL run() pipeline (not the private method directly)
 * so the wiring — `let livePromotionRan`, the `livePromotionRan = true` set,
 * and the `if (!livePromotionRan)` guard — is actually exercised.
 *
 * Kept out of the .e2e file on purpose: driving run() triggers first-time
 * dynamic imports that make the e2e-config vite optimizer re-scan; the
 * default config handles them without noise (see dream-replay-transaction).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

let db: DatabaseSync;
beforeEach(() => {
  db = createTestDb();
});

// A generic active chunk with a distinct embedding, so the min-chunks gate
// and simulation's diverse-seed pick are both satisfied. lifecycle must be
// 'generated' (both gates accept generated/activated, not 'active').
function seedActiveChunk(id: string, vec: number[], importance = 0.8): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       origin, semantic_type, session_trust, importance_score, lifecycle, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, 'sessions', 0, 0, ?, ?, 'test', ?, 'indexed', 'fact', 'first_party', ?, 'generated', 'active', ?, ?)`,
  ).run(id, `p/${id}`, `text ${id} distinct`, `h_${id}`, JSON.stringify(vec), importance, now, now);
}

function seedHistorical(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO dream_insights (id, content, embedding, confidence, mode,
       source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score,
       access_count, last_accessed_at, created_at, updated_at)
     VALUES (?, ?, ?, 0.8, 'extrapolation', '["c1","c2"]', '[]', 'old', 0.6, 0, NULL, ?, ?)`,
  ).run(id, `Historical ${id}.`, "[1,0,0,0]", now, now);
}

function backfillSpy(engine: DreamEngine) {
  return vi
    .spyOn(
      engine as unknown as { backfillPromotedInsights: (c: string) => Promise<void> },
      "backfillPromotedInsights",
    )
    .mockResolvedValue(undefined);
}

describe("run() gates the historical backfill on livePromotionRan (PLAN-34 §6.2)", () => {
  it("an idle cycle (no promotable insights) RUNS the historical backfill", async () => {
    for (let i = 0; i < 6; i++) {
      seedActiveChunk(`c${i}`, [1, i * 0.1, 0, 0]);
    }
    seedHistorical("hist_idle");
    // replay is not a promotable mode → livePromotionRan stays false.
    const engine = new DreamEngine(
      db,
      { llmCall: async () => "[]" },
      (async () => ({ content: "", confidence: 0 })) as never,
      async (t: string[]) => t.map(() => [1, 0, 0, 0]),
    );
    engine.setInsightChunkWriter(() => true);
    const spy = backfillSpy(engine);
    await engine.run({ modes: ["replay"] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a cycle that generates promotable insights does NOT run the backfill (LLM envelope never doubles)", async () => {
    for (let i = 0; i < 6; i++) {
      seedActiveChunk(`c${i}`, i % 2 === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0]);
    }
    seedHistorical("hist_live");
    const engine = new DreamEngine(
      db,
      {
        // simulation (a promotable mode) yields one insight.
        llmCall: async () =>
          JSON.stringify([{ content: "A cross-domain hunch.", confidence: 0.8, keywords: ["x"] }]),
      },
      (async () => ({ content: "", confidence: 0 })) as never,
      async (t: string[]) => t.map(() => [1, 0, 0, 0]),
    );
    engine.setInsightChunkWriter(() => true);
    engine.setInsightVerifier(async () => ({ unsupported: 0, misattribution: false }));
    const spy = backfillSpy(engine);
    const stats = await engine.run({ modes: ["simulation"] });
    // The promotable insight was generated (live promotion path taken)…
    expect(stats?.newInsights.some((i) => String(i.mode) === "simulation")).toBe(true);
    // …so the backfill must NOT also run this cycle.
    expect(spy).not.toHaveBeenCalled();
  });
});
