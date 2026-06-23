/**
 * PLAN-27: graph-anchored proactive recall. Verifies that entity/identity turns
 * resolve to current (SABM-valid) family edges structurally — no cosine gate,
 * high confidence — and that the stage is inert on non-entity turns, when no
 * graph is supplied, and for superseded beliefs.
 */
import { describe, expect, it } from "vitest";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { graphAnchoredFacts } from "./proactive-recall-graph.js";
import { formatProactiveFacts } from "./proactive-recall.js";
import { requireNodeSqlite } from "./sqlite.js";

function freshKg(): { kg: KnowledgeGraphManager; db: ReturnType<typeof openDb> } {
  const db = openDb();
  const kg = new KnowledgeGraphManager(db);
  // Donna spouse_of Victor (direction: named person -> owner), the edge the
  // identity extractor/backfill would create from "User's wife is named Donna".
  kg.upsertRelationship({
    sourceName: "Donna",
    sourceType: "person",
    targetName: "Victor",
    targetType: "person",
    relationType: "spouse_of",
    weight: 0.85,
  });
  return { kg, db };
}

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

const base = {
  userName: "Victor",
  maxFacts: 5,
  currentTurn: 1,
  cooldownTurns: 5,
};

describe("graphAnchoredFacts", () => {
  it("answers 'who is Donna' with the structural spouse fact, high confidence", () => {
    const { kg } = freshKg();
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "who is Donna?",
      kg,
      recentlySurfaced: new Map(),
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("Donna — your spouse");
    expect(facts[0].confidence).toBeGreaterThanOrEqual(0.8); // never rendered "(uncertain)"
    expect(formatProactiveFacts(facts)).not.toContain("(uncertain)");
  });

  it("answers the relational phrasing 'who is my wife' via the user entity", () => {
    const { kg } = freshKg();
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "who is my wife",
      kg,
      recentlySurfaced: new Map(),
    });
    expect(facts.map((f) => f.text)).toContain("Donna — your spouse");
  });

  it("does NOT surface a superseded (closed) edge", () => {
    const { kg, db } = freshKg();
    // Simulate SABM closing the belief: set valid_until on the edge.
    db.prepare(`UPDATE relationships SET valid_until = ? WHERE relation_type = 'spouse_of'`).run(
      Date.now(),
    );
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "who is Donna?",
      kg,
      recentlySurfaced: new Map(),
    });
    expect(facts).toHaveLength(0);
  });

  it("is inert on non-entity turns (no graph traversal)", () => {
    const { kg } = freshKg();
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "how is the deploy looking today?",
      kg,
      recentlySurfaced: new Map(),
    });
    expect(facts).toHaveLength(0);
  });

  it("returns nothing when no graph is supplied", () => {
    const facts = graphAnchoredFacts({
      ...base,
      userMessage: "who is Donna?",
      kg: null,
      recentlySurfaced: new Map(),
    });
    expect(facts).toHaveLength(0);
  });

  it("respects the cooldown window", () => {
    const { kg } = freshKg();
    const surfaced = new Map<string, number>();
    const first = graphAnchoredFacts({
      ...base,
      userMessage: "who is Donna?",
      kg,
      recentlySurfaced: surfaced,
      currentTurn: 1,
    });
    expect(first).toHaveLength(1);
    const second = graphAnchoredFacts({
      ...base,
      userMessage: "who is Donna?",
      kg,
      recentlySurfaced: surfaced,
      currentTurn: 2, // inside cooldownTurns (5)
    });
    expect(second).toHaveLength(0);
  });
});
