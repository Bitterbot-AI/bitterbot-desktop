import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  emptyRecallCounts,
  emptySearchCounts,
  recordRetrievalTrace,
  resolveTraceSampleRate,
  RetrievalObservability,
} from "./retrieval-trace.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Creates meta/files/chunks/... and runs all migrations (incl. v21 retrieval_trace).
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

describe("RetrievalObservability dead-wire detector (PLAN-28 B3)", () => {
  it("fires for a layer that is 0 across a full window while others fire", () => {
    const obs = new RetrievalObservability(50);
    for (let i = 0; i < 50; i++) {
      // vector + keyword fire every retrieval; graph never does.
      obs.record({ vector: 3, keyword: 2, graph: 0 });
    }
    const warnings = obs.checkDeadWires();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.layer).toBe("graph");
    expect(warnings[0]!.searchesSinceContribution).toBeGreaterThanOrEqual(50);
  });

  it("does NOT fire before the window warms up", () => {
    const obs = new RetrievalObservability(50);
    for (let i = 0; i < 10; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("does NOT fire when the system is entirely idle (all layers 0)", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 30; i++) {
      obs.record({ vector: 0, keyword: 0, graph: 0 });
    }
    // No layer fired — can't distinguish "dead wire" from "no traffic".
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("clears the alarm once the layer starts contributing", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.checkDeadWires()).toHaveLength(1);
    // Graph comes alive.
    for (let i = 0; i < 5; i++) {
      obs.record({ vector: 1, graph: 2 });
    }
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("dedupes repeated warnings within a window", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.warnDeadWires()).toHaveLength(1);
    // Immediately checking again must not re-warn for the same dead layer.
    obs.record({ vector: 1, graph: 0 });
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("snapshot exposes counters for the telemetry surface (B4)", () => {
    const obs = new RetrievalObservability(20);
    obs.record({ vector: 1, graph: 0 });
    const snap = obs.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.sinceContribution.vector).toBe(0);
    expect(snap.sinceContribution.graph).toBe(1);
  });
});

describe("recordRetrievalTrace (PLAN-28 B2)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("writes a sampled search trace row at rate 1", () => {
    const counts = {
      ...emptySearchCounts(),
      vectorHits: 4,
      keywordHits: 2,
      graphHits: 1,
      fused: 5,
    };
    recordRetrievalTrace(db, "search", counts, { queryLen: 12, sampleRate: 1 });
    const row = db
      .prepare(
        `SELECT kind, vector_hits, keyword_hits, graph_hits, fused, extra FROM retrieval_trace`,
      )
      .get() as Record<string, unknown>;
    expect(row.kind).toBe("search");
    expect(row.vector_hits).toBe(4);
    expect(row.graph_hits).toBe(1);
    expect(row.fused).toBe(5);
    expect(JSON.parse(row.extra as string).temporalIntent).toBe("timeless");
  });

  it("never writes at rate 0", () => {
    recordRetrievalTrace(db, "search", emptySearchCounts(), { queryLen: 1, sampleRate: 0 });
    const n = db.prepare(`SELECT COUNT(*) AS c FROM retrieval_trace`).get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("maps recall layer counts onto the trace columns", () => {
    const counts = { ...emptyRecallCounts(), graphFacts: 2, vectorFacts: 1, openLoops: 1 };
    recordRetrievalTrace(db, "recall", counts, { queryLen: 8, sampleRate: 1 });
    const row = db
      .prepare(`SELECT kind, vector_hits, graph_hits, fused FROM retrieval_trace`)
      .get() as Record<string, unknown>;
    expect(row.kind).toBe("recall");
    expect(row.vector_hits).toBe(1);
    expect(row.graph_hits).toBe(2);
    expect(row.fused).toBe(4); // 2 + 0 identity + 1 + 1
  });
});

describe("resolveTraceSampleRate", () => {
  const prev = process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
    } else {
      process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = prev;
    }
  });

  it("defaults to an active rate when unset", () => {
    delete process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
    expect(resolveTraceSampleRate()).toBeGreaterThan(0);
  });
  it("honours an explicit 0 (off)", () => {
    process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = "0";
    expect(resolveTraceSampleRate()).toBe(0);
  });
  it("clamps out-of-range values", () => {
    process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = "5";
    expect(resolveTraceSampleRate()).toBe(1);
  });
});
