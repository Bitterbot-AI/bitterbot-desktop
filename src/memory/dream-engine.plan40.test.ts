/**
 * PLAN-40 Phase 0b: hard budget, selection integrity, defaults.
 *
 * - mutation + the three fuel-starved holds are disabled by default
 *   (evaluation E2/E5; adversarial F10: enabled holds burned softmax slots).
 * - exploration ignores already-explored curiosity targets in BOTH the
 *   auto-trigger count and the picker (adversarial F12: both ignored the
 *   explored stamp, so exploration monopolized 243/266 cycles).
 * - the LLM budget is HARD: a multi-call mode entering late in the cycle
 *   spends only the remaining budget (adversarial F9: mode-local counters
 *   compared against the full max allowed ~2x overshoot).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { DEFAULT_MODE_CONFIGS } from "./dream-types.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

const noopSynthesize = async () => "";
const noopEmbedBatch = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

let db: DatabaseSync;

function insertChunk(id: string, text: string, semanticType: string, memoryType?: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, semantic_type, memory_type, created_at, updated_at)
     VALUES (?, 'mem', 'memory', 0, 0, ?, ?, 'm', '[0.1,0.2,0.3]', 0.6, ?, ?, ?, ?)`,
  ).run(id, text, `h-${id}`, semanticType, memoryType ?? null, now, now);
}

function insertTarget(id: string, explored: boolean): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
     VALUES (?, 'knowledge_gap', ?, 0.9, ?, ?, ?)`,
  ).run(id, `gap ${id}`, explored ? '{"explored":1}' : "{}", now, now + 86_400_000);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
});

describe("PLAN-40 defaults", () => {
  it("the three fuel-starved holds are disabled by default", () => {
    expect(DEFAULT_MODE_CONFIGS.interceptor_harvest.enabled).toBe(false);
    expect(DEFAULT_MODE_CONFIGS.harness_evolve.enabled).toBe(false);
    expect(DEFAULT_MODE_CONFIGS.relationship_reconsolidation.enabled).toBe(false);
  });
});

describe("exploration explored-target filtering (adversarial F12)", () => {
  it("a forced exploration run over only-explored targets does no work", async () => {
    for (let i = 0; i < 6; i++) insertChunk(`c${i}`, `context ${i}`, "general");
    insertTarget("t1", true);
    insertTarget("t2", true);
    let llmCalled = false;
    const engine = new DreamEngine(
      db,
      {
        llmCall: async () => {
          llmCalled = true;
          return "[]";
        },
        minChunksForDream: 1,
      },
      noopSynthesize,
      noopEmbedBatch,
    );
    await engine.run({ modes: ["exploration"] });
    expect(llmCalled).toBe(false);
  });

  it("unexplored targets are still picked up", async () => {
    for (let i = 0; i < 6; i++) insertChunk(`c${i}`, `context ${i}`, "general");
    insertTarget("t1", false);
    let llmCalled = false;
    const engine = new DreamEngine(
      db,
      {
        llmCall: async () => {
          llmCalled = true;
          return "[]";
        },
        minChunksForDream: 1,
      },
      noopSynthesize,
      noopEmbedBatch,
    );
    await engine.run({ modes: ["exploration"] });
    expect(llmCalled).toBe(true);
  });
});

describe("hard LLM budget (adversarial F9)", () => {
  it("a multi-call mode entering late spends only the remaining cycle budget", async () => {
    // Seed enough chunks that simulation would want several calls.
    for (let i = 0; i < 8; i++) insertChunk(`s${i}`, `context text ${i}`, "general");
    insertTarget("t1", false);
    let calls = 0;
    const engine = new DreamEngine(
      db,
      {
        llmCall: async () => {
          calls++;
          return "[]";
        },
        minChunksForDream: 1,
        maxLlmCallsPerCycle: 2,
      },
      noopSynthesize,
      noopEmbedBatch,
    );
    // exploration spends from the budget first; simulation must then cap at
    // the REMAINDER, not restart its own count against the full max.
    await engine.run({ modes: ["exploration", "simulation"] });
    expect(calls).toBeLessThanOrEqual(2);
  });
});
