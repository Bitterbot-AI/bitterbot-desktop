import { describe, expect, it } from "vitest";
import {
  TOPOLOGY_FEATURE_BYTES,
  TOPOLOGY_FEATURE_COUNT,
  computeEdgeFeatures,
  getOrComputeEdgeFeatures,
  packFeatures,
  recomputeFeaturesForRelationships,
  unpackFeatures,
} from "./graph-topology.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
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

describe("graph-topology features", () => {
  it("produces a fixed-size vector with normalized components in [0, 1]", () => {
    const features = computeEdgeFeatures({
      sourceDegree: 12,
      targetDegree: 3,
      sourceNeighbors: new Set(["a", "b", "c"]),
      targetNeighbors: new Set(["b", "c", "d"]),
      sourceMentions: 5,
      targetMentions: 2,
      ageDays: 7,
    });
    expect(features).toHaveLength(TOPOLOGY_FEATURE_COUNT);
    for (const f of features) {
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("jaccard component captures neighbor overlap", () => {
    const same = computeEdgeFeatures({
      sourceDegree: 3,
      targetDegree: 3,
      sourceNeighbors: new Set(["x", "y", "z"]),
      targetNeighbors: new Set(["x", "y", "z"]),
      sourceMentions: 1,
      targetMentions: 1,
      ageDays: 0,
    });
    const disjoint = computeEdgeFeatures({
      sourceDegree: 3,
      targetDegree: 3,
      sourceNeighbors: new Set(["x", "y", "z"]),
      targetNeighbors: new Set(["a", "b", "c"]),
      sourceMentions: 1,
      targetMentions: 1,
      ageDays: 0,
    });
    expect(same[3]).toBeCloseTo(1, 5);
    expect(disjoint[3]).toBeCloseTo(0, 5);
  });

  it("packs and unpacks losslessly", () => {
    const original = computeEdgeFeatures({
      sourceDegree: 7,
      targetDegree: 2,
      sourceNeighbors: new Set(["a", "b"]),
      targetNeighbors: new Set(["b"]),
      sourceMentions: 3,
      targetMentions: 1,
      ageDays: 15,
    });
    const packed = packFeatures(original);
    expect(packed.byteLength).toBe(TOPOLOGY_FEATURE_BYTES);
    const restored = unpackFeatures(packed);
    expect(restored).not.toBeNull();
    for (let i = 0; i < TOPOLOGY_FEATURE_COUNT; i++) {
      expect(restored![i]).toBeCloseTo(original[i], 6);
    }
  });

  it("unpackFeatures returns null for wrong-size BLOBs", () => {
    expect(unpackFeatures(null)).toBeNull();
    expect(unpackFeatures(new Uint8Array(0))).toBeNull();
    expect(unpackFeatures(new Uint8Array(8))).toBeNull();
  });

  it("recomputeFeaturesForRelationships persists BLOBs for all active edges", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    kg.upsertEntity({ name: "Alice", type: "person" });
    kg.upsertEntity({ name: "Bob", type: "person" });
    kg.upsertEntity({ name: "Project-X", type: "project" });
    kg.upsertRelationship(
      {
        sourceName: "Alice",
        sourceType: "person",
        targetName: "Project-X",
        targetType: "project",
        relationType: "works_on",
        weight: 0.8,
      },
      ["chunk-1"],
    );
    kg.upsertRelationship(
      {
        sourceName: "Bob",
        sourceType: "person",
        targetName: "Project-X",
        targetType: "project",
        relationType: "manages",
        weight: 0.9,
      },
      ["chunk-2"],
    );

    const updated = recomputeFeaturesForRelationships(db, null);
    expect(updated).toBe(2);

    const rows = db
      .prepare(`SELECT id, gate_features FROM relationships WHERE valid_until IS NULL`)
      .all() as Array<{ id: string; gate_features: Uint8Array | null }>;
    for (const r of rows) {
      expect(r.gate_features).not.toBeNull();
      const feats = unpackFeatures(r.gate_features);
      expect(feats).not.toBeNull();
      expect(feats!.length).toBe(TOPOLOGY_FEATURE_COUNT);
    }
  });

  it("getOrComputeEdgeFeatures lazily computes when no cache exists", () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    kg.upsertEntity({ name: "Carol", type: "person" });
    kg.upsertEntity({ name: "DocX", type: "file" });
    const rel = kg.upsertRelationship(
      {
        sourceName: "Carol",
        sourceType: "person",
        targetName: "DocX",
        targetType: "file",
        relationType: "created_by",
        weight: 0.7,
      },
      ["chunk-z"],
    );
    // Don't persist features first — exercise the lazy path.
    const feats = getOrComputeEdgeFeatures(db, rel.id);
    expect(feats).not.toBeNull();
    expect(feats!.length).toBe(TOPOLOGY_FEATURE_COUNT);
  });
});
