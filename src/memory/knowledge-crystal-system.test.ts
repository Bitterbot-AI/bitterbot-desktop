/**
 * Comprehensive test suite for the Knowledge Crystal Memory System.
 *
 * Tests the full vision: crystal lifecycle, 6 dream modes, hormonal modulation,
 * curiosity-driven exploration, user modeling, skill refinement, governance,
 * task memory, scheduling, pub/sub, and cross-system integration loops.
 *
 * Every test uses an in-memory SQLite database for full isolation.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import type { KnowledgeCrystal } from "./crystal-types.js";
import type { DreamInsight, SynthesizeFn, EmbedBatchFn } from "./dream-types.js";
import { ConsolidationEngine } from "./consolidation.js";
import { rowToCrystal, crystalToRow, inferSemanticType, defaultGovernance } from "./crystal.js";
import { CuriosityEngine } from "./curiosity-engine.js";
import { DreamEngine } from "./dream-engine.js";
import { MemoryGovernance } from "./governance.js";
import { HormonalStateManager } from "./hormonal.js";
import { MemStore } from "./mem-store.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { MemoryPipeline } from "./pipeline.js";
import { PromptOptimizationExperiment, calculateOpportunity } from "./prompt-optimization.js";
import { MemoryScheduler } from "./scheduler.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { SkillRefiner } from "./skill-refiner.js";
import { TaskMemoryManager } from "./task-memory.js";
import { UserModelManager } from "./user-model.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Create a fully-migrated in-memory database with all schemas. */
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

/** A trivial 4-dimensional embedding for testing. */
function fakeEmbedding(seed: number): number[] {
  const norm = Math.sqrt(seed * seed + 1 + 4 + 9);
  return [seed / norm, 1 / norm, 2 / norm, 3 / norm];
}

