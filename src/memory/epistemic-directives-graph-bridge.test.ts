import { describe, expect, it } from "vitest";
import { ensureCuriositySchema } from "./curiosity-schema.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { emitGraphBridgeSignal } from "./graph-bridge-target.js";
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
  ensureCuriositySchema(db);
  return db;
}

describe("EpistemicDirectiveEngine — graph_bridge harvest (PLAN-18 Phase 4)", () => {
  it("converts active graph_bridge curiosity targets into directives", () => {
    const db = openDb();
    emitGraphBridgeSignal(db, {
      query: "What database powers Alice's projects?",
      missedChunkId: "c-postgres",
      nearestActivatedEntityIds: ["entity-alice"],
      truthEntityIds: ["entity-postgres"],
    });

    const engine = new EpistemicDirectiveEngine(db, { maxPerSession: 5, minPriority: 0 });
    const directives = engine.getDirectivesForSession();

    const bridge = directives.find((d) => d.directiveType === "graph_bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.question.length).toBeGreaterThan(0);
    expect(bridge!.context).toContain("Alice");
  });

  it("marks the source curiosity_target resolved after harvest so it isn't re-emitted", () => {
    const db = openDb();
    emitGraphBridgeSignal(db, {
      query: "one-shot",
      missedChunkId: "c-one",
      nearestActivatedEntityIds: [],
      truthEntityIds: [],
    });

    const engine = new EpistemicDirectiveEngine(db, { maxPerSession: 5, minPriority: 0 });
    engine.getDirectivesForSession();

    // The curiosity_target should now be resolved.
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS c FROM curiosity_targets
         WHERE type = 'graph_bridge' AND resolved_at IS NULL`,
      )
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("respects maxPerSession across mixed directive types", () => {
    const db = openDb();
    for (let i = 0; i < 6; i++) {
      emitGraphBridgeSignal(db, {
        query: `query ${i}`,
        missedChunkId: `c-${i}`,
        nearestActivatedEntityIds: [],
        truthEntityIds: [],
      });
    }
    const engine = new EpistemicDirectiveEngine(db, { maxPerSession: 2, minPriority: 0 });
    const directives = engine.getDirectivesForSession();
    expect(directives.length).toBeLessThanOrEqual(2);
  });
});
