import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeGraphManager } from "../knowledge-graph.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runRelationshipMining } from "./relationship-mining.js";

let db: DatabaseSync;
let kg: KnowledgeGraphManager;

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return d;
}

function seedFact(id: string, text: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, lifecycle, semantic_type, created_at, updated_at)
     VALUES (?, 'mem', 'sessions', 0, 0, ?, ?, 'm', '[]', 0.6, 'activated', 'fact', ?, ?)`,
  ).run(id, text, `h_${id}`, now, now);
}

beforeEach(() => {
  db = freshDb();
  kg = new KnowledgeGraphManager(db);
});
afterEach(() => {
  db.close();
});

describe("runRelationshipMining (PLAN-28 A2)", () => {
  it("skips entirely when cortisol is high (don't restructure under stress)", async () => {
    seedFact("c1", "Victor works on Bitterbot");
    let called = false;
    const res = await runRelationshipMining({
      db,
      kg,
      llmCall: async () => {
        called = true;
        return "{}";
      },
      hormones: { cortisol: 0.9 },
      maxChunks: 10,
    });
    expect(res.skippedCortisol).toBe(true);
    expect(called).toBe(false);
    expect(kg.getStats().relationshipCount).toBe(0);
  });

  it("mines typed triples and ingests them into the graph", async () => {
    seedFact("c1", "Victor works on Bitterbot");
    const llmCall = async () =>
      JSON.stringify({
        triples: [
          {
            i: 1,
            source: "Victor",
            sourceType: "person",
            target: "Bitterbot",
            targetType: "project",
            relation: "works_on",
          },
        ],
      });
    const res = await runRelationshipMining({
      db,
      kg,
      llmCall,
      hormones: { cortisol: 0.2 },
      maxChunks: 10,
    });
    expect(res.triplesIngested).toBe(1);
    expect(res.llmCalls).toBe(1);
    expect(kg.getStats().relationshipCount).toBe(1);
  });

  it("advances the cursor so a second run drains only new chunks", async () => {
    seedFact("c1", "Victor works on Bitterbot");
    const llmCall = async () =>
      JSON.stringify({
        triples: [
          {
            i: 1,
            source: "Victor",
            sourceType: "person",
            target: "Bitterbot",
            targetType: "project",
            relation: "works_on",
          },
        ],
      });
    await runRelationshipMining({ db, kg, llmCall, hormones: null, maxChunks: 10 });
    const cursor1 = db
      .prepare(`SELECT value FROM meta WHERE key = 'relationship_mining_cursor'`)
      .get() as { value: string } | undefined;
    expect(cursor1?.value).toBeDefined();
    // Second run: nothing new past the cursor -> no work, no LLM call.
    let secondCalled = false;
    const res2 = await runRelationshipMining({
      db,
      kg,
      llmCall: async () => {
        secondCalled = true;
        return "{}";
      },
      hormones: null,
      maxChunks: 10,
    });
    expect(res2.chunksProcessed).toBe(0);
    expect(secondCalled).toBe(false);
  });

  it("clamps a cursor stranded past pruned rowids so new chunks mine again", async () => {
    // The forgetting engine can delete high-rowid chunks, leaving the stored
    // cursor pointing past every surviving row — the live node sat at 48686
    // vs max rowid 28096 and the mode was silently dead. A stranded cursor
    // must clamp to the current ceiling and process newly-inserted chunks.
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('relationship_mining_cursor', '48686')`,
    ).run();
    seedFact("c1", "Victor works on Bitterbot");
    const llmCall = async () =>
      JSON.stringify({
        triples: [
          {
            i: 1,
            source: "Victor",
            sourceType: "person",
            target: "Bitterbot",
            targetType: "project",
            relation: "works_on",
          },
        ],
      });
    // First run after stranding: clamps to ceiling. The seeded fact's rowid IS
    // the ceiling, so it stays behind the cursor (backlog belongs to the A3
    // backfill); the run must not throw and must persist the clamped cursor.
    await runRelationshipMining({ db, kg, llmCall, hormones: null, maxChunks: 10 });
    const clamped = db
      .prepare(`SELECT value FROM meta WHERE key = 'relationship_mining_cursor'`)
      .get() as { value: string };
    expect(Number(clamped.value)).toBeLessThanOrEqual(1);
    // A chunk inserted AFTER the clamp is eligible on the next run.
    seedFact("c2", "Sylvia collaborates with Victor");
    const res = await runRelationshipMining({ db, kg, llmCall, hormones: null, maxChunks: 10 });
    expect(res.chunksProcessed).toBeGreaterThan(0);
    expect(kg.getStats().relationshipCount).toBeGreaterThan(0);
  });

  it("tolerates malformed LLM JSON without throwing or ingesting", async () => {
    seedFact("c1", "Victor works on Bitterbot");
    const res = await runRelationshipMining({
      db,
      kg,
      llmCall: async () => "not json at all <oops>",
      hormones: null,
      maxChunks: 10,
    });
    expect(res.triplesIngested).toBe(0);
    expect(res.chunksProcessed).toBe(1);
    expect(kg.getStats().relationshipCount).toBe(0);
    // Cursor still advances so the bad chunk isn't re-scanned forever.
    const cursor = db
      .prepare(`SELECT value FROM meta WHERE key = 'relationship_mining_cursor'`)
      .get();
    expect(cursor).toBeDefined();
  });

  it("rejects triples with out-of-vocabulary relation or entity types", async () => {
    seedFact("c1", "Victor is friends with Bob");
    const res = await runRelationshipMining({
      db,
      kg,
      llmCall: async () =>
        JSON.stringify({
          triples: [
            {
              i: 1,
              source: "Victor",
              sourceType: "alien",
              target: "Bob",
              targetType: "person",
              relation: "befriends",
            },
          ],
        }),
      hormones: null,
      maxChunks: 10,
    });
    expect(res.triplesIngested).toBe(0);
    expect(kg.getStats().relationshipCount).toBe(0);
  });
});
