import { describe, expect, it } from "vitest";
import { _clearGraphReaderCache, graphRead } from "./graph-reader.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { planQueryHeuristic } from "./query-planner.js";
import { requireNodeSqlite } from "./sqlite.js";

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

/**
 * Build a small fixture graph:
 *
 *   Alice ─works_on→ Project-X ─uses→ Tool-Y
 *                       │
 *                       └─created_by→ DocZ
 *
 * Evidence chunks:
 *   alice→project-x: chunk-alice-project
 *   project-x→tool-y: chunk-toolchain
 *   project-x→docz: chunk-doc
 */
function buildFixture(kg: KnowledgeGraphManager) {
  kg.upsertEntity({ name: "Alice", type: "person" });
  kg.upsertEntity({ name: "Project-X", type: "project" });
  kg.upsertEntity({ name: "Tool-Y", type: "tool" });
  kg.upsertEntity({ name: "DocZ", type: "file" });

  kg.upsertRelationship(
    {
      sourceName: "Alice",
      sourceType: "person",
      targetName: "Project-X",
      targetType: "project",
      relationType: "works_on",
      weight: 0.9,
    },
    ["chunk-alice-project"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Project-X",
      sourceType: "project",
      targetName: "Tool-Y",
      targetType: "tool",
      relationType: "uses",
      weight: 0.8,
    },
    ["chunk-toolchain"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Project-X",
      sourceType: "project",
      targetName: "DocZ",
      targetType: "file",
      relationType: "created_by",
      weight: 0.7,
    },
    ["chunk-doc"],
  );
}

describe("graph-reader propagation", () => {
  it("returns empty result when no entities resolve", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const plan = planQueryHeuristic("UnknownStuff");
    const r = graphRead(db, kg, plan);
    expect(r.chunks).toEqual([]);
    expect(r.seedEntityIds).toEqual([]);
    expect(r.hopsPerformed).toBe(0);
  });

  it("reaches one-hop evidence from a seed entity", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("What does Alice work on?");
    const r = graphRead(db, kg, plan, { hops: 1, cacheTtlMs: 0 });
    expect(r.seedEntityIds.length).toBeGreaterThan(0);
    const ids = r.chunks.map((c) => c.chunkId);
    expect(ids).toContain("chunk-alice-project");
  });

  it("reaches two-hop evidence via Project-X bridge", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("What tools does Alice use?");
    const r = graphRead(db, kg, plan, { hops: 2, cacheTtlMs: 0 });
    const ids = r.chunks.map((c) => c.chunkId);
    expect(ids).toContain("chunk-toolchain");
  });

  it("respects topK", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("Alice Project-X");
    const r = graphRead(db, kg, plan, { hops: 2, topK: 1, cacheTtlMs: 0 });
    expect(r.chunks.length).toBeLessThanOrEqual(1);
  });

  it("uses cached results when called twice with the same plan", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("Alice");
    const first = graphRead(db, kg, plan, { hops: 2 });
    const second = graphRead(db, kg, plan, { hops: 2 });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it("custom gateFn is invoked for each propagated edge", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    let gateCalls = 0;
    const plan = planQueryHeuristic("Alice");
    graphRead(db, kg, plan, {
      hops: 2,
      cacheTtlMs: 0,
      gateFn: () => {
        gateCalls++;
        return 1;
      },
    });
    expect(gateCalls).toBeGreaterThan(0);
  });

  it("hormonalState is forwarded to gateFn", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("Alice");
    const seen: Array<unknown> = [];
    graphRead(db, kg, plan, {
      hops: 1,
      cacheTtlMs: 0,
      hormonalState: { dopamine: 0.8, cortisol: 0.1, oxytocin: 0.2 },
      gateFn: (input) => {
        if (input.hormonalState) {
          seen.push(input.hormonalState);
        }
        return 1;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("activation magnitudes stay finite across hops", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildFixture(kg);
    const plan = planQueryHeuristic("Alice");
    const r = graphRead(db, kg, plan, { hops: 3, cacheTtlMs: 0 });
    for (const e of r.entities) {
      expect(Number.isFinite(e.activation)).toBe(true);
    }
  });
});
