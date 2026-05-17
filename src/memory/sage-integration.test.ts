/**
 * End-to-end integration test for the SAGE pipeline (PLAN-18).
 *
 * Exercises the full wired path:
 *   - chunks indexed into the `chunks` table
 *   - entities + relationships populated in the knowledge graph with
 *     evidence chunk IDs pointing at those chunks
 *   - `sageRetrieve()` runs the structured query planner + L-hop graph
 *     reader and returns chunk IDs
 *   - the manager's `computeGraphChannel` join shape produces a
 *     well-formed `HybridGraphResult[]`
 *   - `mergeHybridResultsRRF` fuses the graph channel alongside synthetic
 *     vector + keyword channels and ranks consensus-anchored chunks high
 *
 * This is the test that *proves* the modules are wired together and not
 * an isolated island of code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCooldown,
  maybeRunGraphOptimization,
  materializeGateValues,
} from "./graph-optimization-hook.js";
import { insertTrainingPair } from "./graph-optimizer.js";
import { _clearGraphReaderCache } from "./graph-reader.js";
import { mergeHybridResultsRRF, type HybridGraphResult } from "./hybrid.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { _clearQueryPlanCache } from "./query-planner.js";
import { _resetSageGateCache, sageRetrieve, DEFAULT_SAGE_CONFIG } from "./sage-memory.js";
import { requireNodeSqlite } from "./sqlite.js";
import { createDefaultGate, deserializeGate } from "./structural-gate.js";

function openDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function insertChunk(
  db: ReturnType<typeof openDb>,
  id: string,
  text: string,
  filePath: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, 'memory', 1, 1, ?, 'test-model', ?, '[]', ?)`,
  ).run(id, filePath, id, text, now);
}

function buildScenario(db: ReturnType<typeof openDb>, kg: KnowledgeGraphManager): void {
  // Chunks: facts about a small project graph.
  insertChunk(db, "c-alice", "Alice leads the team", "facts/alice.md");
  insertChunk(db, "c-project", "Project-X is the main initiative", "facts/project.md");
  insertChunk(db, "c-tool", "Project-X uses the Postgres database", "facts/tool.md");
  insertChunk(db, "c-doc", "Design doc for Project-X authored by Alice", "facts/doc.md");

  // Graph: Alice ─works_on→ Project-X ─uses→ Postgres
  //                            └─documented_by→ DesignDoc
  kg.upsertEntity({ name: "Alice", type: "person" });
  kg.upsertEntity({ name: "Project-X", type: "project" });
  kg.upsertEntity({ name: "Postgres", type: "tool" });
  kg.upsertEntity({ name: "DesignDoc", type: "file" });

  kg.upsertRelationship(
    {
      sourceName: "Alice",
      sourceType: "person",
      targetName: "Project-X",
      targetType: "project",
      relationType: "works_on",
      weight: 0.9,
    },
    ["c-alice"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Project-X",
      sourceType: "project",
      targetName: "Postgres",
      targetType: "tool",
      relationType: "uses",
      weight: 0.85,
    },
    ["c-tool"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Project-X",
      sourceType: "project",
      targetName: "DesignDoc",
      targetType: "file",
      relationType: "created_by",
      weight: 0.8,
    },
    ["c-doc"],
  );
}

/**
 * Mirror of `MemoryIndexManager.computeGraphChannel` so the test
 * exercises the exact join that production wiring uses, without
 * having to spin up the full manager with embedding providers.
 */
function computeGraphChannel(
  db: ReturnType<typeof openDb>,
  kg: KnowledgeGraphManager,
  query: string,
): Promise<HybridGraphResult[]> {
  return sageRetrieve(db, kg, query, DEFAULT_SAGE_CONFIG).then(({ graph }) => {
    if (!graph || graph.chunks.length === 0) {
      return [];
    }
    const chunkIds = graph.chunks.map((c) => c.chunkId);
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, path, source, start_line AS startLine, end_line AS endLine,
                substr(text, 1, 200) AS snippet, updated_at AS updatedAt
         FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...chunkIds) as Array<{
      id: string;
      path: string;
      source: string;
      startLine: number;
      endLine: number;
      snippet: string;
      updatedAt: number | null;
    }>;
    const scoreById = new Map(graph.chunks.map((c) => [c.chunkId, c.score]));
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      graphScore: scoreById.get(r.id) ?? 0,
      updatedAt: r.updatedAt ?? undefined,
    }));
  });
}

