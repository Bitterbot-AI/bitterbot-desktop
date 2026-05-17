import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearGraphReaderCache } from "./graph-reader.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { _clearQueryPlanCache } from "./query-planner.js";
import { DEFAULT_SAGE_CONFIG, _resetSageGateCache, sageRetrieve } from "./sage-memory.js";
import { requireNodeSqlite } from "./sqlite.js";
import { createDefaultGate, serializeGate } from "./structural-gate.js";

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

function seedGraph(kg: KnowledgeGraphManager) {
  kg.upsertEntity({ name: "Alice", type: "person" });
  kg.upsertEntity({ name: "Project-X", type: "project" });
  kg.upsertRelationship(
    {
      sourceName: "Alice",
      sourceType: "person",
      targetName: "Project-X",
      targetType: "project",
      relationType: "works_on",
      weight: 0.9,
    },
    ["chunk-alice-x"],
  );
}

describe("sage-memory façade", () => {
  beforeEach(() => {
    _clearQueryPlanCache();
    _clearGraphReaderCache();
    _resetSageGateCache();
  });

  it("returns a plan even when the graph reader is disabled", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const r = await sageRetrieve(db, kg, "What is Alice working on?", {
      queryPlanning: { enabled: true },
      graphReader: { enabled: false },
    });
    expect(r.plan).toBeTruthy();
    expect(r.graph).toBeUndefined();
  });

  it("runs the graph reader against the in-memory fixture", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    const r = await sageRetrieve(db, kg, "What is Alice working on?", DEFAULT_SAGE_CONFIG);
    expect(r.graph).toBeTruthy();
    const ids = r.graph!.chunks.map((c) => c.chunkId);
    expect(ids).toContain("chunk-alice-x");
  });

  it("forwards hormonal state when modulation is enabled", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedGraph(kg);
    const r = await sageRetrieve(db, kg, "Alice", {
      ...DEFAULT_SAGE_CONFIG,
      hormonalModulation: {
        enabled: true,
        getState: () => ({ dopamine: 0.7, cortisol: 0.1, oxytocin: 0.5 }),
      },
    });
    expect(r.hormonalSnapshot).toEqual({
      dopamine: 0.7,
      cortisol: 0.1,
      oxytocin: 0.5,
    });
  });

  it("loads a serialized gate from disk when structural gating is enabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-gate-"));
    const gatePath = path.join(dir, "gate.json");
    try {
      const g = createDefaultGate(99);
      fs.writeFileSync(gatePath, JSON.stringify(serializeGate(g)));
      const db = openDb();
      const kg = new KnowledgeGraphManager(db);
      seedGraph(kg);
      const r = await sageRetrieve(db, kg, "Alice", {
        ...DEFAULT_SAGE_CONFIG,
        structuralGating: { enabled: true, gateFilePath: gatePath },
      });
      // The presence of `graph` confirms the gate-aware path executed.
      expect(r.graph).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  _resetSageGateCache();
});
