import { describe, expect, it } from "vitest";
import { KnowledgeGraphManager } from "../knowledge-graph.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { requireNodeSqlite } from "../sqlite.js";
import {
  runRelationshipReconsolidation,
  type AdjudicateFn,
} from "./relationship-reconsolidation.js";

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

/** Create a flagged mutual contradiction: two active located_at edges. */
function seedContradiction(kg: KnowledgeGraphManager) {
  kg.upsertRelationship({
    sourceName: "Server",
    sourceType: "service",
    targetName: "us-east",
    targetType: "location",
    relationType: "located_at",
  });
  return kg.upsertRelationship({
    sourceName: "Server",
    sourceType: "service",
    targetName: "eu-west",
    targetType: "location",
    relationType: "located_at",
  });
}

const calm = { dopamine: 0.5, cortisol: 0.1, oxytocin: 0.3 };

describe("runRelationshipReconsolidation", () => {
  it("closes the loser when confidence clears the floor and labile window is closed", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const flagged = seedContradiction(kg);
    expect(kg.getStats().flaggedContradictions).toBe(1);

    // Adjudicator: the OTHER edge (us-east) wins, so the flagged eu-west loses.
    const winnerId = db
      .prepare(
        `SELECT r.id FROM relationships r JOIN entities e ON e.id = r.target_entity_id
         WHERE e.name = 'us-east' AND r.valid_until IS NULL`,
      )
      .get() as { id: string };
    const adjudicate: AdjudicateFn = async () => ({
      winnerRelationshipId: winnerId.id,
      confidence: 0.95,
    });

    const res = await runRelationshipReconsolidation({
      db,
      kg,
      adjudicate,
      hormones: calm,
      nowMs: Date.now(),
    });
    expect(res.closed).toBe(1);
    const stats = kg.getStats();
    expect(stats.activeRelationships).toBe(1); // winner remains
    expect(stats.closedRelationships).toBe(1); // loser closed
    expect(flagged.id).toBeTruthy();
  });

  it("defers when evidence is still labile (ALL-closed rule)", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    // Insert a chunk (all NOT NULL columns) and mark it labile, then attach it.
    const now = Date.now();
    db.prepare(
      `INSERT INTO chunks (id, path, start_line, end_line, hash, model, text, embedding,
         source, created_at, updated_at, labile_until)
       VALUES (?, '/x', 0, 1, 'h', 'm', ?, '[]', 'sessions', ?, ?, ?)`,
    ).run("chunk-labile", "Server is in eu-west", now, now, now + 1_000_000);
    kg.upsertRelationship({
      sourceName: "Server",
      sourceType: "service",
      targetName: "us-east",
      targetType: "location",
      relationType: "located_at",
    });
    kg.upsertRelationship(
      {
        sourceName: "Server",
        sourceType: "service",
        targetName: "eu-west",
        targetType: "location",
        relationType: "located_at",
      },
      ["chunk-labile"],
    );

    const adjudicate: AdjudicateFn = async () => ({ winnerRelationshipId: "x", confidence: 1 });
    const res = await runRelationshipReconsolidation({
      db,
      kg,
      adjudicate,
      hormones: calm,
      nowMs: now,
    });
    expect(res.deferredLabile).toBe(1);
    expect(res.closed).toBe(0);
    expect(kg.getStats().activeRelationships).toBe(2); // nothing closed
  });

  it("does not close when confidence is below the hormonal floor (high cortisol)", async () => {
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    seedContradiction(kg);
    const winnerId = db
      .prepare(
        `SELECT r.id FROM relationships r JOIN entities e ON e.id = r.target_entity_id
         WHERE e.name = 'us-east' AND r.valid_until IS NULL`,
      )
      .get() as { id: string };
    // Moderate confidence + high cortisol raises the floor above it.
    const adjudicate: AdjudicateFn = async () => ({
      winnerRelationshipId: winnerId.id,
      confidence: 0.62,
    });
    const res = await runRelationshipReconsolidation({
      db,
      kg,
      adjudicate,
      hormones: { dopamine: 0.0, cortisol: 0.9, oxytocin: 0.3 },
      nowMs: Date.now(),
    });
    expect(res.closed).toBe(0);
    expect(kg.getStats().activeRelationships).toBe(2);
  });

  it("is a no-op on a pre-v16 DB (no belief-history table)", async () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embeddings_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    const kg = new KnowledgeGraphManager(db);
    const adjudicate: AdjudicateFn = async () => null;
    const res = await runRelationshipReconsolidation({ db, kg, adjudicate, nowMs: Date.now() });
    expect(res).toEqual({ flaggedSeen: 0, deferredLabile: 0, closed: 0, llmCalls: 0 });
  });
});