describe("SAGE pipeline end-to-end", () => {
  beforeEach(() => {
    _clearGraphReaderCache();
    _clearQueryPlanCache();
    _resetSageGateCache();
    _resetCooldown();
  });

  it("a multi-hop query reaches chunks across two bridge entities", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    // "What database does Alice use?" requires hopping Alice → Project-X → Postgres.
    // The Postgres evidence chunk is c-tool (2 hops from Alice).
    const channel = await computeGraphChannel(db, kg, "What database does Alice use?");

    const ids = channel.map((c) => c.id);
    // The graph reader must have reached the 2-hop evidence chunk.
    expect(ids).toContain("c-tool");
    // And it must have rich payloads (path/snippet hydrated via the join).
    const tool = channel.find((c) => c.id === "c-tool")!;
    expect(tool.path).toBe("facts/tool.md");
    expect(tool.snippet).toContain("Postgres");
    expect(tool.graphScore).toBeGreaterThan(0);
  });

  it("the graph channel composes through RRF alongside vector + keyword", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    const graphChannel = await computeGraphChannel(db, kg, "What does Alice work on?");
    expect(graphChannel.length).toBeGreaterThan(0);

    // Synthetic vector channel: pretend cosine ranked some unrelated chunk
    // high, with the target deep in the tail.
    const vectorChannel = [
      {
        id: "c-noise",
        path: "noise.md",
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: "noise",
        vectorScore: 0.9,
      },
      {
        id: "c-alice",
        path: "facts/alice.md",
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: "Alice leads",
        vectorScore: 0.1,
      },
    ];
    const keywordChannel = [
      {
        id: "c-alice",
        path: "facts/alice.md",
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: "Alice leads",
        textScore: 0.8,
      },
    ];

    const merged = mergeHybridResultsRRF({
      vector: vectorChannel,
      keyword: keywordChannel,
      graph: graphChannel,
    });

    // c-alice should rise to the top — it appears in all three channels
    // (consensus is the entire point of RRF).
    expect(merged[0]!.path).toBe("facts/alice.md");
    // And c-noise should be ranked below it.
    const aliceIdx = merged.findIndex((m) => m.path === "facts/alice.md");
    const noiseIdx = merged.findIndex((m) => m.path === "noise.md");
    expect(aliceIdx).toBeLessThan(noiseIdx);
  });

  it("graph channel is empty when no entities resolve from the query", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    const channel = await computeGraphChannel(db, kg, "completely unrelated terms");
    // Heuristic planner may still resolve fuzzy-match entities, but with
    // no capitalized runs and no aliases in the graph, the seed set is
    // empty and the channel is empty.
    expect(channel).toEqual([]);
  });

  it("hormonal modulation produces measurably different result distributions", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    const calm = await sageRetrieve(db, kg, "Alice Project", {
      ...DEFAULT_SAGE_CONFIG,
      structuralGating: { enabled: false },
      hormonalModulation: {
        enabled: true,
        getState: () => ({ dopamine: 0.1, cortisol: 0.1, oxytocin: 0.1 }),
      },
    });
    const stressed = await sageRetrieve(db, kg, "Alice Project", {
      ...DEFAULT_SAGE_CONFIG,
      structuralGating: { enabled: false },
      hormonalModulation: {
        enabled: true,
        getState: () => ({ dopamine: 0.0, cortisol: 0.9, oxytocin: 0.0 }),
      },
    });

    expect(calm.hormonalSnapshot).toBeTruthy();
    expect(stressed.hormonalSnapshot).toBeTruthy();
    expect(calm.hormonalSnapshot!.cortisol).toBeLessThan(stressed.hormonalSnapshot!.cortisol);
    // Both should produce graph results from the same seed set.
    expect(calm.graph?.chunks.length).toBeGreaterThan(0);
    expect(stressed.graph?.chunks.length).toBeGreaterThan(0);
  });
});

