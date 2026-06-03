import { describe, expect, it } from "vitest";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { requireNodeSqlite } from "./sqlite.js";

function openMigratedDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db); // brings the schema to v16 (belief history + last_reinforced_at)
  return db;
}

function openPreV16Db() {
  // Base schema only, no migrations: simulates a DB without the v16 table.
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

describe("SABM write-time adjudication (non-destructive)", () => {
  it("flags a mutually-exclusive conflict without closing either edge", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    // located_at is mutually exclusive: a thing is in one place at a time.
    kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "us-east",
      targetType: "location",
      relationType: "located_at",
    });
    kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "eu-west",
      targetType: "location",
      relationType: "located_at",
    });

    const stats = kg.getStats();
    // Both edges stay active - write time never closes.
    expect(stats.activeRelationships).toBe(2);
    expect(stats.closedRelationships).toBe(0);
    // But the contradiction is recorded for dream-time adjudication.
    expect(stats.flaggedContradictions).toBe(1);
  });

  it("does NOT flag many-to-many relations (e.g. works_on)", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    kg.upsertRelationship({
      sourceName: "Alice",
      sourceType: "person",
      targetName: "ProjectA",
      targetType: "project",
      relationType: "works_on",
    });
    kg.upsertRelationship({
      sourceName: "Alice",
      sourceType: "person",
      targetName: "ProjectB",
      targetType: "project",
      relationType: "works_on",
    });
    const stats = kg.getStats();
    expect(stats.activeRelationships).toBe(2);
    expect(stats.flaggedContradictions).toBe(0);
  });

  it("records a strengthen audit row when an existing edge is reinforced", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    const rel = {
      sourceName: "Alice",
      sourceType: "person" as const,
      targetName: "ProjectA",
      targetType: "project" as const,
      relationType: "works_on" as const,
    };
    kg.upsertRelationship(rel);
    kg.upsertRelationship(rel); // same (src,tgt,type) -> merge/strengthen
    const stats = kg.getStats();
    expect(stats.relationshipCount).toBe(1);
    expect(stats.reinforcements).toBe(1);
  });
});

describe("SABM supersede + belief history", () => {
  it("supersedeRelationship closes the edge and records the audit", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    const created = kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "us-east",
      targetType: "location",
      relationType: "located_at",
    });
    kg.supersedeRelationship(created.id);
    const stats = kg.getStats();
    expect(stats.activeRelationships).toBe(0);
    expect(stats.closedRelationships).toBe(1);
    expect(stats.beliefRevisions).toBe(1); // 'supersede' action counted
  });

  it("beliefHistory surfaces closed edges that traverseEntity hides", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    const rel = kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "us-east",
      targetType: "location",
      relationType: "located_at",
    });
    kg.supersedeRelationship(rel.id);

    const source = rel.sourceEntityId;
    // Active-only traversal sees nothing now.
    const active = kg.traverseEntity(source, true);
    expect(active?.relationships ?? []).toHaveLength(0);
    // Belief history still has the closed edge.
    const history = kg.beliefHistory(source);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some((h) => h.relationship.validUntil != null)).toBe(true);
  });

  it("beliefAsOf returns only edges whose interval contained the timestamp", () => {
    const kg = new KnowledgeGraphManager(openMigratedDb());
    const rel = kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "us-east",
      targetType: "location",
      relationType: "located_at",
    });
    // While still active (valid_until NULL), it is valid at its own valid_from.
    const whileActive = kg.beliefAsOf(rel.sourceEntityId, rel.validFrom ?? Date.now());
    expect(whileActive.length).toBeGreaterThanOrEqual(1);
    kg.supersedeRelationship(rel.id);
    // As of a far-future time, the closed edge is no longer valid.
    const future = kg.beliefAsOf(rel.sourceEntityId, Date.now() + 1_000_000);
    expect(future).toHaveLength(0);
  });
});

describe("SABM telemetry is defensive on a pre-v16 DB", () => {
  it("getStats returns 0 for belief counters without throwing", () => {
    const kg = new KnowledgeGraphManager(openPreV16Db());
    kg.upsertRelationship({
      sourceName: "Alice",
      sourceType: "person",
      targetName: "ProjectA",
      targetType: "project",
      relationType: "works_on",
    });
    const stats = kg.getStats();
    expect(stats.relationshipCount).toBe(1);
    expect(stats.flaggedContradictions).toBe(0);
    expect(stats.reinforcements).toBe(0);
    expect(stats.beliefRevisions).toBe(0);
  });
});
