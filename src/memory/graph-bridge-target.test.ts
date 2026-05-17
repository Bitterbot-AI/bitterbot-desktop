import { describe, expect, it } from "vitest";
import { ensureCuriositySchema } from "./curiosity-schema.js";
import {
  detectGraphGaps,
  emitGraphBridgeSignal,
  readActiveBridgeTargets,
} from "./graph-bridge-target.js";
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

describe("detectGraphGaps", () => {
  it("emits signals for chunks the agent used but the graph reader missed", () => {
    const sigs = detectGraphGaps({
      query: "where is the auth middleware?",
      usedChunkIds: ["chunk-auth", "chunk-router"],
      graphReaderChunkIds: ["chunk-router"],
      vectorOrKeywordChunkIds: ["chunk-auth", "chunk-router"],
      graphReaderEntityIds: ["entity-router"],
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.missedChunkId).toBe("chunk-auth");
    expect(sigs[0]!.nearestActivatedEntityIds).toEqual(["entity-router"]);
  });

  it("emits no signals when the graph reader matched everything", () => {
    const sigs = detectGraphGaps({
      query: "q",
      usedChunkIds: ["a", "b"],
      graphReaderChunkIds: ["a", "b"],
      vectorOrKeywordChunkIds: ["a", "b"],
      graphReaderEntityIds: [],
    });
    expect(sigs).toEqual([]);
  });

  it("emits no signal for chunks only the graph reader had (no other channel knew it)", () => {
    const sigs = detectGraphGaps({
      query: "q",
      usedChunkIds: ["x"],
      graphReaderChunkIds: [],
      vectorOrKeywordChunkIds: [],
      graphReaderEntityIds: [],
    });
    expect(sigs).toEqual([]);
  });
});

describe("emitGraphBridgeSignal", () => {
  it("persists a graph_bridge curiosity target with metadata", () => {
    const db = openDb();
    const r = emitGraphBridgeSignal(db, {
      query: "What happened in PLAN-15?",
      missedChunkId: "chunk-plan15",
      nearestActivatedEntityIds: ["plan-14-entity"],
      truthEntityIds: ["plan-15-entity"],
    });
    expect(r.reinforced).toBe(false);
    const rows = db
      .prepare(`SELECT type, metadata FROM curiosity_targets WHERE id = ?`)
      .all(r.targetId) as Array<{ type: string; metadata: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("graph_bridge");
    const meta = JSON.parse(rows[0]!.metadata);
    expect(meta.source).toBe("graph_bridge");
    expect(meta.missedChunkId).toBe("chunk-plan15");
    expect(typeof meta.nudge).toBe("string");
    expect(meta.nudge.length).toBeGreaterThan(0);
  });

  it("reinforces an existing target on duplicate signal", () => {
    const db = openDb();
    const sig = {
      query: "same query",
      missedChunkId: "chunk-x",
      nearestActivatedEntityIds: [],
      truthEntityIds: [],
    };
    const first = emitGraphBridgeSignal(db, sig);
    const second = emitGraphBridgeSignal(db, sig);
    expect(second.reinforced).toBe(true);
    expect(second.targetId).toBe(first.targetId);
  });
});

describe("readActiveBridgeTargets", () => {
  it("returns active targets in priority-then-recency order", () => {
    const db = openDb();
    emitGraphBridgeSignal(
      db,
      {
        query: "low",
        missedChunkId: "c-low",
        nearestActivatedEntityIds: [],
        truthEntityIds: [],
      },
      { priority: 0.2 },
    );
    emitGraphBridgeSignal(
      db,
      {
        query: "high",
        missedChunkId: "c-high",
        nearestActivatedEntityIds: [],
        truthEntityIds: [],
      },
      { priority: 0.9 },
    );
    const targets = readActiveBridgeTargets(db);
    expect(targets.length).toBe(2);
    expect(targets[0]!.query).toBe("high");
  });

  it("returns empty array when none active", () => {
    const db = openDb();
    expect(readActiveBridgeTargets(db)).toEqual([]);
  });
});