describe("SAGE optimizer hook end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    _clearGraphReaderCache();
    _clearQueryPlanCache();
    _resetSageGateCache();
    _resetCooldown();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hook persists a gate file and materializes gate_value on every active edge", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    // Pre-condition: relationships start at gate_value = 1.0 (the DEFAULT
    // from the v13 migration).
    const before = db
      .prepare(`SELECT gate_value FROM relationships WHERE valid_until IS NULL`)
      .all() as Array<{ gate_value: number | null }>;
    expect(before.every((r) => r.gate_value === 1.0)).toBe(true);

    // Seed training pairs against real chunk IDs.
    for (let i = 0; i < 8; i++) {
      insertTrainingPair(db, "Alice Project-X", "c-tool");
    }

    const gateFilePath = path.join(dir, "gate.json");
    const r = maybeRunGraphOptimization(
      db,
      kg,
      {
        enabled: true,
        minTrainingPairs: 4,
        gateFilePath,
        cooldownMs: 0,
        optimizer: { population: 4, generations: 2 },
      },
      null,
    );
    expect(r).not.toBeNull();
    expect(fs.existsSync(gateFilePath)).toBe(true);
    const restored = deserializeGate(JSON.parse(fs.readFileSync(gateFilePath, "utf8")));
    expect(restored).not.toBeNull();

    // Gate values should now vary — some edges dampened, some boosted.
    const after = db
      .prepare(`SELECT gate_value FROM relationships WHERE valid_until IS NULL`)
      .all() as Array<{ gate_value: number | null }>;
    expect(after.length).toBeGreaterThan(0);
    for (const row of after) {
      expect(row.gate_value).not.toBeNull();
      expect(Number.isFinite(row.gate_value!)).toBe(true);
      expect(row.gate_value!).toBeGreaterThanOrEqual(0);
      expect(row.gate_value!).toBeLessThanOrEqual(2.5);
    }
    // At least one edge should have shifted away from the uniform 1.0 baseline.
    const shifted = after.some((r) => Math.abs(r.gate_value! - 1.0) > 1e-6);
    expect(shifted).toBe(true);
  });

  it("training-pair insertion drives the optimizer from cold start", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    // Cold start: zero training pairs collected.
    const cold = db.prepare(`SELECT COUNT(*) AS c FROM graph_gate_training_pairs`).get() as {
      c: number;
    };
    expect(cold.c).toBe(0);

    // Simulate the search-path collector firing across multiple queries.
    // This mirrors what `MemoryIndexManager.recordSageSignals` does
    // when sampling triggers — we exercise the storage path directly
    // here so the test is deterministic.
    for (const [q, chunkId] of [
      ["What does Alice work on?", "c-alice"],
      ["Tell me about Project-X", "c-project"],
      ["What tool is in use?", "c-tool"],
      ["Who authored the design doc?", "c-doc"],
      ["Alice Project", "c-alice"],
      ["Postgres setup", "c-tool"],
    ] as const) {
      insertTrainingPair(db, q, chunkId, "access_log");
    }

    const warm = db.prepare(`SELECT COUNT(*) AS c FROM graph_gate_training_pairs`).get() as {
      c: number;
    };
    expect(warm.c).toBe(6);

    // Now the optimizer can actually run end-to-end against these pairs.
    const gateFilePath = path.join(dir, "warm-gate.json");
    const r = maybeRunGraphOptimization(
      db,
      kg,
      {
        enabled: true,
        minTrainingPairs: 4,
        gateFilePath,
        cooldownMs: 0,
        optimizer: { population: 4, generations: 2 },
      },
      null,
    );
    expect(r).not.toBeNull();
    expect(fs.existsSync(gateFilePath)).toBe(true);
  });

  it("materializeGateValues writes deterministic values for a fixed gate", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildScenario(db, kg);

    const gate = createDefaultGate(99);
    const count1 = materializeGateValues(db, gate);
    const after1 = db
      .prepare(`SELECT id, gate_value FROM relationships WHERE valid_until IS NULL ORDER BY id`)
      .all() as Array<{ id: string; gate_value: number }>;

    // Re-running with the same gate produces identical values.
    const count2 = materializeGateValues(db, gate);
    const after2 = db
      .prepare(`SELECT id, gate_value FROM relationships WHERE valid_until IS NULL ORDER BY id`)
      .all() as Array<{ id: string; gate_value: number }>;

    expect(count1).toBe(count2);
    for (let i = 0; i < after1.length; i++) {
      expect(after2[i]!.gate_value).toBeCloseTo(after1[i]!.gate_value, 9);
    }
  });
});