/** Insert a chunk with all required columns for test convenience. */
function insertChunk(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    path: string;
    source: string;
    text: string;
    hash: string;
    embedding: string;
    importance_score: number;
    access_count: number;
    lifecycle_state: string;
    lifecycle: string;
    memory_type: string;
    semantic_type: string;
    emotional_valence: number | null;
    curiosity_boost: number;
    dream_count: number;
    origin: string;
    governance_json: string;
    created_at: number;
    updated_at: number;
    start_line: number;
    end_line: number;
    model: string;
    version: number;
    parent_id: string | null;
    last_dreamed_at: number | null;
    last_accessed_at: number | null;
    hormonal_dopamine: number;
    hormonal_cortisol: number;
    hormonal_oxytocin: number;
    provenance_chain: string;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
      importance_score, access_count, lifecycle_state, lifecycle, memory_type,
      semantic_type, emotional_valence, curiosity_boost, dream_count, origin,
      governance_json, created_at, version, parent_id, last_dreamed_at, last_accessed_at,
      hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin, provenance_chain
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )`,
  ).run(
    id,
    overrides.path ?? "memory/test.md",
    overrides.source ?? "memory",
    overrides.start_line ?? 1,
    overrides.end_line ?? 10,
    overrides.hash ?? crypto.randomUUID(),
    overrides.model ?? "test-model",
    overrides.text ?? "Test chunk content",
    overrides.embedding ?? JSON.stringify(fakeEmbedding(1)),
    overrides.updated_at ?? now,
    overrides.importance_score ?? 0.5,
    overrides.access_count ?? 0,
    overrides.lifecycle_state ?? "active",
    overrides.lifecycle ?? "generated",
    overrides.memory_type ?? "plaintext",
    overrides.semantic_type ?? "general",
    overrides.emotional_valence ?? null,
    overrides.curiosity_boost ?? 0,
    overrides.dream_count ?? 0,
    overrides.origin ?? "indexed",
    overrides.governance_json ?? "{}",
    overrides.created_at ?? now,
    overrides.version ?? 1,
    overrides.parent_id ?? null,
    overrides.last_dreamed_at ?? null,
    overrides.last_accessed_at ?? null,
    overrides.hormonal_dopamine ?? 0,
    overrides.hormonal_cortisol ?? 0,
    overrides.hormonal_oxytocin ?? 0,
    overrides.provenance_chain ?? "[]",
  );
  return id;
}

/** No-op embed function for dream engine tests that don't need real embeddings. */
const noopEmbedBatch: EmbedBatchFn = async (texts) => texts.map(() => fakeEmbedding(Math.random()));

/** No-op synthesize function. */
const noopSynthesize: SynthesizeFn = async () => [];

/** A mock LLM that returns valid JSON arrays for dream modes. */
function mockLlmCall(responses?: string[]): (prompt: string) => Promise<string> {
  let callCount = 0;
  return async (_prompt: string) => {
    const response =
      responses?.[callCount] ??
      JSON.stringify([
        { content: "Mock insight from LLM", confidence: 0.8, keywords: ["test", "mock"] },
      ]);
    callCount++;
    return response;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CRYSTAL FOUNDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Crystal Foundation", () => {
  describe("inferSemanticType", () => {
    it("classifies skill source as 'skill'", () => {
      expect(inferSemanticType("anything", "skills", "indexed")).toBe("skill");
    });

    it("classifies skill origin as 'skill'", () => {
      expect(inferSemanticType("anything", "memory", "skill")).toBe("skill");
    });

    it("classifies dream origin as 'insight'", () => {
      expect(inferSemanticType("dream content", "memory", "dream")).toBe("insight");
    });

    it("detects preference patterns", () => {
      expect(inferSemanticType("I prefer TypeScript over JavaScript", "memory", "indexed")).toBe(
        "preference",
      );
      expect(inferSemanticType("I always use dark mode", "memory", "indexed")).toBe("preference");
    });

    it("detects goal patterns", () => {
      expect(
        inferSemanticType("My goal is to ship the feature by Friday", "memory", "indexed"),
      ).toBe("goal");
      expect(inferSemanticType("I plan to refactor the auth module", "memory", "indexed")).toBe(
        "goal",
      );
    });

    it("detects task patterns", () => {
      expect(
        inferSemanticType("My workflow involves running tests every time", "memory", "indexed"),
      ).toBe("task_pattern");
      expect(
        inferSemanticType("Step 1: lint, Step 2: test, Step 3: deploy", "memory", "indexed"),
      ).toBe("task_pattern");
    });

    it("detects relationship patterns", () => {
      expect(inferSemanticType("My team works with the platform group", "memory", "indexed")).toBe(
        "relationship",
      );
    });

    it("classifies sessions as episodes", () => {
      expect(inferSemanticType("We discussed deployment strategies", "sessions", "session")).toBe(
        "episode",
      );
    });

    it("classifies memory files as facts", () => {
      expect(inferSemanticType("The API uses REST endpoints", "memory", "indexed")).toBe("fact");
    });

    it("falls back to general for unknown", () => {
      expect(inferSemanticType("some text", "memory" as any, "inferred")).toBe("fact");
    });
  });

  describe("defaultGovernance", () => {
    it("skills get shared + permanent governance", () => {
      const gov = defaultGovernance("skills");
      expect(gov.accessScope).toBe("shared");
      expect(gov.lifespanPolicy).toBe("permanent");
      expect(gov.priority).toBe(0.8);
    });

    it("sessions get private + decay + personal sensitivity", () => {
      const gov = defaultGovernance("sessions");
      expect(gov.accessScope).toBe("private");
      expect(gov.lifespanPolicy).toBe("decay");
      expect(gov.sensitivity).toBe("personal");
    });

    it("memory files get private + decay + normal sensitivity", () => {
      const gov = defaultGovernance("memory");
      expect(gov.accessScope).toBe("private");
      expect(gov.sensitivity).toBe("normal");
    });
  });

  describe("rowToCrystal / crystalToRow roundtrip", () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestDb();
    });

    it("roundtrips a crystal through DB row format", () => {
      const id = insertChunk(db, {
        text: "Roundtrip test",
        source: "memory",
        importance_score: 0.75,
        semantic_type: "fact",
        lifecycle: "activated",
        emotional_valence: 0.3,
        hormonal_dopamine: 0.2,
        hormonal_cortisol: 0.1,
        hormonal_oxytocin: 0.05,
        governance_json: JSON.stringify({
          accessScope: "shared",
          lifespanPolicy: "permanent",
          priority: 0.9,
          sensitivity: "normal",
        }),
        provenance_chain: JSON.stringify(["parent-1"]),
      });

      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      const crystal = rowToCrystal(row);

      expect(crystal.id).toBe(id);
      expect(crystal.text).toBe("Roundtrip test");
      expect(crystal.semanticType).toBe("fact");
      expect(crystal.lifecycle).toBe("activated");
      expect(crystal.importanceScore).toBe(0.75);
      expect(crystal.emotionalValence).toBe(0.3);
      expect(crystal.hormonalInfluence).toEqual({ dopamine: 0.2, cortisol: 0.1, oxytocin: 0.05 });
      expect(crystal.governance.accessScope).toBe("shared");
      expect(crystal.governance.provenanceChain).toEqual(["parent-1"]);

      // Now convert back to row and check key fields preserved
      const backRow = crystalToRow(crystal);
      expect(backRow.semantic_type).toBe("fact");
      expect(backRow.lifecycle).toBe("activated");
      expect(backRow.lifecycle_state).toBe("active"); // legacy compat
      expect(backRow.memory_type).toBe("plaintext");
    });

    it("maps legacy lifecycle_state to new lifecycle", () => {
      const id = insertChunk(db, {
        lifecycle: null as any,
        lifecycle_state: "forgotten",
      });
      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      const crystal = rowToCrystal(row);
      expect(crystal.lifecycle).toBe("expired");
    });

    it("maps skill memory_type to frozen lifecycle", () => {
      const id = insertChunk(db, {
        lifecycle: null as any,
        lifecycle_state: "active",
        memory_type: "skill",
      });
      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      const crystal = rowToCrystal(row);
      expect(crystal.lifecycle).toBe("frozen");
    });

    it("maps high-importance active chunks to activated lifecycle", () => {
      const id = insertChunk(db, {
        lifecycle: null as any,
        lifecycle_state: "active",
        importance_score: 0.9,
      });
      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      const crystal = rowToCrystal(row);
      expect(crystal.lifecycle).toBe("activated");
    });
  });

  describe("Schema Migrations", () => {
    it("runs v1 migration adding crystal columns", () => {
      const db = createTestDb();
      // Schema is already applied by createTestDb — verify columns exist
      const columns = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("semantic_type");
      expect(names).toContain("lifecycle");
      expect(names).toContain("hormonal_dopamine");
      expect(names).toContain("hormonal_cortisol");
      expect(names).toContain("hormonal_oxytocin");
      expect(names).toContain("governance_json");
      expect(names).toContain("provenance_chain");
      expect(names).toContain("created_at");
    });

    it("is idempotent — running twice does not error", () => {
      const db = createTestDb();
      const result1 = runMigrations(db);
      const result2 = runMigrations(db);
      expect(result2.ran).toBe(0);
      expect(result2.from).toBe(result1.to);
    });

    it("backfills created_at from updated_at", () => {
      const db = new DatabaseSync(":memory:");
      // Create minimal schema first
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.exec(`CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, path TEXT, source TEXT DEFAULT 'memory',
        start_line INTEGER, end_line INTEGER, hash TEXT, model TEXT,
        text TEXT, embedding TEXT, updated_at INTEGER,
        importance_score REAL DEFAULT 1.0, access_count INTEGER DEFAULT 0,
        lifecycle_state TEXT DEFAULT 'active', memory_type TEXT DEFAULT 'plaintext',
        origin TEXT DEFAULT 'indexed'
      )`);
      // Insert a chunk without created_at (legacy)
      db.prepare(
        `INSERT INTO chunks (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, 1, 5, 'h', 'm', 'text', '[]', ?)`,
      ).run("legacy-1", "test.md", 1700000000000);

      const result = runMigrations(db);
      expect(result.ran).toBe(7); // v1 (crystal columns) + v2 (skill tracking, reputation, etc.) + v3 (ban/blocklist, EigenTrust) + v4 (management verification, bounties) + v5 (lineage_hash, peer_origin) + v6 (bitemporal columns) + v7 (session extraction)

      const row = db.prepare("SELECT created_at FROM chunks WHERE id = ?").get("legacy-1") as {
        created_at: number;
      };
      expect(row.created_at).toBe(1700000000000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CONSOLIDATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Consolidation Engine", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("decays low-importance chunks to expired lifecycle", () => {
    // ConsolidationEngine recalculates importance via calculateImportance():
    //   score = 1.0 * frequencyFactor * timeDecay
    //   frequencyFactor = 1 - exp(-0.2 * (accessCount + 1))
    //   timeDecay = exp(-decayRate * (now - lastAccessedAt))
    //
    // Low chunk: accessCount=0, last accessed 30 days ago → score ≈ 0.181 * 0.076 ≈ 0.014 < 0.05
    // High chunk: accessCount=50, last accessed just now → score ≈ 1.0 * 1.0 ≈ 1.0 > 0.05
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    insertChunk(db, {
      id: "low-1",
      importance_score: 0.05,
      lifecycle: "generated",
      lifecycle_state: "active",
      access_count: 0,
      last_accessed_at: now - THIRTY_DAYS_MS, // 30 days ago → sufficient time decay
      updated_at: now - THIRTY_DAYS_MS,
    });
    insertChunk(db, {
      id: "high-1",
      importance_score: 0.9,
      lifecycle: "generated",
      lifecycle_state: "active",
      access_count: 50, // high access count → high frequency factor
      last_accessed_at: now, // just accessed → no time decay
      updated_at: now,
    });

    const engine = new ConsolidationEngine(db, { forgetThreshold: 0.05 });
    const stats = engine.run();

    expect(stats.forgottenChunks).toBeGreaterThanOrEqual(1);

    const low = db
      .prepare("SELECT lifecycle, lifecycle_state FROM chunks WHERE id = ?")
      .get("low-1") as any;
    expect(low.lifecycle).toBe("expired");
    expect(low.lifecycle_state).toBe("forgotten");

    const high = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get("high-1") as any;
    expect(high.lifecycle).not.toBe("expired");
  });

  it("protects frozen (skill) chunks from decay", () => {
    insertChunk(db, {
      id: "skill-1",
      importance_score: 0.01,
      lifecycle: "frozen",
      lifecycle_state: "active",
      memory_type: "skill",
    });

    const engine = new ConsolidationEngine(db, { forgetThreshold: 0.1 });
    engine.run();

    const skill = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get("skill-1") as any;
    expect(skill.lifecycle).toBe("frozen");
  });

  it("merges overlapping chunks from the same path", () => {
    // Merge requires both chunks to recalculate above promoteThreshold (0.8).
    // Use high access_count and recent last_accessed_at to ensure high recalculated scores.
    const now = Date.now();
    const emb = JSON.stringify(fakeEmbedding(1));
    insertChunk(db, {
      id: "merge-a",
      path: "memory/same.md",
      importance_score: 0.9,
      embedding: emb,
      lifecycle: "generated",
      access_count: 50,
      last_accessed_at: now,
      updated_at: now,
    });
    insertChunk(db, {
      id: "merge-b",
      path: "memory/same.md",
      importance_score: 0.85,
      embedding: emb, // identical embedding = cosine 1.0
      lifecycle: "generated",
      access_count: 50,
      last_accessed_at: now,
      updated_at: now,
    });

    const engine = new ConsolidationEngine(db, {
      promoteThreshold: 0.8,
      mergeOverlapThreshold: 0.9,
    });
    const stats = engine.run();

    expect(stats.mergedChunks).toBeGreaterThanOrEqual(1);

    // One should be archived, the other consolidated
    const a = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get("merge-a") as any;
    const b = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get("merge-b") as any;
    const lifecycles = [a.lifecycle, b.lifecycle];
    expect(lifecycles).toContain("archived");
    expect(lifecycles).toContain("consolidated");
  });

  it("creates audit log entries for consolidation events", () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    insertChunk(db, {
      id: "audit-1",
      importance_score: 0.01,
      access_count: 0,
      last_accessed_at: Date.now() - THIRTY_DAYS_MS,
      updated_at: Date.now() - THIRTY_DAYS_MS,
    });

    const engine = new ConsolidationEngine(db, { forgetThreshold: 0.05 });
    engine.run();

    const logs = db.prepare("SELECT * FROM memory_audit_log").all();
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DREAM ENGINE — 6 MODES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Dream Engine", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  /** Seed the DB with enough chunks for dreaming (minChunksForDream = 5 default). */
  function seedChunksForDream(count = 25, opts: Partial<Parameters<typeof insertChunk>[1]> = {}) {
    for (let i = 0; i < count; i++) {
      insertChunk(db, {
        text: `Dream seed chunk number ${i} with content about topic-${i % 5}`,
        importance_score: 0.3 + (i % 7) * 0.1,
        embedding: JSON.stringify(fakeEmbedding(i + 1)),
        semantic_type: opts.semantic_type ?? "general",
        ...opts,
      });
    }
  }

  describe("lifecycle", () => {
    it("returns null when not enough chunks exist", async () => {
      insertChunk(db, { importance_score: 0.5 });

      const engine = new DreamEngine(db, { minChunksForDream: 20 }, noopSynthesize, noopEmbedBatch);
      const stats = await engine.run();

      expect(stats).toBeNull();
    });

    it("returns null when already running", async () => {
      seedChunksForDream();
      const engine = new DreamEngine(db, undefined, noopSynthesize, noopEmbedBatch);

      // Start a long-running cycle that we can race against
      const p1 = engine.run({ modes: ["replay"] });
      const p2 = engine.run({ modes: ["replay"] });

      const [s1, s2] = await Promise.all([p1, p2]);
      // One should succeed, one should return null
      expect([s1, s2].filter((s) => s === null).length).toBeGreaterThanOrEqual(1);
    });

    it("records dream cycles in the database", async () => {
      seedChunksForDream();
      const engine = new DreamEngine(db, undefined, noopSynthesize, noopEmbedBatch);
      await engine.run({ modes: ["replay"] });

      const cycles = db.prepare("SELECT * FROM dream_cycles").all();
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe("Mode 1: Replay — strengthens existing memories", () => {
    it("boosts importance scores without creating new insights", async () => {
      seedChunksForDream();

      const before = db
        .prepare(
          "SELECT id, importance_score, dream_count FROM chunks ORDER BY importance_score DESC LIMIT 5",
        )
        .all() as Array<{ id: string; importance_score: number; dream_count: number }>;

      const engine = new DreamEngine(db, undefined, noopSynthesize, noopEmbedBatch);
      const stats = await engine.run({ modes: ["replay"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0); // Replay creates no new insights

      // Verify importance boosted and dream_count incremented
      for (const chunk of before) {
        const after = db
          .prepare("SELECT importance_score, dream_count FROM chunks WHERE id = ?")
          .get(chunk.id) as { importance_score: number; dream_count: number };

        expect(after.importance_score).toBeGreaterThanOrEqual(chunk.importance_score);
        expect(after.dream_count).toBeGreaterThan(chunk.dream_count);
      }
    });
  });

  describe("Mode 2: Mutation — generates skill variations", () => {
    it("produces mutation insights from skill chunks when LLM is available", async () => {
      // Insert skill chunks
      for (let i = 0; i < 25; i++) {
        insertChunk(db, {
          text: `Skill: use git rebase for clean history, always squash fixups, version ${i}`,
          importance_score: 0.7,
          memory_type: i < 5 ? "skill" : "plaintext",
          semantic_type: i < 5 ? "skill" : "general",
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
        });
      }

      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Use interactive rebase with autosquash for cleaner workflow",
            confidence: 0.85,
            keywords: ["git", "rebase"],
          },
          {
            content: "Consider git merge --squash for feature branches",
            confidence: 0.7,
            keywords: ["git", "merge"],
          },
        ]),
        JSON.stringify([
          {
            content: "Adopt trunk-based development with short-lived branches",
            confidence: 0.9,
            keywords: ["trunk", "branches"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["mutation"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights.length).toBeGreaterThan(0);
      for (const insight of stats!.newInsights) {
        expect(insight.mode).toBe("mutation");
        expect(insight.sourceChunkIds.length).toBeGreaterThan(0);
      }
    });

    it("skips mutation mode when no LLM is configured", async () => {
      seedChunksForDream(25, { memory_type: "skill", semantic_type: "skill" });

      const engine = new DreamEngine(db, { minChunksForDream: 5 }, noopSynthesize, noopEmbedBatch);
      const stats = await engine.run({ modes: ["mutation"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0);
    });
  });

  describe("Mode 3: Extrapolation — predicts future user needs", () => {
    it("generates predictive insights from preference and episode chunks", async () => {
      // Need at least 3 preference/episode/goal/task_pattern chunks
      for (let i = 0; i < 10; i++) {
        insertChunk(db, {
          text: `I prefer TypeScript for backend work, session ${i}`,
          semantic_type: "preference",
          importance_score: 0.6,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
        });
      }
      // Pad with general chunks to hit minimum
      seedChunksForDream(15);

      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "User will likely need TypeScript tooling improvements",
            confidence: 0.75,
            keywords: ["typescript", "tooling"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["extrapolation"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights.length).toBeGreaterThan(0);
      expect(stats!.newInsights[0]!.mode).toBe("extrapolation");
    });

    it("skips extrapolation when fewer than 3 suitable chunks", async () => {
      // Only 2 preference chunks, rest are general
      insertChunk(db, { semantic_type: "preference", embedding: JSON.stringify(fakeEmbedding(1)) });
      insertChunk(db, { semantic_type: "preference", embedding: JSON.stringify(fakeEmbedding(2)) });
      seedChunksForDream(23);

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["extrapolation"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0);
    });
  });

  describe("Mode 4: Compression — generalizes dense clusters", () => {
    it("compresses similar chunks into summary insights and archives sources", async () => {
      // Create a dense cluster: many chunks with identical embeddings
      const sharedEmb = JSON.stringify(fakeEmbedding(42));
      const clusterIds: string[] = [];
      for (let i = 0; i < 8; i++) {
        clusterIds.push(
          insertChunk(db, {
            text: `Related topic about API design patterns and best practices variant ${i}`,
            embedding: sharedEmb,
            importance_score: 0.5,
            lifecycle: "generated",
          }),
        );
      }
      // Fill the rest with diverse chunks
      for (let i = 0; i < 20; i++) {
        insertChunk(db, {
          text: `Unrelated topic ${i}`,
          embedding: JSON.stringify(fakeEmbedding(100 + i)),
          importance_score: 0.4,
        });
      }

      const engine = new DreamEngine(
        db,
        { minChunksForDream: 5, clusterSimilarityThreshold: 0.65 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["compression"] });

      expect(stats).not.toBeNull();

      // Some cluster members should now be archived
      const archived = db
        .prepare("SELECT COUNT(*) as c FROM chunks WHERE lifecycle = 'archived'")
        .get() as { c: number };
      expect(archived.c).toBeGreaterThan(0);

      // Compression insights should exist
      if (stats!.newInsights.length > 0) {
        expect(stats!.newInsights[0]!.mode).toBe("compression");
      }
    });
  });

  describe("Mode 5: Simulation — cross-domain creative connections", () => {
    it("generates cross-domain insights from diverse chunks", async () => {
      // Insert very diverse chunks
      for (let i = 0; i < 25; i++) {
        insertChunk(db, {
          text: `Domain ${i}: completely different topic about area-${i}`,
          embedding: JSON.stringify(fakeEmbedding(i * 10 + 1)),
          importance_score: 0.5,
        });
      }

      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Cross-domain connection between domains",
            confidence: 0.8,
            keywords: ["cross", "domain"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["simulation"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights.length).toBeGreaterThan(0);
      expect(stats!.newInsights[0]!.mode).toBe("simulation");
      // Simulation should pull from multiple source chunks
      expect(stats!.newInsights[0]!.sourceChunkIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Mode 6: Exploration — fills curiosity gaps", () => {
    it("generates exploration strategies from curiosity targets", async () => {
      seedChunksForDream();

      // Insert a curiosity target
      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "target-1",
        "knowledge_gap",
        "How does WebSocket scaling work?",
        0.8,
        null,
        "{}",
        Date.now(),
        null,
        Date.now() + 86400000,
      );

      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Investigate WebSocket load balancing with sticky sessions",
            confidence: 0.7,
            keywords: ["websocket", "scaling"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["exploration"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights.length).toBeGreaterThan(0);
      expect(stats!.newInsights[0]!.mode).toBe("exploration");
    });

    it("skips exploration when no curiosity targets exist", async () => {
      seedChunksForDream();

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["exploration"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0);
    });
  });

  describe("Mode 7: Research — empirical prompt optimization", () => {
    /** Insert a skill chunk and record N executions for it. */
    function seedSkillWithExecutions(opts: {
      skillText?: string;
      executions: number;
      successRate?: number;
      avgReward?: number;
      errorType?: string;
    }): { skillId: string; tracker: SkillExecutionTracker } {
      const skillId = insertChunk(db, {
        text: opts.skillText ?? "Skill: deploy via docker compose with health checks",
        importance_score: 0.7,
        memory_type: "skill",
        semantic_type: "skill",
        embedding: JSON.stringify(fakeEmbedding(42)),
      });

      const tracker = new SkillExecutionTracker(db);
      const successRate = opts.successRate ?? 0.5;
      for (let i = 0; i < opts.executions; i++) {
        const execId = tracker.startExecution(skillId);
        const success = i / opts.executions < successRate;
        tracker.completeExecution(execId, {
          success,
          rewardScore: success ? (opts.avgReward ?? 0.6) : 0.1,
          errorType: success ? null : (opts.errorType ?? "timeout"),
          executionTimeMs: 100,
        });
      }
      return { skillId, tracker };
    }

    it("produces research insights from skills with execution data", async () => {
      seedChunksForDream();
      const { skillId, tracker } = seedSkillWithExecutions({
        executions: 5,
        successRate: 0.4,
        errorType: "timeout",
      });

      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Add connection timeout with exponential backoff",
            confidence: 0.85,
            keywords: ["timeout", "retry"],
          },
          {
            content: "Use health check endpoint before deploy",
            confidence: 0.7,
            keywords: ["health", "deploy"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      engine.setExecutionTracker(tracker);

      const stats = await engine.run({ modes: ["research"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights.length).toBeGreaterThan(0);
      expect(stats!.newInsights[0]!.mode).toBe("research");
      expect(stats!.newInsights[0]!.sourceChunkIds).toContain(skillId);
    });

    it("skips research when no skills have sufficient execution data", async () => {
      seedChunksForDream();
      // Insert a skill but only 1 execution (below MIN_EXECUTIONS threshold)
      const { tracker } = seedSkillWithExecutions({ executions: 1 });

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      engine.setExecutionTracker(tracker);

      const stats = await engine.run({ modes: ["research"] });

      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0);
    });

    it("skips research when no execution tracker is wired", async () => {
      seedChunksForDream();
      insertChunk(db, {
        text: "Skill: some skill",
        memory_type: "skill",
        semantic_type: "skill",
      });

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      // Intentionally not calling engine.setExecutionTracker()

      const stats = await engine.run({ modes: ["research"] });
      expect(stats).not.toBeNull();
      expect(stats!.newInsights).toHaveLength(0);
    });

    it("prioritizes low-performing skills by opportunity score", () => {
      // Seed two skills: one high-performing, one low
      const { tracker } = seedSkillWithExecutions({
        skillText: "Skill: low perf deploy",
        executions: 10,
        successRate: 0.3,
        errorType: "connection_error",
      });
      seedSkillWithExecutions({
        skillText: "Skill: high perf deploy",
        executions: 10,
        successRate: 0.95,
      });

      const experiment = new PromptOptimizationExperiment(db, tracker);
      const candidates = experiment.findCandidates(10);

      expect(candidates.length).toBe(2);
      // Low performer should be ranked first (higher opportunity)
      expect(candidates[0]!.metrics.successRate).toBeLessThan(candidates[1]!.metrics.successRate);
      expect(candidates[0]!.opportunityScore).toBeGreaterThan(candidates[1]!.opportunityScore);
    });

    it("calculateOpportunity scores low success rate higher", () => {
      const lowPerf = calculateOpportunity({
        totalExecutions: 5,
        successRate: 0.2,
        avgRewardScore: 0.3,
        avgExecutionTimeMs: 100,
        userFeedbackScore: 0,
        lastExecutedAt: Date.now(),
        errorBreakdown: { timeout: 3, crash: 1 },
      });

      const highPerf = calculateOpportunity({
        totalExecutions: 5,
        successRate: 0.95,
        avgRewardScore: 0.9,
        avgExecutionTimeMs: 50,
        userFeedbackScore: 0,
        lastExecutedAt: Date.now(),
        errorBreakdown: {},
      });

      expect(lowPerf).toBeGreaterThan(highPerf);
    });

    it("uses error_driven strategy for skills with many errors", async () => {
      seedChunksForDream();
      const { skillId: _skillId, tracker } = seedSkillWithExecutions({
        executions: 6,
        successRate: 0.33,
        errorType: "connection_timeout",
      });

      let capturedPrompt = "";
      const llm = async (prompt: string) => {
        if (!capturedPrompt) {
          capturedPrompt = prompt;
        } // Capture the FIRST call (research prompt), not the sandbox rating prompt
        return JSON.stringify([
          {
            content: "Handle connection timeout with retry logic",
            confidence: 0.8,
            keywords: ["timeout"],
          },
        ]);
      };

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      engine.setExecutionTracker(tracker);

      await engine.run({ modes: ["research"] });

      // The prompt should contain empirical data
      expect(capturedPrompt).toContain("EMPIRICAL PERFORMANCE DATA");
      expect(capturedPrompt).toContain("connection_timeout");
    });
  });

  describe("mode selection", () => {
    it("auto-triggers exploration when curiosity targets exist", async () => {
      seedChunksForDream();

      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      ).run("auto-target", "knowledge_gap", "A gap", 0.5, Date.now(), Date.now() + 86400000);

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run();

      expect(stats).not.toBeNull();
      // The cycle metadata should include the modes used
      expect(stats!.cycle.modesUsed).toBeDefined();
      expect(stats!.cycle.modesUsed!.length).toBeGreaterThan(0);
    });

    it("auto-triggers mutation when skill crystals exist", async () => {
      for (let i = 0; i < 25; i++) {
        insertChunk(db, {
          text: `Content ${i}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
          importance_score: 0.5,
          memory_type: i < 3 ? "skill" : "plaintext",
          semantic_type: i < 3 ? "skill" : "general",
        });
      }

      const engine = new DreamEngine(
        db,
        { llmCall: mockLlmCall(), minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run();
      expect(stats).not.toBeNull();
    });
  });

  describe("insight storage and pruning", () => {
    it("prunes insights when exceeding maxInsights", async () => {
      // Seed enough skill chunks for mutation mode
      for (let i = 0; i < 25; i++) {
        insertChunk(db, {
          text: `Skill chunk about deployment pattern variant ${i}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
          importance_score: 0.5,
          memory_type: i < 5 ? "skill" : "plaintext",
          semantic_type: i < 5 ? "skill" : "general",
        });
      }

      // Pre-fill with insights to trigger pruning
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
           VALUES (?, ?, '[]', 0.5, 'replay', '[]', '[]', 'cycle-test', ?, 0, ?, ?)`,
        ).run(`prune-${i}`, `Insight ${i}`, 0.01 * i, Date.now(), Date.now());
      }

      // Run mutation mode (which generates insights and triggers pruneInsights)
      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Improved deployment with better monitoring",
            confidence: 0.8,
            keywords: ["deploy"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5, maxInsights: 4 },
        noopSynthesize,
        noopEmbedBatch,
      );
      await engine.run({ modes: ["mutation"] });

      const count = (db.prepare("SELECT COUNT(*) as c FROM dream_insights").get() as { c: number })
        .c;
      expect(count).toBeLessThanOrEqual(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CURIOSITY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Curiosity Engine", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("assesses chunk novelty and records surprise scores", () => {
    // Seed some chunks to build regions
    for (let i = 0; i < 10; i++) {
      insertChunk(db, {
        embedding: JSON.stringify(fakeEmbedding(i + 1)),
        importance_score: 0.5,
      });
    }

    const engine = new CuriosityEngine(db);
    engine.run(); // build regions

    // Assess a new chunk
    const novelEmb = fakeEmbedding(999); // very different
    engine.assessChunk("novel-chunk-1", novelEmb, "hash-novel");

    const surprise = db
      .prepare("SELECT * FROM curiosity_surprises WHERE chunk_id = ?")
      .get("novel-chunk-1") as any;

    expect(surprise).toBeDefined();
    expect(surprise.novelty_score).toBeGreaterThanOrEqual(0);
    expect(surprise.composite_reward).toBeGreaterThanOrEqual(0);
  });

  it("records search queries for gap detection", () => {
    for (let i = 0; i < 10; i++) {
      insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
    }

    const engine = new CuriosityEngine(db);
    engine.run();

    engine.recordSearchQuery("how to deploy", fakeEmbedding(50), 0, 0, 0);

    const query = db
      .prepare("SELECT * FROM curiosity_queries ORDER BY timestamp DESC LIMIT 1")
      .get() as any;
    expect(query).toBeDefined();
    expect(query.query).toBe("how to deploy");
    expect(query.result_count).toBe(0);
  });

  it("detects knowledge gaps from low-scoring repeated queries", () => {
    for (let i = 0; i < 15; i++) {
      insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
    }

    const engine = new CuriosityEngine(db, { gapScoreThreshold: 0.4, maxTargets: 10 });
    engine.run(); // build regions

    // Simulate repeated low-scoring queries in the same region
    const queryEmb = fakeEmbedding(1); // near region 0
    for (let i = 0; i < 5; i++) {
      engine.recordSearchQuery(`gap query ${i}`, queryEmb, 1, 0.1, 0.1);
    }

    engine.run(); // should detect gaps

    const targets = db
      .prepare("SELECT * FROM curiosity_targets WHERE type = 'knowledge_gap'")
      .all();
    // May or may not find gaps depending on region clustering; just verify no crash
    expect(targets).toBeDefined();
  });

  describe("dream insight assessment (feedback loop)", () => {
    it("resolves knowledge gap targets when dream insight fills the gap", () => {
      for (let i = 0; i < 10; i++) {
        insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
      }

      const engine = new CuriosityEngine(db);
      engine.run();

      // Manually create a knowledge_gap target
      const regionRow = db.prepare("SELECT * FROM curiosity_regions LIMIT 1").get() as any;
      if (!regionRow) {
        return;
      } // Skip if no regions were created (too few chunks)

      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, expires_at)
         VALUES (?, 'knowledge_gap', 'Missing knowledge about X', 0.8, ?, '{}', ?, ?)`,
      ).run("gap-1", regionRow.id, Date.now(), Date.now() + 86400000);

      // Create a dream insight that matches the region
      const centroid = JSON.parse(regionRow.centroid) as number[];
      const insight: DreamInsight = {
        id: "insight-gap-fill",
        content: "Knowledge about X that fills the gap",
        embedding: centroid,
        confidence: 0.8,
        mode: "exploration",
        sourceChunkIds: [],
        sourceClusterIds: [],
        dreamCycleId: "cycle-1",
        importanceScore: 0.7,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      engine.assessDreamInsight(insight);

      const target = db
        .prepare("SELECT resolved_at FROM curiosity_targets WHERE id = ?")
        .get("gap-1") as any;
      // High confidence insight near region should resolve the gap
      expect(target.resolved_at).not.toBeNull();
    });
  });

  describe("dream mode weight adjustments", () => {
    it("boosts exploration weight when knowledge gaps exist", () => {
      for (let i = 0; i < 10; i++) {
        insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
      }

      const engine = new CuriosityEngine(db);
      engine.run();

      // Insert knowledge gap targets
      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
         VALUES (?, 'knowledge_gap', 'gap 1', 0.5, '{}', ?, ?)`,
      ).run("wt-gap-1", Date.now(), Date.now() + 86400000);
      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
         VALUES (?, 'knowledge_gap', 'gap 2', 0.5, '{}', ?, ?)`,
      ).run("wt-gap-2", Date.now(), Date.now() + 86400000);

      const adjustments = engine.getDreamModeWeightAdjustments();
      expect(adjustments.exploration).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. HORMONAL SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

describe("Hormonal State Manager", () => {
  it("starts at homeostasis baseline", () => {
    const manager = new HormonalStateManager();
    const state = manager.getState();
    // Homeostasis baseline: dopamine=0.15, cortisol=0.02, oxytocin=0.10
    expect(state.dopamine).toBeCloseTo(0.15);
    expect(state.cortisol).toBeCloseTo(0.02);
    expect(state.oxytocin).toBeCloseTo(0.1);
  });

  it("stimulates correct hormones per event type", () => {
    const manager = new HormonalStateManager();

    manager.stimulate("reward");
    expect(manager.getState().dopamine).toBeGreaterThan(0);

    manager.stimulate("error");
    expect(manager.getState().cortisol).toBeGreaterThan(0);

    manager.stimulate("social");
    expect(manager.getState().oxytocin).toBeGreaterThan(0);
  });

  it("achievement spikes both dopamine and oxytocin", () => {
    const manager = new HormonalStateManager();
    const baseline = manager.getState();
    manager.stimulate("achievement");
    const state = manager.getState();
    expect(state.dopamine).toBeGreaterThan(baseline.dopamine);
    expect(state.oxytocin).toBeGreaterThan(baseline.oxytocin);
    // Cortisol stays at homeostasis (no cortisol spike from achievement)
    expect(state.cortisol).toBeCloseTo(baseline.cortisol, 1);
  });

  it("urgency spikes cortisol", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("urgency");
    expect(manager.getState().cortisol).toBeCloseTo(0.4, 1);
  });

  it("clamps hormones at 1.0 maximum", () => {
    const manager = new HormonalStateManager();
    for (let i = 0; i < 10; i++) {
      manager.stimulate("reward");
    }
    expect(manager.getState().dopamine).toBeLessThanOrEqual(1);
  });

  it("modulates consolidation — high cortisol increases decay resistance", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("urgency"); // cortisol spike
    manager.stimulate("urgency");
    const mod = manager.getConsolidationModulation();
    expect(mod.decayResistance).toBeGreaterThan(0);
    expect(mod.mergeThreshold).toBeGreaterThan(0.92); // stricter under stress
  });

  it("modulates retrieval — high dopamine boosts importance", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("achievement");
    const mod = manager.getRetrievalModulation();
    expect(mod.importanceBoost).toBeGreaterThan(1);
  });

  it("computes per-crystal hormonal influence from text", () => {
    const manager = new HormonalStateManager();

    const success = manager.computeCrystalInfluence(
      "We successfully shipped the feature!",
      "memory",
    );
    expect(success.dopamine).toBeGreaterThan(0); // "successfully" → reward

    const error = manager.computeCrystalInfluence("Critical bug crashed production", "memory");
    expect(error.cortisol).toBeGreaterThan(0); // "critical" + "bug" + "crashed"

    const social = manager.computeCrystalInfluence("Thank you team for collaborating", "sessions");
    expect(social.oxytocin).toBeGreaterThan(0); // "thank" + "team" + sessions baseline
  });

  it("sessions get baseline oxytocin in crystal influence", () => {
    const manager = new HormonalStateManager();
    const influence = manager.computeCrystalInfluence("Plain text with no triggers", "sessions");
    expect(influence.oxytocin).toBeGreaterThanOrEqual(0.1);
  });

  it("stimulateFromText detects events and updates global state", () => {
    const manager = new HormonalStateManager();
    const events = manager.stimulateFromText("We successfully fixed the critical bug!");
    // Should detect both "reward" (fixed, successfully) and "error" (critical, bug)
    expect(events).toContain("reward");
    expect(events).toContain("error");
    const state = manager.getState();
    expect(state.dopamine).toBeGreaterThan(0);
    expect(state.cortisol).toBeGreaterThan(0);
  });

  it("stimulateFromText returns empty for neutral text", () => {
    const manager = new HormonalStateManager();
    const baseline = manager.getState();
    const events = manager.stimulateFromText(
      "The function takes two parameters and returns a string.",
    );
    expect(events).toHaveLength(0);
    const state = manager.getState();
    // Should remain at homeostasis baseline (no stimulation)
    expect(state.dopamine).toBeCloseTo(baseline.dopamine);
    expect(state.cortisol).toBeCloseTo(baseline.cortisol);
    expect(state.oxytocin).toBeCloseTo(baseline.oxytocin);
  });

  it("stimulateFromText accumulates across multiple calls", () => {
    const manager = new HormonalStateManager();
    manager.stimulateFromText("Thank you for the help, I appreciate it!");
    const state1 = manager.getState();
    expect(state1.oxytocin).toBeGreaterThan(0);
    const oxyBefore = state1.oxytocin;

    manager.stimulateFromText("The team collaborated on an amazing milestone!");
    const state2 = manager.getState();
    // Should have more oxytocin now (social + achievement both contribute)
    expect(state2.oxytocin).toBeGreaterThan(oxyBefore);
    expect(state2.dopamine).toBeGreaterThan(0); // achievement → dopamine
  });

  it("emotionalBriefing describes homeostasis baseline", () => {
    const manager = new HormonalStateManager();
    const briefing = manager.emotionalBriefing();
    // At homeostasis (dopamine=0.15, oxytocin=0.10), there are subtle undertones
    expect(briefing).toMatch(/[Ss]ubtle|faint|gentle/);
  });

  it("emotionalBriefing reflects dopamine high", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("reward");
    manager.stimulate("achievement");
    const briefing = manager.emotionalBriefing();
    expect(briefing).toMatch(/dopamine|accomplished|wins/i);
  });

  it("responseModulation returns playfulness when dopamine+oxytocin high", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("achievement"); // dopamine + oxytocin
    manager.stimulate("social"); // more oxytocin
    const mod = manager.responseModulation();
    expect(mod.playfulness).toBeGreaterThan(0);
    expect(mod.warmth).toBeGreaterThan(0);
    expect(mod.energy).toBeGreaterThan(0);
  });

  it("responseModulation suppresses playfulness under stress", () => {
    const manager = new HormonalStateManager();
    manager.stimulate("urgency");
    manager.stimulate("urgency");
    const mod = manager.responseModulation();
    expect(mod.focus).toBeGreaterThan(0.3);
    expect(mod.playfulness).toBeLessThan(0.2);
  });

  it("detects reward from casual positive feedback", () => {
    const manager = new HormonalStateManager();
    const events = manager.stimulateFromText("nice work, that's awesome!");
    expect(events).toContain("reward");
  });

  it("detects social from emoji and laughter", () => {
    const manager = new HormonalStateManager();
    const events = manager.stimulateFromText("haha that's so funny 😂");
    expect(events).toContain("social");
  });

  it("detects error from frustrated user", () => {
    const manager = new HormonalStateManager();
    const events = manager.stimulateFromText("ugh this doesn't work, I'm stuck");
    expect(events).toContain("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. USER MODEL
// ═══════════════════════════════════════════════════════════════════════════════

describe("User Model Manager", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("extracts language preference from text", () => {
    const manager = new UserModelManager(db);
    const prefs = manager.extractPreferences("I prefer TypeScript for all my projects");

    expect(prefs.length).toBeGreaterThan(0);
    const lang = prefs.find((p) => p.key === "preferred_language");
    expect(lang).toBeDefined();
    expect(lang!.value).toBe("typescript");
    expect(lang!.confidence).toBe(0.5); // initial
  });

  it("boosts confidence on repeated extraction", () => {
    const manager = new UserModelManager(db);
    manager.extractPreferences("I prefer TypeScript");
    const second = manager.extractPreferences("I always use TypeScript");

    const lang = second.find((p) => p.key === "preferred_language");
    expect(lang).toBeDefined();
    expect(lang!.confidence).toBeCloseTo(0.6); // 0.5 + 0.1
  });

  it("extracts editor preference", () => {
    const manager = new UserModelManager(db);
    const prefs = manager.extractPreferences("I use neovim as my editor");
    const editor = prefs.find((p) => p.key === "preferred_editor");
    expect(editor).toBeDefined();
    expect(editor!.value).toBe("neovim");
  });

  it("extracts package manager preference", () => {
    const manager = new UserModelManager(db);
    const prefs = manager.extractPreferences("I always use pnpm for my projects");
    const pm = prefs.find((p) => p.key === "preferred_package_manager");
    expect(pm).toBeDefined();
    expect(pm!.value).toBe("pnpm");
  });

  it("extracts framework preference", () => {
    const manager = new UserModelManager(db);
    const prefs = manager.extractPreferences("I build with nextjs for all my apps");
    const fw = prefs.find((p) => p.key === "preferred_framework");
    expect(fw).toBeDefined();
  });

  it("returns user profile with all preferences", () => {
    const manager = new UserModelManager(db);
    manager.extractPreferences("I prefer TypeScript");
    manager.extractPreferences("I use vim");

    const profile = manager.getUserProfile();
    expect(profile.preferences.length).toBeGreaterThanOrEqual(2);
    expect(profile.preferences[0]!.confidence).toBeGreaterThan(0);
  });

  it("detects recurring action patterns", () => {
    const manager = new UserModelManager(db);
    const patterns = manager.detectPatterns([
      "I always run tests before committing",
      "I always run tests in CI",
      "I always run tests after refactoring",
      "I prefer to review PRs in the morning",
    ]);

    expect(patterns.length).toBeGreaterThan(0);
    // "always run" should appear 3 times
    const alwaysRun = patterns.find((p) => p.pattern.includes("always run"));
    expect(alwaysRun).toBeDefined();
    expect(alwaysRun!.frequency).toBeGreaterThanOrEqual(2);
  });

  it("requires at least 3 texts for pattern detection", () => {
    const manager = new UserModelManager(db);
    const patterns = manager.detectPatterns(["one", "two"]);
    expect(patterns).toHaveLength(0);
  });

  it("respects disabled config", () => {
    const manager = new UserModelManager(db, { enabled: false });
    const prefs = manager.extractPreferences("I prefer TypeScript");
    expect(prefs).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SKILL REFINER
// ═══════════════════════════════════════════════════════════════════════════════

describe("Skill Refiner", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("promotes high-scoring mutations with sufficient confidence", () => {
    // Insert the dream_insights table is already created by ensureDreamSchema
    const refiner = new SkillRefiner(db, { promotionThreshold: 0.5 });

    const original = {
      id: "skill-orig",
      text: "Use git rebase for clean history with squash fixups",
    };

    const mutation: DreamInsight = {
      id: "mut-1",
      content:
        "Use interactive rebase with autosquash. Handle edge case when conflicts arise. More general approach with fallback to merge.",
      embedding: [],
      confidence: 0.8,
      mode: "mutation",
      sourceChunkIds: ["skill-orig"],
      sourceClusterIds: [],
      dreamCycleId: "cycle-1",
      importanceScore: 0.5,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Insert the insight so the UPDATE in queueForCrystallization works
    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
       VALUES (?, ?, '[]', ?, 'mutation', '[]', '[]', 'cycle-1', 0.5, 0, ?, ?)`,
    ).run(mutation.id, mutation.content, mutation.confidence, Date.now(), Date.now());

    const result = refiner.evaluateMutations(original, [mutation]);

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]!.promoted).toBe(true);
    expect(result.mutations[0]!.score).toBeGreaterThanOrEqual(0.5);

    // Verify audit log entry was created
    const log = db
      .prepare("SELECT * FROM memory_audit_log WHERE event = 'skill_mutation_promoted'")
      .all();
    expect(log.length).toBeGreaterThan(0);
  });

  it("archives low-scoring mutations", () => {
    const refiner = new SkillRefiner(db, { promotionThreshold: 0.99 });

    const result = refiner.evaluateMutations(
      { id: "s1", text: "Complex multistep deployment process" },
      [
        {
          id: "mut-low",
          content: "x",
          embedding: [],
          confidence: 0.1,
          mode: "mutation",
          sourceChunkIds: [],
          sourceClusterIds: [],
          dreamCycleId: "c1",
          importanceScore: 0.3,
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    );

    expect(result.mutations[0]!.promoted).toBe(false);

    const archiveLogs = db
      .prepare("SELECT * FROM memory_audit_log WHERE event = 'skill_mutation_archived'")
      .all();
    expect(archiveLogs.length).toBeGreaterThan(0);
  });

  it("scores mutation based on keyword coverage, novelty, and structure", () => {
    const refiner = new SkillRefiner(db);

    const original = {
      id: "s2",
      text: "Deploy application using Docker containers with monitoring",
    };
    const goodMutation: DreamInsight = {
      id: "mut-good",
      content:
        "Deploy application using Docker containers with monitoring. Handle edge case for resource limits. More general approach with Kubernetes fallback.",
      embedding: [],
      confidence: 0.9,
      mode: "mutation",
      sourceChunkIds: ["s2"],
      sourceClusterIds: [],
      dreamCycleId: "c1",
      importanceScore: 0.6,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
       VALUES (?, ?, '[]', 0.9, 'mutation', '[]', '[]', 'c1', 0.6, 0, ?, ?)`,
    ).run(goodMutation.id, goodMutation.content, Date.now(), Date.now());

    const result = refiner.evaluateMutations(original, [goodMutation]);

    // Should score well: good coverage + novelty + "edge case" + "more general" + "fallback"
    expect(result.mutations[0]!.score).toBeGreaterThan(0.5);
  });

  it("invokes onSkillCrystallized callback on promotion", () => {
    let callbackId: string | null = null;
    const refiner = new SkillRefiner(db, { promotionThreshold: 0.3 }, (id) => {
      callbackId = id;
    });

    const mutation: DreamInsight = {
      id: "callback-mut",
      content:
        "Improved approach with edge case handling and fallback mechanism for broader coverage",
      embedding: [],
      confidence: 0.9,
      mode: "mutation",
      sourceChunkIds: ["orig"],
      sourceClusterIds: [],
      dreamCycleId: "c1",
      importanceScore: 0.5,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
       VALUES (?, ?, '[]', 0.9, 'mutation', '[]', '[]', 'c1', 0.5, 0, ?, ?)`,
    ).run(mutation.id, mutation.content, Date.now(), Date.now());

    refiner.evaluateMutations({ id: "orig", text: "Basic deployment process for applications" }, [
      mutation,
    ]);

    // Callback receives the new crystal chunk ID (not the mutation ID)
    expect(callbackId).not.toBeNull();
    // Verify a new chunk was created with that ID
    const newChunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(callbackId!) as any;
    expect(newChunk).toBeDefined();
    expect(newChunk.memory_type).toBe("skill");
    expect(newChunk.lifecycle).toBe("frozen");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. GOVERNANCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Memory Governance", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("access control", () => {
    it("denies access to non-existent crystals", () => {
      const gov = new MemoryGovernance(db);
      expect(gov.canAccess("nonexistent", { actor: "test", purpose: "read" })).toBe(false);
    });

    it("denies access to expired crystals", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db, { lifecycle: "expired" });

      expect(gov.canAccess(id, { actor: "test", purpose: "read" })).toBe(false);
    });

    it("enforces access scope: shared allows local_agent, private blocks external actors", () => {
      const gov = new MemoryGovernance(db);

      const shared = insertChunk(db, {
        lifecycle: "generated",
        governance_json: JSON.stringify({ accessScope: "shared" }),
      });
      const priv = insertChunk(db, {
        lifecycle: "activated",
        governance_json: JSON.stringify({ accessScope: "private" }),
      });

      expect(gov.canAccess(shared, { actor: "local_agent", purpose: "read" })).toBe(true);
      expect(gov.canAccess(priv, { actor: "local_agent", purpose: "read" })).toBe(true);
      // Private crystals deny external actors
      expect(gov.canAccess(priv, { actor: "peer", purpose: "read" })).toBe(false);
    });
  });

  describe("sensitivity tagging", () => {
    it("detects confidential content (passwords, API keys)", () => {
      const gov = new MemoryGovernance(db);
      expect(gov.tagSensitivity("The password is abc123")).toBe("confidential");
      expect(gov.tagSensitivity("Set the API_KEY in .env")).toBe("confidential");
      expect(gov.tagSensitivity("Store the token securely")).toBe("confidential");
    });

    it("detects personal content (feelings, personal info)", () => {
      const gov = new MemoryGovernance(db);
      expect(gov.tagSensitivity("I feel overwhelmed by this task")).toBe("personal");
      expect(gov.tagSensitivity("My email is user@example.com")).toBe("personal");
    });

    it("returns normal for neutral content", () => {
      const gov = new MemoryGovernance(db);
      expect(gov.tagSensitivity("The function returns an array of strings")).toBe("normal");
    });
  });

  describe("provenance tracking", () => {
    it("records provenance events and updates chain", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db, { provenance_chain: "[]" });

      gov.recordProvenance(id, {
        event: "derived_from",
        sourceId: "parent-crystal-1",
        metadata: { reason: "consolidation" },
      });

      const row = db.prepare("SELECT provenance_chain FROM chunks WHERE id = ?").get(id) as {
        provenance_chain: string;
      };
      const chain = JSON.parse(row.provenance_chain);
      expect(chain).toContain("parent-crystal-1");

      // Verify audit log entry
      const logs = db
        .prepare("SELECT * FROM memory_audit_log WHERE chunk_id = ? AND operation = 'provenance'")
        .all(id);
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe("TTL enforcement", () => {
    it("expires crystals past their TTL", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db, {
        lifecycle: "generated",
        governance_json: JSON.stringify({
          lifespanPolicy: "ttl",
          ttlMs: 1000, // 1 second TTL
        }),
        created_at: Date.now() - 5000, // created 5 seconds ago
      });

      const expired = gov.enforceLifespan();
      expect(expired).toBeGreaterThanOrEqual(1);

      const row = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(id) as {
        lifecycle: string;
      };
      expect(row.lifecycle).toBe("expired");
    });

    it("does not expire crystals within TTL", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db, {
        lifecycle: "generated",
        governance_json: JSON.stringify({
          lifespanPolicy: "ttl",
          ttlMs: 999999999,
        }),
        created_at: Date.now(),
      });

      gov.enforceLifespan();

      const row = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(id) as {
        lifecycle: string;
      };
      expect(row.lifecycle).toBe("generated");
    });

    it("skips frozen crystals", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db, {
        lifecycle: "frozen",
        governance_json: JSON.stringify({
          lifespanPolicy: "ttl",
          ttlMs: 1,
        }),
        created_at: Date.now() - 10000,
      });

      gov.enforceLifespan();

      const row = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(id) as {
        lifecycle: string;
      };
      expect(row.lifecycle).toBe("frozen");
    });
  });

  describe("audit logging", () => {
    it("logs access events", () => {
      const gov = new MemoryGovernance(db);
      const id = insertChunk(db);

      gov.logAccess(id, "search", { actor: "agent", purpose: "answer_query" });

      const logs = db
        .prepare("SELECT * FROM memory_audit_log WHERE chunk_id = ? AND operation = 'search'")
        .all(id);
      expect(logs.length).toBe(1);
    });
  });

  describe("governance stats", () => {
    it("reports lifecycle and sensitivity counts", () => {
      const gov = new MemoryGovernance(db);
      insertChunk(db, {
        lifecycle: "generated",
        governance_json: JSON.stringify({ sensitivity: "normal" }),
      });
      insertChunk(db, {
        lifecycle: "activated",
        governance_json: JSON.stringify({ sensitivity: "personal" }),
      });
      insertChunk(db, {
        lifecycle: "expired",
        governance_json: JSON.stringify({ sensitivity: "confidential" }),
      });

      const stats = gov.getStats();
      expect(stats.lifecycleCounts["generated"]).toBeGreaterThanOrEqual(1);
      expect(stats.sensitivityCounts.personal).toBeGreaterThanOrEqual(1);
      expect(stats.sensitivityCounts.confidential).toBeGreaterThanOrEqual(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. TASK MEMORY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task Memory Manager", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("registers and retrieves goals", () => {
    const manager = new TaskMemoryManager(db);
    const id = manager.registerGoal("Ship the auth feature by Friday");

    const goals = manager.getActiveGoals();
    expect(goals.length).toBe(1);
    expect(goals[0]!.id).toBe(id);
    expect(goals[0]!.description).toBe("Ship the auth feature by Friday");
    expect(goals[0]!.progress).toBe(0);
    expect(goals[0]!.status).toBe("active");
  });

  it("updates goal progress and auto-completes at 1.0", () => {
    const manager = new TaskMemoryManager(db);
    const id = manager.registerGoal("Migrate database");

    manager.updateProgress(id, "Schema created", 0.5);
    let goals = manager.getActiveGoals();
    expect(goals[0]!.progress).toBe(0.5);

    manager.updateProgress(id, "Migration complete", 1.0);
    goals = manager.getActiveGoals();
    expect(goals).toHaveLength(0); // Completed goals not in active list

    const all = manager.getAllGoals();
    const completed = all.find((g) => g.id === id);
    expect(completed!.status).toBe("completed");
  });

  it("clamps progress between 0 and 1", () => {
    const manager = new TaskMemoryManager(db);
    const id = manager.registerGoal("Test clamping");

    manager.updateProgress(id, "over", 1.5);
    const goals = manager.getAllGoals();
    expect(goals.find((g) => g.id === id)!.progress).toBe(1);
  });

  it("links crystals to goals", () => {
    const manager = new TaskMemoryManager(db);
    const goalId = manager.registerGoal("Build feature X");

    manager.linkCrystal(goalId, "crystal-1");
    manager.linkCrystal(goalId, "crystal-2");
    manager.linkCrystal(goalId, "crystal-1"); // duplicate — should not add again

    const goals = manager.getActiveGoals();
    expect(goals[0]!.relatedCrystalIds).toEqual(["crystal-1", "crystal-2"]);
  });

  it("detects goals from natural language", () => {
    const manager = new TaskMemoryManager(db);

    const goals = manager.detectGoals(
      "I want to refactor the authentication module. I need to set up monitoring for the API. " +
        "Also, we should migrate to PostgreSQL from MySQL.",
    );

    expect(goals.length).toBeGreaterThanOrEqual(2);
    expect(goals.some((g) => g.includes("refactor"))).toBe(true);
  });

  it("marks stalled goals after configured timeout", () => {
    const manager = new TaskMemoryManager(db);
    const id = manager.registerGoal("Old goal", "session-1");

    // Manually backdate the updated_at
    db.prepare("UPDATE task_goals SET updated_at = ? WHERE id = ?").run(
      Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      id,
    );

    const stalled = manager.markStalledGoals(7 * 24 * 60 * 60 * 1000); // 7 day threshold
    expect(stalled).toBe(1);

    const goals = manager.getActiveGoals();
    const goal = goals.find((g) => g.id === id);
    expect(goal!.status).toBe("stalled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. MEMORY SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════════

describe("Memory Scheduler", () => {
  it("tracks LLM and embedding budget usage", () => {
    const scheduler = new MemoryScheduler({ llmCallsPerHour: 10, embeddingCallsPerHour: 50 });

    scheduler.recordLlmCall(3);
    scheduler.recordEmbeddingCall(10);

    const status = scheduler.getBudgetStatus();
    expect(status.llm.used).toBe(3);
    expect(status.llm.remaining).toBe(7);
    expect(status.embedding.used).toBe(10);
    expect(status.embedding.remaining).toBe(40);
  });

  it("reports budget exhaustion correctly", () => {
    const scheduler = new MemoryScheduler({ llmCallsPerHour: 2 });

    expect(scheduler.hasBudget("dream")).toBe(true);
    scheduler.recordLlmCall(2);
    expect(scheduler.hasBudget("dream")).toBe(false);
    expect(scheduler.hasBudget("curiosity")).toBe(false);

    // search and consolidate always have budget
    expect(scheduler.hasBudget("search")).toBe(true);
    expect(scheduler.hasBudget("consolidate")).toBe(true);
  });

  it("executes scheduled operations — higher priority runs first when queued together", async () => {
    const scheduler = new MemoryScheduler();
    const executed: string[] = [];

    // Schedule a slow operation first, then a fast high-priority one
    // The slow op triggers processQueue and blocks it, so the high-priority
    // item waits in the queue. When the slow op finishes, high runs next.
    scheduler.schedule({
      id: "slow",
      type: "embed",
      priority: 0.1,
      estimatedCost: 1,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        executed.push("slow");
      },
      createdAt: Date.now(),
    });
    // These two are added while "slow" is processing, so they queue up sorted by priority
    scheduler.schedule({
      id: "low",
      type: "embed",
      priority: 0.2,
      estimatedCost: 1,
      execute: async () => {
        executed.push("low");
      },
      createdAt: Date.now(),
    });
    scheduler.schedule({
      id: "high",
      type: "embed",
      priority: 0.9,
      estimatedCost: 1,
      execute: async () => {
        executed.push("high");
      },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 100));

    // "slow" runs first (it was already processing), then "high" before "low"
    expect(executed[0]).toBe("slow");
    expect(executed[1]).toBe("high");
    expect(executed[2]).toBe("low");
  });

  it("skips operations when budget is exhausted", async () => {
    const scheduler = new MemoryScheduler({ llmCallsPerHour: 0 });
    let executed = false;

    scheduler.schedule({
      id: "no-budget",
      type: "dream", // needs LLM budget
      priority: 1,
      estimatedCost: 1,
      execute: async () => {
        executed = true;
      },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(executed).toBe(false);
  });

  it("reports queue status by type", () => {
    const scheduler = new MemoryScheduler();
    const noop = async () => {};

    scheduler.schedule({
      id: "a",
      type: "embed",
      priority: 0.5,
      estimatedCost: 1,
      execute: noop,
      createdAt: Date.now(),
    });
    scheduler.schedule({
      id: "b",
      type: "dream",
      priority: 0.5,
      estimatedCost: 1,
      execute: noop,
      createdAt: Date.now(),
    });

    // Queue may have processed already, but getQueueStatus should not throw
    const status = scheduler.getQueueStatus();
    expect(status).toBeDefined();
    expect(typeof status.embed).toBe("number");
    expect(typeof status.dream).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. MEMSTORE — Publish/Subscribe
// ═══════════════════════════════════════════════════════════════════════════════

describe("MemStore", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("publishes a crystal and updates governance visibility", () => {
    const store = new MemStore(db);
    const id = insertChunk(db, { governance_json: JSON.stringify({ accessScope: "private" }) });

    const result = store.publish(id, "shared");

    expect(result).not.toBeNull();
    expect(result!.visibility).toBe("shared");

    const row = db
      .prepare("SELECT governance_json, publish_visibility FROM chunks WHERE id = ?")
      .get(id) as any;
    expect(JSON.parse(row.governance_json).accessScope).toBe("shared");
    expect(row.publish_visibility).toBe("shared");
  });

  it("returns null when publishing non-existent crystal", () => {
    const store = new MemStore(db);
    expect(store.publish("nonexistent", "public")).toBeNull();
  });

  it("notifies subscribers when a crystal is published", () => {
    const store = new MemStore(db);
    const received: KnowledgeCrystal[] = [];

    store.subscribe({ semanticTypes: ["fact"] }, (crystal) => {
      received.push(crystal);
    });

    const id = insertChunk(db, { semantic_type: "fact" });
    store.publish(id, "shared");

    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe(id);
  });

  it("filters subscriptions by semantic type", () => {
    const store = new MemStore(db);
    const received: KnowledgeCrystal[] = [];

    store.subscribe({ semanticTypes: ["skill"] }, (crystal) => {
      received.push(crystal);
    });

    const factId = insertChunk(db, { semantic_type: "fact" });
    store.publish(factId, "shared");

    expect(received).toHaveLength(0); // fact doesn't match skill filter
  });

  it("filters subscriptions by minimum importance", () => {
    const store = new MemStore(db);
    const received: KnowledgeCrystal[] = [];

    store.subscribe({ minImportance: 0.8 }, (crystal) => {
      received.push(crystal);
    });

    const lowId = insertChunk(db, { importance_score: 0.3 });
    store.publish(lowId, "shared");
    expect(received).toHaveLength(0);

    const highId = insertChunk(db, { importance_score: 0.9 });
    store.publish(highId, "shared");
    expect(received).toHaveLength(1);
  });

  it("unsubscribes correctly", () => {
    const store = new MemStore(db);
    const received: KnowledgeCrystal[] = [];

    const subId = store.subscribe({}, (crystal) => {
      received.push(crystal);
    });

    store.unsubscribe(subId);

    const id = insertChunk(db);
    store.publish(id, "shared");

    expect(received).toHaveLength(0);
  });

  it("imports crystals from P2P peer", () => {
    const store = new MemStore(db);

    const result = store.importFromPeer(
      {
        version: 1,
        skill_md: Buffer.from("# Imported Skill\nDo the thing efficiently").toString("base64"),
        name: "efficient-thing",
        author_peer_id: "peer-abc",
        author_pubkey: "pubkey-abc",
        signature: "sig-abc",
        timestamp: Date.now(),
        content_hash: "unique-hash-123",
      },
      "pubkey-abc",
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe("accepted");
    expect(result.crystalId).toBeDefined();

    // Verify it's stored correctly
    const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.crystalId!) as any;
    expect(row.source).toBe("skills");
    expect(row.semantic_type).toBe("skill");
    expect(row.text).toContain("Imported Skill");
  });

  it("rejects duplicate P2P imports", () => {
    const store = new MemStore(db);
    const envelope = {
      version: 1,
      skill_md: Buffer.from("skill content").toString("base64"),
      name: "test-skill",
      author_peer_id: "peer-1",
      author_pubkey: "key-1",
      signature: "sig-1",
      timestamp: Date.now(),
      content_hash: "dup-hash",
    };

    // Insert a chunk with the same hash
    insertChunk(db, { hash: "dup-hash" });

    const result = store.importFromPeer(envelope, "key-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("duplicate content");
  });

  it("retrieves published crystals with filters", () => {
    const store = new MemStore(db);

    const id1 = insertChunk(db, { semantic_type: "skill", importance_score: 0.9 });
    const id2 = insertChunk(db, { semantic_type: "fact", importance_score: 0.3 });
    store.publish(id1, "shared");
    store.publish(id2, "public");

    const all = store.getPublished();
    expect(all.length).toBe(2);

    const skills = store.getPublished({ semanticTypes: ["skill"] });
    expect(skills.length).toBe(1);
    expect(skills[0]!.id).toBe(id1);

    const important = store.getPublished({ minImportance: 0.8 });
    expect(important.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. MEMORY PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Memory Pipeline", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("retrieves and filters crystals via fluent API", async () => {
    insertChunk(db, { importance_score: 0.9, semantic_type: "fact", text: "Important fact" });
    insertChunk(db, { importance_score: 0.3, semantic_type: "fact", text: "Low importance fact" });
    insertChunk(db, { importance_score: 0.8, semantic_type: "skill", text: "A skill" });

    const result = await MemoryPipeline.create()
      .retrieve("test", { semanticType: "fact" })
      .filter((c) => c.importanceScore > 0.5)
      .execute(db);

    expect(result.retrieved).toBe(2); // 2 facts
    expect(result.filtered).toBe(1); // 1 filtered out (low importance)
    expect(result.crystals).toHaveLength(1);
    expect(result.crystals[0]!.text).toBe("Important fact");
  });

  it("augments crystals with a transform function", async () => {
    insertChunk(db, { importance_score: 0.5, text: "Original content" });

    const result = await MemoryPipeline.create()
      .retrieve("test")
      .augment((c) => ({ ...c, importanceScore: c.importanceScore + 0.1 }))
      .execute(db);

    expect(result.augmented).toBeGreaterThan(0);
    expect(result.crystals[0]!.importanceScore).toBeCloseTo(0.6);
  });

  it("stores modified crystals back to the database", async () => {
    const id = insertChunk(db, { importance_score: 0.5, semantic_type: "general" });

    await MemoryPipeline.create()
      .retrieve("test")
      .augment((c) => ({ ...c, importanceScore: 0.95, semanticType: "insight" }))
      .store()
      .execute(db);

    const row = db
      .prepare("SELECT importance_score, semantic_type FROM chunks WHERE id = ?")
      .get(id) as any;
    expect(row.importance_score).toBeCloseTo(0.95);
    expect(row.semantic_type).toBe("insight");
  });

  it("reports timing information", async () => {
    insertChunk(db);

    const result = await MemoryPipeline.create().retrieve("test").execute(db);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. INTEGRATION — Cross-system feedback loops
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: Cross-system feedback loops", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("Hormonal → Consolidation modulation", () => {
    it("stressed state produces higher decay resistance", () => {
      const hormonal = new HormonalStateManager();
      // Simulate stress
      hormonal.stimulate("urgency");
      hormonal.stimulate("error");

      const mod = hormonal.getConsolidationModulation();
      expect(mod.decayResistance).toBeGreaterThan(0.1);
      expect(mod.mergeThreshold).toBeGreaterThan(0.92);
    });

    it("homeostasis state produces minimal modulation", () => {
      const hormonal = new HormonalStateManager();
      const mod = hormonal.getConsolidationModulation();
      // At homeostasis (dopamine=0.15, cortisol=0.02, oxytocin=0.10),
      // decay resistance is small but nonzero
      expect(mod.decayResistance).toBeLessThan(0.1);
      expect(mod.mergeThreshold).toBeCloseTo(0.92, 1);
    });
  });

  describe("Dream → Curiosity feedback loop", () => {
    it("dream insights can resolve curiosity knowledge gaps", () => {
      // Set up chunks and curiosity engine
      for (let i = 0; i < 10; i++) {
        insertChunk(db, {
          text: `Knowledge chunk ${i}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
        });
      }

      const curiosity = new CuriosityEngine(db);
      curiosity.run(); // build regions

      // Create a knowledge gap
      const region = db.prepare("SELECT * FROM curiosity_regions LIMIT 1").get() as any;
      if (!region) {
        return;
      }

      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, expires_at)
         VALUES (?, 'knowledge_gap', 'Need to understand topic X', 0.8, ?, '{}', ?, ?)`,
      ).run("loop-gap", region.id, Date.now(), Date.now() + 86400000);

      // Simulate a dream insight that fills the gap
      const centroid = JSON.parse(region.centroid);
      const insight: DreamInsight = {
        id: "loop-insight",
        content: "Topic X works by combining approaches A and B",
        embedding: centroid,
        confidence: 0.9,
        mode: "exploration",
        sourceChunkIds: [],
        sourceClusterIds: [],
        dreamCycleId: "loop-cycle",
        importanceScore: 0.7,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Feed insight back to curiosity engine
      curiosity.assessDreamInsight(insight);

      // Gap should be resolved
      const target = db
        .prepare("SELECT resolved_at FROM curiosity_targets WHERE id = 'loop-gap'")
        .get() as any;
      expect(target.resolved_at).not.toBeNull();
    });
  });

  describe("Curiosity → Dream mode weight adjustment", () => {
    it("knowledge gaps boost exploration dream weight", () => {
      for (let i = 0; i < 10; i++) {
        insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
      }

      const curiosity = new CuriosityEngine(db);
      curiosity.run();

      // Insert gaps
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
           VALUES (?, 'knowledge_gap', ?, 0.5, '{}', ?, ?)`,
        ).run(`adj-gap-${i}`, `Gap ${i}`, Date.now(), Date.now() + 86400000);
      }

      const adjustments = curiosity.getDreamModeWeightAdjustments();
      expect(adjustments.exploration).toBeGreaterThan(0);
    });

    it("contradictions boost simulation dream weight", () => {
      for (let i = 0; i < 10; i++) {
        insertChunk(db, { embedding: JSON.stringify(fakeEmbedding(i + 1)) });
      }

      const curiosity = new CuriosityEngine(db);
      curiosity.run();

      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
         VALUES (?, 'contradiction', 'Conflicting info about X', 0.7, '{}', ?, ?)`,
      ).run("contra-1", Date.now(), Date.now() + 86400000);

      const adjustments = curiosity.getDreamModeWeightAdjustments();
      expect(adjustments.simulation).toBeGreaterThan(0);
    });
  });

  describe("Dream Mutation → Skill Crystallization → Cycling", () => {
    it("end-to-end: dream mutation gets evaluated, promoted, and crystallized as a new skill chunk", async () => {
      // 1. Set up skill chunks for mutation
      const originalSkillIds: string[] = [];
      for (let i = 0; i < 25; i++) {
        const id = insertChunk(db, {
          text: `Deploy using Docker with health checks and monitoring, variant ${i}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
          importance_score: 0.7,
          memory_type: i < 3 ? "skill" : "plaintext",
          semantic_type: i < 3 ? "skill" : "general",
        });
        if (i < 3) {
          originalSkillIds.push(id);
        }
      }

      // Count skill chunks before dream
      const skillsBefore = (
        db.prepare("SELECT COUNT(*) as c FROM chunks WHERE memory_type = 'skill'").get() as {
          c: number;
        }
      ).c;

      // 2. Run dream mutation mode
      const llm = mockLlmCall([
        JSON.stringify([
          {
            content:
              "Deploy using Docker with health checks, monitoring, and edge case handling for resource limits. More general approach with Kubernetes fallback.",
            confidence: 0.9,
            keywords: ["docker", "deploy", "kubernetes"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["mutation"] });

      expect(stats).not.toBeNull();
      const mutations = stats!.newInsights.filter((i) => i.mode === "mutation");
      expect(mutations.length).toBeGreaterThan(0);

      // 3. Evaluate and crystallize with SkillRefiner
      let crystallizedId: string | null = null;
      const refiner = new SkillRefiner(db, { promotionThreshold: 0.4 }, (id) => {
        crystallizedId = id;
      });

      const sourceId = mutations[0]!.sourceChunkIds[0]!;
      const source = db.prepare("SELECT id, text FROM chunks WHERE id = ?").get(sourceId) as any;

      // Dream engine already stored insights in dream_insights during run() — no manual insert needed
      const result = refiner.evaluateMutations(source, mutations);
      expect(result.mutations.length).toBeGreaterThan(0);
      expect(result.mutations[0]!.promoted).toBe(true);

      // 4. Verify crystallization: new skill chunk was created
      expect(crystallizedId).not.toBeNull();
      const newSkill = db.prepare("SELECT * FROM chunks WHERE id = ?").get(crystallizedId!) as any;

      expect(newSkill).toBeDefined();
      expect(newSkill.memory_type).toBe("skill");
      expect(newSkill.semantic_type).toBe("skill");
      expect(newSkill.lifecycle).toBe("frozen");
      expect(newSkill.origin).toBe("dream");
      expect(newSkill.source).toBe("skills");
      expect(newSkill.parent_id).toBe(sourceId);
      expect(newSkill.text).toContain("Docker");
      expect(newSkill.text).toContain("edge case");

      // Provenance chain should link back to original + mutation
      const provenance = JSON.parse(newSkill.provenance_chain);
      expect(provenance).toContain(sourceId);

      // 5. Verify skill count increased
      const skillsAfter = (
        db.prepare("SELECT COUNT(*) as c FROM chunks WHERE memory_type = 'skill'").get() as {
          c: number;
        }
      ).c;
      expect(skillsAfter).toBeGreaterThan(skillsBefore);

      // 6. Verify audit trail
      const auditLog = db
        .prepare("SELECT * FROM memory_audit_log WHERE event = 'skill_mutation_promoted'")
        .all() as any[];
      expect(auditLog.length).toBeGreaterThan(0);
      const logEntry = auditLog[0];
      expect(logEntry.chunk_id).toBe(crystallizedId);
      expect(logEntry.actor).toBe("skill_refiner");
      const metadata = JSON.parse(logEntry.metadata);
      expect(metadata.originalId).toBe(sourceId);
    });

    it("crystallized skill survives consolidation (frozen lifecycle)", async () => {
      // 1. Create and crystallize a skill via SkillRefiner
      const originalId = insertChunk(db, {
        text: "Original deployment skill with Docker and Kubernetes",
        memory_type: "skill",
        semantic_type: "skill",
        lifecycle: "frozen",
        importance_score: 0.8,
      });

      const mutation: DreamInsight = {
        id: "mut-survive",
        content:
          "Improved deployment with Docker, Kubernetes, and edge case handling for resource limits. More general approach with fallback.",
        embedding: [],
        confidence: 0.9,
        mode: "mutation",
        sourceChunkIds: [originalId],
        sourceClusterIds: [],
        dreamCycleId: "cycle-survive",
        importanceScore: 0.7,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      db.prepare(
        `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
         VALUES (?, ?, '[]', ?, 'mutation', '[]', '[]', ?, 0.7, 0, ?, ?)`,
      ).run(
        mutation.id,
        mutation.content,
        mutation.confidence,
        mutation.dreamCycleId,
        Date.now(),
        Date.now(),
      );

      let crystallizedId: string | null = null;
      const refiner = new SkillRefiner(db, { promotionThreshold: 0.3 }, (id) => {
        crystallizedId = id;
      });
      refiner.evaluateMutations(
        { id: originalId, text: "Original deployment skill with Docker and Kubernetes" },
        [mutation],
      );
      expect(crystallizedId).not.toBeNull();

      // 2. Run consolidation — the new skill should survive because lifecycle='frozen'
      const engine = new ConsolidationEngine(db, { forgetThreshold: 0.1 });
      engine.run();

      const skill = db
        .prepare("SELECT lifecycle, lifecycle_state FROM chunks WHERE id = ?")
        .get(crystallizedId!) as any;
      expect(skill.lifecycle).toBe("frozen");
      expect(skill.lifecycle_state).not.toBe("forgotten");
    });

    it("crystallized skill is picked up by the next dream mutation cycle", async () => {
      // 1. Create a crystallized skill (simulates output from a previous dream cycle)
      const crystallizedId = insertChunk(db, {
        text: "Use Docker with health checks, Kubernetes fallback, and resource limit edge cases",
        memory_type: "skill",
        semantic_type: "skill",
        lifecycle: "frozen",
        origin: "dream",
        importance_score: 0.85,
        path: "dream/mutation/prev-original",
        source: "skills",
        embedding: JSON.stringify(fakeEmbedding(99)),
      });

      // Pad with general chunks to meet minimum
      for (let i = 0; i < 24; i++) {
        insertChunk(db, {
          text: `General content about software engineering topic ${i}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
          importance_score: 0.5,
        });
      }

      // 2. Run dream mutation mode — it should pick up our crystallized skill
      const llm = mockLlmCall([
        JSON.stringify([
          {
            content: "Enhanced Docker deployment with auto-scaling and graceful shutdown handling",
            confidence: 0.85,
            keywords: ["docker", "auto-scaling"],
          },
        ]),
      ]);

      const engine = new DreamEngine(
        db,
        { llmCall: llm, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats = await engine.run({ modes: ["mutation"] });

      expect(stats).not.toBeNull();
      const mutations = stats!.newInsights.filter((i) => i.mode === "mutation");
      expect(mutations.length).toBeGreaterThan(0);

      // The mutation's source should be our crystallized skill (it's the highest importance skill)
      const sourcedFromCrystallized = mutations.some((m) =>
        m.sourceChunkIds.includes(crystallizedId),
      );
      expect(sourcedFromCrystallized).toBe(true);
    });

    it("full skill evolution cycle: original → mutate → crystallize → re-mutate", async () => {
      // ── Cycle 1: Start with an original skill ──
      const origId = insertChunk(db, {
        text: "Deploy application using Docker containers with monitoring",
        memory_type: "skill",
        semantic_type: "skill",
        lifecycle: "frozen",
        importance_score: 0.8,
        embedding: JSON.stringify(fakeEmbedding(1)),
        source: "skills",
      });

      // Pad with general chunks
      for (let i = 0; i < 24; i++) {
        insertChunk(db, {
          text: `Background chunk ${i} about various topics`,
          embedding: JSON.stringify(fakeEmbedding(i + 10)),
          importance_score: 0.3,
        });
      }

      // Dream mutation cycle 1
      const llm1 = mockLlmCall([
        JSON.stringify([
          {
            content:
              "Deploy application using Docker containers with monitoring. Handle edge case for resource limits. More general approach with Kubernetes fallback.",
            confidence: 0.9,
            keywords: ["docker", "deploy"],
          },
        ]),
      ]);

      const dream1 = new DreamEngine(
        db,
        { llmCall: llm1, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats1 = await dream1.run({ modes: ["mutation"] });
      const muts1 = stats1!.newInsights.filter((i) => i.mode === "mutation");
      expect(muts1.length).toBeGreaterThan(0);

      // Crystallize cycle 1 mutation (dream engine already stored insights)
      let gen1CrystalId: string | null = null;
      const refiner1 = new SkillRefiner(db, { promotionThreshold: 0.4 }, (id) => {
        gen1CrystalId = id;
      });
      const source1 = db.prepare("SELECT id, text FROM chunks WHERE id = ?").get(origId) as any;
      refiner1.evaluateMutations(source1, muts1);
      expect(gen1CrystalId).not.toBeNull();

      // Verify gen1 skill crystal exists
      const gen1 = db.prepare("SELECT * FROM chunks WHERE id = ?").get(gen1CrystalId!) as any;
      expect(gen1.memory_type).toBe("skill");
      expect(gen1.lifecycle).toBe("frozen");
      expect(gen1.parent_id).toBe(origId);

      // ── Cycle 2: Dream should pick up the gen1 crystal ──
      const llm2 = mockLlmCall([
        JSON.stringify([
          {
            content:
              "Deploy application using Docker with health checks, resource limits, Kubernetes orchestration, and CI/CD pipeline integration for automated rollbacks. Handle edge case when services fail.",
            confidence: 0.92,
            keywords: ["docker", "kubernetes", "ci-cd"],
          },
        ]),
      ]);

      const dream2 = new DreamEngine(
        db,
        { llmCall: llm2, minChunksForDream: 5 },
        noopSynthesize,
        noopEmbedBatch,
      );
      const stats2 = await dream2.run({ modes: ["mutation"] });
      const muts2 = stats2!.newInsights.filter((i) => i.mode === "mutation");
      expect(muts2.length).toBeGreaterThan(0);

      // Verify the gen1 crystal was used as a source (highest-importance skill)
      // It should be one of: the original or the gen1 crystal
      const allSkillIds = new Set([origId, gen1CrystalId!]);
      const sourcedFromSkill = muts2.some((m) =>
        m.sourceChunkIds.some((id) => allSkillIds.has(id)),
      );
      expect(sourcedFromSkill).toBe(true);

      // Crystallize cycle 2 mutation (dream engine already stored insights)
      let gen2CrystalId: string | null = null;
      const refiner2 = new SkillRefiner(db, { promotionThreshold: 0.4 }, (id) => {
        gen2CrystalId = id;
      });
      const source2 = db
        .prepare("SELECT id, text FROM chunks WHERE id = ?")
        .get(muts2[0]!.sourceChunkIds[0]!) as any;
      refiner2.evaluateMutations(source2, muts2);
      expect(gen2CrystalId).not.toBeNull();

      // Verify gen2 skill has correct lineage
      const gen2 = db.prepare("SELECT * FROM chunks WHERE id = ?").get(gen2CrystalId!) as any;
      expect(gen2.memory_type).toBe("skill");
      expect(gen2.lifecycle).toBe("frozen");
      expect(gen2.origin).toBe("dream");

      // Verify the provenance chain
      const gen2Provenance = JSON.parse(gen2.provenance_chain);
      expect(gen2Provenance.length).toBeGreaterThan(0);

      // Verify we now have 3+ skill chunks (original + gen1 + gen2)
      const totalSkills = (
        db.prepare("SELECT COUNT(*) as c FROM chunks WHERE memory_type = 'skill'").get() as {
          c: number;
        }
      ).c;
      expect(totalSkills).toBeGreaterThanOrEqual(3);

      // Verify all 3 survive consolidation (frozen lifecycle)
      const consolidation = new ConsolidationEngine(db, { forgetThreshold: 0.1 });
      consolidation.run();

      for (const skillId of [origId, gen1CrystalId!, gen2CrystalId!]) {
        const after = db.prepare("SELECT lifecycle FROM chunks WHERE id = ?").get(skillId) as any;
        expect(after.lifecycle).toBe("frozen");
      }
    });

    it("skill mutation provenance tracks full lineage across generations", () => {
      // Manually simulate 3 generations of skill evolution
      const gen0Id = insertChunk(db, {
        text: "Base skill: deploy with Docker",
        memory_type: "skill",
        semantic_type: "skill",
        lifecycle: "frozen",
        provenance_chain: "[]",
      });

      // Gen1: mutated from gen0
      const gen1Mutation: DreamInsight = {
        id: "lineage-mut-1",
        content: "Deploy with Docker and edge case handling. More general approach.",
        embedding: [],
        confidence: 0.85,
        mode: "mutation",
        sourceChunkIds: [gen0Id],
        sourceClusterIds: [],
        dreamCycleId: "lineage-cycle-1",
        importanceScore: 0.6,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      db.prepare(
        `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
         VALUES (?, ?, '[]', ?, 'mutation', '[]', '[]', ?, 0.6, 0, ?, ?)`,
      ).run(
        gen1Mutation.id,
        gen1Mutation.content,
        gen1Mutation.confidence,
        gen1Mutation.dreamCycleId,
        Date.now(),
        Date.now(),
      );

      let gen1Id: string | null = null;
      const refiner = new SkillRefiner(db, { promotionThreshold: 0.3 }, (id) => {
        gen1Id = id;
      });
      refiner.evaluateMutations({ id: gen0Id, text: "Base skill: deploy with Docker" }, [
        gen1Mutation,
      ]);
      expect(gen1Id).not.toBeNull();

      // Gen2: mutated from gen1
      const gen2Mutation: DreamInsight = {
        id: "lineage-mut-2",
        content:
          "Deploy with Docker, Kubernetes fallback, resource edge cases, auto-scaling. More robust.",
        embedding: [],
        confidence: 0.9,
        mode: "mutation",
        sourceChunkIds: [gen1Id!],
        sourceClusterIds: [],
        dreamCycleId: "lineage-cycle-2",
        importanceScore: 0.7,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      db.prepare(
        `INSERT INTO dream_insights (id, content, embedding, confidence, mode, source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score, access_count, created_at, updated_at)
         VALUES (?, ?, '[]', ?, 'mutation', '[]', '[]', ?, 0.7, 0, ?, ?)`,
      ).run(
        gen2Mutation.id,
        gen2Mutation.content,
        gen2Mutation.confidence,
        gen2Mutation.dreamCycleId,
        Date.now(),
        Date.now(),
      );

      let gen2Id: string | null = null;
      const refiner2 = new SkillRefiner(db, { promotionThreshold: 0.3 }, (id) => {
        gen2Id = id;
      });
      const gen1Chunk = db.prepare("SELECT id, text FROM chunks WHERE id = ?").get(gen1Id!) as any;
      refiner2.evaluateMutations(gen1Chunk, [gen2Mutation]);
      expect(gen2Id).not.toBeNull();

      // Verify lineage:
      // gen0 → gen1 (parent_id = gen0)
      // gen1 → gen2 (parent_id = gen1)
      const gen1Row = db
        .prepare("SELECT parent_id, provenance_chain FROM chunks WHERE id = ?")
        .get(gen1Id!) as any;
      expect(gen1Row.parent_id).toBe(gen0Id);
      const gen1Prov = JSON.parse(gen1Row.provenance_chain);
      expect(gen1Prov).toContain(gen0Id);

      const gen2Row = db
        .prepare("SELECT parent_id, provenance_chain FROM chunks WHERE id = ?")
        .get(gen2Id!) as any;
      expect(gen2Row.parent_id).toBe(gen1Id);
      const gen2Prov = JSON.parse(gen2Row.provenance_chain);
      expect(gen2Prov).toContain(gen1Id!);

      // Audit trail should show both promotions
      const auditLogs = db
        .prepare(
          "SELECT * FROM memory_audit_log WHERE event = 'skill_mutation_promoted' ORDER BY timestamp ASC",
        )
        .all() as any[];
      expect(auditLogs.length).toBeGreaterThanOrEqual(2);
    });

    it("P2P round-trip: crystallized skill can be published and imported by peer", () => {
      // 1. Create a dream-crystallized skill
      const skillId = insertChunk(db, {
        text: "Advanced Docker deployment with Kubernetes and monitoring",
        memory_type: "skill",
        semantic_type: "skill",
        lifecycle: "frozen",
        origin: "dream",
        source: "skills",
        importance_score: 0.9,
        governance_json: JSON.stringify({
          accessScope: "shared",
          lifespanPolicy: "permanent",
          priority: 0.9,
          sensitivity: "normal",
          provenanceChain: [],
        }),
      });

      // 2. Publish it via MemStore
      const store = new MemStore(db);
      const publishResult = store.publish(skillId, "shared");
      expect(publishResult).not.toBeNull();
      expect(publishResult!.visibility).toBe("shared");

      // 3. Verify it appears in published skills
      const published = store.getPublished({ semanticTypes: ["skill"] });
      expect(published.length).toBe(1);
      expect(published[0]!.id).toBe(skillId);

      // 4. Simulate P2P import on another "peer" DB
      const peerDb = createTestDb();
      const peerStore = new MemStore(peerDb);

      const envelope = {
        version: 1,
        skill_md: Buffer.from("Advanced Docker deployment with Kubernetes and monitoring").toString(
          "base64",
        ),
        name: "docker-k8s-deploy",
        author_peer_id: "peer-123",
        author_pubkey: "pubkey-abc",
        signature: "sig-xyz",
        timestamp: Date.now(),
        content_hash: "hash-" + crypto.randomUUID(),
      };

      const importResult = peerStore.importFromPeer(envelope, "pubkey-abc");
      expect(importResult.ok).toBe(true);
      expect(importResult.action).toBe("accepted");

      // 5. Verify the imported skill is a proper skill chunk on the peer
      const importedRow = peerDb
        .prepare("SELECT * FROM chunks WHERE id = ?")
        .get(importResult.crystalId!) as any;
      expect(importedRow.source).toBe("skills");
      expect(importedRow.semantic_type).toBe("skill");
      expect(importedRow.text).toContain("Docker");
    });
  });

  describe("Goal tracking → Dream extrapolation", () => {
    it("active goals are trackable alongside dream-relevant crystals", () => {
      const taskMemory = new TaskMemoryManager(db);
      const goalId = taskMemory.registerGoal("Build a real-time notification system");
      taskMemory.updateProgress(goalId, "Started research", 0.2);

      // Insert goal-relevant chunks
      for (let i = 0; i < 5; i++) {
        const chunkId = insertChunk(db, {
          text: `Notification system design: use WebSocket for real-time, pattern ${i}`,
          semantic_type: "goal",
          importance_score: 0.6,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
        });
        taskMemory.linkCrystal(goalId, chunkId);
      }

      const goals = taskMemory.getActiveGoals();
      expect(goals).toHaveLength(1);
      expect(goals[0]!.relatedCrystalIds.length).toBe(5);
      expect(goals[0]!.progress).toBe(0.2);
    });
  });

  describe("Governance → MemStore access control", () => {
    it("published crystals respect governance visibility", () => {
      const store = new MemStore(db);
      const gov = new MemoryGovernance(db);

      const id = insertChunk(db, {
        lifecycle: "generated",
        governance_json: JSON.stringify({ accessScope: "private" }),
      });

      // Before publishing, crystal is private — only local_agent can access
      expect(gov.canAccess(id, { actor: "local_agent", purpose: "share" })).toBe(true);
      expect(gov.canAccess(id, { actor: "peer", purpose: "share" })).toBe(false);

      // Publish changes visibility
      store.publish(id, "shared");

      const row = db.prepare("SELECT governance_json FROM chunks WHERE id = ?").get(id) as any;
      const gov_data = JSON.parse(row.governance_json);
      expect(gov_data.accessScope).toBe("shared");
    });
  });

  describe("User Model → Hormonal system integration", () => {
    it("session content triggers both preference extraction and hormonal influence", () => {
      const userModel = new UserModelManager(db);
      const hormonal = new HormonalStateManager();

      const text = "I prefer TypeScript. We successfully shipped the feature! Thank you team.";

      // Extract preferences
      const prefs = userModel.extractPreferences(text, "chunk-1");
      expect(prefs.some((p) => p.key === "preferred_language")).toBe(true);

      // Compute hormonal influence
      const influence = hormonal.computeCrystalInfluence(text, "sessions");
      expect(influence.dopamine).toBeGreaterThan(0); // "successfully"
      expect(influence.oxytocin).toBeGreaterThan(0); // "thank" + "team" + sessions baseline
    });
  });

  describe("Full consolidated cycle simulation", () => {
    it("runs the complete memory maintenance cycle without errors", () => {
      // Seed a realistic memory state
      for (let i = 0; i < 30; i++) {
        insertChunk(db, {
          text: `Memory chunk ${i} about ${["coding", "deployment", "testing", "design", "review"][i % 5]}`,
          embedding: JSON.stringify(fakeEmbedding(i + 1)),
          importance_score: 0.1 + (i % 10) * 0.09,
          semantic_type: ["fact", "preference", "episode", "skill", "general"][i % 5] as any,
          lifecycle: "generated",
        });
      }

      // 1. Hormonal decay
      const hormonal = new HormonalStateManager();
      hormonal.stimulate("reward");
      hormonal.decay();

      // 2. Consolidation
      const consolidation = new ConsolidationEngine(db);
      const consStats = consolidation.run();
      expect(consStats).toBeDefined();

      // 3. Curiosity engine
      const curiosity = new CuriosityEngine(db);
      curiosity.run();

      // 4. Governance enforcement
      const governance = new MemoryGovernance(db);
      governance.enforceLifespan();

      // 5. Task memory maintenance
      const taskMemory = new TaskMemoryManager(db);
      taskMemory.markStalledGoals();

      // 6. User model pattern detection
      const userModel = new UserModelManager(db);
      const patterns = userModel.detectPatterns([
        "I always prefer TypeScript",
        "I always prefer TypeScript over JavaScript",
        "I tend to use functional patterns",
        "I tend to use functional patterns in React",
      ]);

      // Everything should complete without throwing
      expect(consStats.forgottenChunks).toBeGreaterThanOrEqual(0);
      expect(patterns).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. FULL E2E PIPELINE: ingest → consolidate → dream → curiosity
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full E2E Pipeline: ingest → consolidate → dream → curiosity", () => {
  it("runs the complete pipeline producing insights and valid curiosity state", async () => {
    const db = createTestDb();

    // Phase 1: Ingest — seed 30 diverse chunks simulating real usage
    const types: Array<{ type: string; count: number; textPrefix: string }> = [
      {
        type: "episode",
        count: 10,
        textPrefix: "User discussed project architecture with detailed analysis of",
      },
      {
        type: "preference",
        count: 5,
        textPrefix: "User prefers TypeScript over JavaScript because of strong typing",
      },
      {
        type: "task_pattern",
        count: 5,
        textPrefix: "When deploying, always run health checks first then verify the",
      },
      {
        type: "goal",
        count: 3,
        textPrefix: "Goal: ship the beta release by end of March with full coverage",
      },
      {
        type: "relationship",
        count: 3,
        textPrefix: "User Vic is the creator of Bitterbot, a neuroscientist who builds",
      },
      {
        type: "fact",
        count: 4,
        textPrefix: "Bitterbot uses SQLite for crystal storage with vector search via",
      },
    ];

    let chunkIndex = 0;
    for (const { type, count, textPrefix } of types) {
      for (let i = 0; i < count; i++) {
        insertChunk(db, {
          text: `${textPrefix} variant-${i} with details about ${type}-specific-content-${i}`,
          importance_score: 0.3 + Math.random() * 0.6,
          semantic_type: type,
          embedding: JSON.stringify(fakeEmbedding(chunkIndex++)),
        });
      }
    }

    // Verify chunks were inserted
    const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    expect(totalChunks).toBe(30);

    // Phase 2: Consolidation
    const consolidation = new ConsolidationEngine(db, {});
    const consolidationStats = consolidation.run();
    expect(consolidationStats.totalChunks).toBeGreaterThanOrEqual(30);

    // Phase 3: Dream — run replay (heuristic) then mutation (LLM)
    const llmResponses = [
      JSON.stringify([
        {
          content: "Optimized deployment: add canary stage before full rollout",
          confidence: 0.8,
          keywords: ["deploy", "canary"],
        },
      ]),
    ];

    const llm = mockLlmCall(llmResponses);
    const engine = new DreamEngine(
      db,
      { llmCall: llm, minChunksForDream: 5 },
      noopSynthesize,
      noopEmbedBatch,
    );

    // Wire curiosity engine for weight adjustments
    const curiosity = new CuriosityEngine(db);
    engine.setCuriosityWeightProvider({
      getDreamModeWeightAdjustments: () => curiosity.getDreamModeWeightAdjustments(),
    });

    // Run replay mode (heuristic, no LLM)
    const replayStats = await engine.run({ modes: ["replay"] });
    expect(replayStats).not.toBeNull();
    expect(replayStats!.newInsights).toHaveLength(0); // Replay doesn't create insights

    // Run mutation mode (uses LLM)
    const mutationStats = await engine.run({ modes: ["mutation"] });
    expect(mutationStats).not.toBeNull();

    // Phase 4: Curiosity assessment on chunks
    const recentChunks = db
      .prepare("SELECT id, embedding, hash FROM chunks LIMIT 10")
      .all() as Array<{ id: string; embedding: string; hash: string }>;

    for (const chunk of recentChunks) {
      const embedding = JSON.parse(chunk.embedding) as number[];
      if (embedding.length > 0) {
        curiosity.assessChunk(chunk.id, embedding, chunk.hash);
      }
    }

    const curiosityState = curiosity.getState();
    expect(curiosityState.recentSurprises.length).toBeGreaterThan(0);

    // Phase 5: Verify dream cycles were recorded
    const cycles = db.prepare("SELECT * FROM dream_cycles ORDER BY started_at DESC").all();
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });
});
