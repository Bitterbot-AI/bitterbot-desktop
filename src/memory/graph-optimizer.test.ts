import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  insertTrainingPair,
  readTrainingPairs,
  runOptimizationCycle,
} from "./graph-optimizer.js";
import { _clearGraphReaderCache } from "./graph-reader.js";
import { recomputeFeaturesForRelationships } from "./graph-topology.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";
import { createDefaultGate } from "./structural-gate.js";

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

/** Build a small graph with two paths leading to different chunks. */
function buildGraph(kg: KnowledgeGraphManager) {
  kg.upsertEntity({ name: "QueryRoot", type: "concept" });
  kg.upsertEntity({ name: "Bridge", type: "concept" });
  kg.upsertEntity({ name: "RightAnswer", type: "concept" });
  kg.upsertEntity({ name: "DistractorHub", type: "concept" });
  // Hub with many spurious connections to test gate dampening.
  for (let i = 0; i < 5; i++) {
    kg.upsertEntity({ name: `Spam${i}`, type: "concept" });
    kg.upsertRelationship(
      {
        sourceName: "DistractorHub",
        sourceType: "concept",
        targetName: `Spam${i}`,
        targetType: "concept",
        relationType: "related_to",
        weight: 0.9,
      },
      [`chunk-spam-${i}`],
    );
  }
  kg.upsertRelationship(
    {
      sourceName: "QueryRoot",
      sourceType: "concept",
      targetName: "Bridge",
      targetType: "concept",
      relationType: "related_to",
      weight: 0.9,
    },
    ["chunk-bridge"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Bridge",
      sourceType: "concept",
      targetName: "RightAnswer",
      targetType: "concept",
      relationType: "related_to",
      weight: 0.9,
    },
    ["chunk-answer"],
  );
  // Spurious direct link from QueryRoot to a hub.
  kg.upsertRelationship(
    {
      sourceName: "QueryRoot",
      sourceType: "concept",
      targetName: "DistractorHub",
      targetType: "concept",
      relationType: "related_to",
      weight: 0.5,
    },
    ["chunk-hub-misc"],
  );
}

describe("graph-optimizer training-pair store", () => {
  it("inserts and reads training pairs in recency order", () => {
    const db = openDb();
    insertTrainingPair(db, "what is Bitterbot?", "chunk-a");
    insertTrainingPair(db, "who wrote it?", "chunk-b");
    const pairs = readTrainingPairs(db);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.groundTruthChunkId).toBe("chunk-b");
    expect(pairs[1]!.groundTruthChunkId).toBe("chunk-a");
  });
});

describe("graph-optimizer evaluateGate", () => {
  it("returns reward = 0 when no pairs are supplied", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const r = evaluateGate(db, kg, createDefaultGate(), []);
    expect(r.reward).toBe(0);
    expect(r.perPair).toEqual([]);
  });

  it("scores higher when the ground-truth chunk is retrieved", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildGraph(kg);
    recomputeFeaturesForRelationships(db, null);
    const gate = createDefaultGate(5);
    const positive = evaluateGate(db, kg, gate, [
      { id: "p1", query: "QueryRoot RightAnswer", groundTruthChunkId: "chunk-answer" },
    ]);
    const negative = evaluateGate(db, kg, gate, [
      { id: "n1", query: "QueryRoot something else", groundTruthChunkId: "chunk-nonexistent" },
    ]);
    expect(positive.reward).toBeGreaterThan(negative.reward);
  });
});

describe("graph-optimizer cycle", () => {
  it("returns a result whose best reward ≥ baseline reward", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildGraph(kg);
    recomputeFeaturesForRelationships(db, null);
    const baseline = createDefaultGate(13);
    const pairs = [
      { id: "p1", query: "QueryRoot", groundTruthChunkId: "chunk-answer" },
      { id: "p2", query: "QueryRoot Bridge", groundTruthChunkId: "chunk-bridge" },
    ];
    const r = runOptimizationCycle(db, kg, baseline, pairs, {
      population: 6,
      generations: 2,
      seed: 7,
    });
    expect(r.bestReward).toBeGreaterThanOrEqual(r.baselineReward - 1e-6);
    expect(r.evaluations).toBeGreaterThan(1);
    expect(r.trace.length).toBe(2);
  });

  it("respects the high-cortisol skip gate", () => {
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    buildGraph(kg);
    recomputeFeaturesForRelationships(db, null);
    const baseline = createDefaultGate(1);
    const pairs = [{ id: "p", query: "QueryRoot", groundTruthChunkId: "chunk-answer" }];
    const r = runOptimizationCycle(db, kg, baseline, pairs, {
      population: 4,
      generations: 2,
      hormonalState: { dopamine: 0, cortisol: 0.9, oxytocin: 0 },
    });
    expect(r.evaluations).toBe(0);
    expect(r.generations).toBe(0);
    expect(r.bestGate).toBe(baseline);
  });
});
