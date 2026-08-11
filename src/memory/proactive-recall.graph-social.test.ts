/**
 * Graph-anchored recall beyond kinship (2026-08-11).
 *
 * The consumer previously accepted ONLY four family relations, which were
 * disjoint from every relation type the live graph contained — so 73 of 73
 * edges were discarded and the graph layer never contributed once in the
 * node's lifetime. These tests pin the widened behaviour: social/work/place
 * relations surface in plain language, first-person questions resolve to the
 * user, and the untyped `related_to` fallback still never surfaces.
 */
import { describe, expect, it } from "vitest";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { graphAnchoredFacts } from "./proactive-recall-graph.js";
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
  runMigrations(db);
  return db;
}

function seededKg(): KnowledgeGraphManager {
  const kg = new KnowledgeGraphManager(openDb());
  kg.upsertRelationship({
    sourceName: "Victor",
    sourceType: "person",
    targetName: "Toronto",
    targetType: "location",
    relationType: "located_at",
    weight: 0.6,
  });
  kg.upsertRelationship({
    sourceName: "Victor",
    sourceType: "person",
    targetName: "Circles",
    targetType: "project",
    relationType: "works_on",
    weight: 0.6,
  });
  kg.upsertRelationship({
    sourceName: "Donna",
    sourceType: "person",
    targetName: "Victor",
    targetType: "person",
    relationType: "spouse_of",
    weight: 0.85,
  });
  return kg;
}

const base = {
  userName: "Victor",
  recentlySurfaced: new Map<string, number>(),
  currentTurn: 10,
  cooldownTurns: 5,
  maxFacts: 5,
};

describe("graph recall: social relations", () => {
  it("surfaces a work relation for a third-party question", () => {
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "What is Circles?",
      kg: seededKg(),
      recentlySurfaced: new Map(),
    });
    // The subject IS the user, so it reads in second person — and must
    // conjugate ("You work on", not "You works on").
    expect(facts.map((f) => f.text)).toContain("You work on Circles");
  });

  it("answers a first-person location question via the user entity", () => {
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "Where do I live these days?",
      kg: seededKg(),
      recentlySurfaced: new Map(),
    });
    expect(facts.map((f) => f.text)).toContain("You are based in Toronto");
  });

  it("still phrases family edges as 'your <relation>'", () => {
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "Who is my wife?",
      kg: seededKg(),
      recentlySurfaced: new Map(),
    });
    expect(facts.map((f) => f.text)).toContain("Donna — your spouse");
  });

  it("stays inert on a non-entity turn", () => {
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "thanks, that works",
      kg: seededKg(),
      recentlySurfaced: new Map(),
    });
    expect(facts).toEqual([]);
  });

  it("never surfaces the untyped related_to fallback", () => {
    const kg = new KnowledgeGraphManager(openDb());
    kg.upsertRelationship({
      sourceName: "Victor",
      sourceType: "person",
      targetName: "Circles",
      targetType: "project",
      relationType: "related_to",
      weight: 0.6,
    });
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "What is Circles?",
      kg,
      recentlySurfaced: new Map(),
    });
    expect(facts).toEqual([]);
  });

  it("respects the per-edge cooldown", () => {
    const kg = seededKg();
    const surfaced = new Map<string, number>();
    const first = graphAnchoredFacts({
      ...base,
      userMessage: "What is Circles?",
      kg,
      recentlySurfaced: surfaced,
    });
    expect(first.length).toBeGreaterThan(0);
    const second = graphAnchoredFacts({
      ...base,
      userMessage: "What is Circles?",
      kg,
      recentlySurfaced: surfaced,
      currentTurn: 11,
    });
    expect(second).toEqual([]);
  });
});
