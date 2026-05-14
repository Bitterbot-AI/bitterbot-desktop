/**
 * Integration test for the PLAN-17 Phase 2 E.1 hook: when
 * `CuriosityEngine.assessDreamInsight` opens a new frontier (novelty >
 * 0.7) it should also spawn a long-horizon Task via the biology
 * adapter so the agent actually investigates the gap.
 *
 * Uses a real CuriosityEngine instance with an in-memory SQLite db so
 * the schema, frontier-target insert, and novelty computation all run
 * for real — this is the test PLAN-17 Phase 2 called out and previously
 * deferred.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveTaskStore, startTaskStore, stopTaskStore } from "../tasks/store.js";
import { CuriosityEngine } from "./curiosity-engine.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

function openDb(filePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath);
  // CuriosityEngine constructs GCCRFRewardFunction, which expects the
  // shared memory schema (chunks/files/meta tables) to already exist.
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function makeInsight(
  overrides: Partial<{ id: string; content: string; confidence: number; embedding: number[] }> = {},
) {
  // The Insight type only requires { id, content, confidence, mode, embedding }
  // for the assessDreamInsight path we care about; the rest of the shape is
  // accessed only in unrelated branches.
  return {
    id: overrides.id ?? `insight-${Math.random().toString(36).slice(2)}`,
    content:
      overrides.content ??
      "Sparse coding may enable lossless context folding in long-horizon agents",
    confidence: overrides.confidence ?? 0.8,
    mode: "simulation" as const,
    embedding: overrides.embedding ?? [0.1, 0.2, 0.3, 0.4],
    timestamp: Date.now(),
  };
}

describe("CuriosityEngine → task spawn integration (PLAN-17 Phase 2 E.1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-curio-spawn-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
    delete process.env.BITTERBOT_CURIOSITY_SPAWN_TASKS;
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.BITTERBOT_CURIOSITY_SPAWN_TASKS;
  });

  it("spawns a curiosity-sourced Task when a high-novelty frontier opens", () => {
    const db = openDb(path.join(dir, "curiosity.sqlite"));
    try {
      const engine = new CuriosityEngine(db);
      // Empty regions table → cosine sim against zero centroids → novelty = 1.0.
      const insight = makeInsight();
      const result = engine.assessDreamInsight(insight);
      expect(result.frontiersOpened).toBeGreaterThan(0);

      const store = getActiveTaskStore()!;
      const curiosityTasks = store.list({ source: "curiosity" });
      expect(curiosityTasks).toHaveLength(1);
      const task = curiosityTasks[0];
      expect(task.goal).toMatch(/\[curiosity\]/);
      expect(task.goal).toMatch(/lossless context folding/);
      expect(task.metadata?.topic).toBe(insight.id);
      expect(task.metadata?.novelty).toBeGreaterThan(0.7);
      expect(task.metadata?.seedCrystalId).toBe(insight.id);
    } finally {
      db.close();
    }
  });

  it("does not spawn a task when BITTERBOT_CURIOSITY_SPAWN_TASKS=0", () => {
    process.env.BITTERBOT_CURIOSITY_SPAWN_TASKS = "0";
    const db = openDb(path.join(dir, "curiosity.sqlite"));
    try {
      const engine = new CuriosityEngine(db);
      engine.assessDreamInsight(makeInsight());
      const store = getActiveTaskStore()!;
      expect(store.list({ source: "curiosity" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("does not spawn a task when confidence is below the assessDreamInsight floor (0.6)", () => {
    const db = openDb(path.join(dir, "curiosity.sqlite"));
    try {
      const engine = new CuriosityEngine(db);
      // confidence 0.4 < 0.6 → assessDreamInsight short-circuits before the
      // novelty branch; no frontier insert, no spawn.
      const result = engine.assessDreamInsight(makeInsight({ confidence: 0.4 }));
      expect(result.frontiersOpened).toBe(0);
      const store = getActiveTaskStore()!;
      expect(store.list({ source: "curiosity" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("dedupes when the same insight id is processed twice in a row", () => {
    const db = openDb(path.join(dir, "curiosity.sqlite"));
    try {
      const engine = new CuriosityEngine(db);
      const insight = makeInsight({ id: "stable-id" });
      engine.assessDreamInsight(insight);
      engine.assessDreamInsight(insight);
      const store = getActiveTaskStore()!;
      // Adapter dedupes by topic (= insight.id) within a 7-day lookback.
      expect(store.list({ source: "curiosity" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not spawn when the task store is unavailable", () => {
    // Stop the singleton so the spawn adapter returns null gracefully.
    stopTaskStore();
    const db = openDb(path.join(dir, "curiosity.sqlite"));
    try {
      const engine = new CuriosityEngine(db);
      // The frontier insert still happens (it's a SQL write into the curiosity DB);
      // only the task spawn is skipped. assessDreamInsight returns frontiersOpened > 0
      // either way — we're asserting the absence of a task, which is the new behavior.
      const result = engine.assessDreamInsight(makeInsight());
      expect(result.frontiersOpened).toBeGreaterThan(0);
      // Re-start the store just to call .list on it (the spawn was already skipped).
      startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
      const store = getActiveTaskStore()!;
      expect(store.list({ source: "curiosity" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
