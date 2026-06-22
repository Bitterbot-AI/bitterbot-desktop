/**
 * The memory engines run on the gateway's single event loop. A long synchronous
 * burst (consolidation's O(n^2) similarity sweeps) used to freeze the loop for
 * tens of seconds, starving the 30s WebSocket keepalive and bouncing the Control
 * UI connection. The engines now `await yieldToEventLoop()` across their hot
 * loops. These tests verify (a) the yield helpers behave, and (b) a large
 * consolidation pass actually hands control back to the loop mid-run.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConsolidationEngine } from "./consolidation.js";
import { makeYieldEvery, yieldToEventLoop } from "./event-loop.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "lifecycle", "TEXT");
  ensureColumn(db, "chunks", "semantic_type", "TEXT");
  return db;
}

// All chunks share a near-identical unit embedding so they cluster into the
// merge/near-merge sweeps and the full O(n^2) loop executes.
function similarEmbedding(dim = 8): number[] {
  const v = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0.01));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function insertChunk(db: DatabaseSync, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, importance_score, access_count, last_accessed_at, semantic_type, lifecycle)
     VALUES (?, 'same.md', 'memory', 0, 1, ?, 'test', ?, ?, ?, 0.9, 50, ?, 'general', 'generated')`,
  ).run(id, "h-" + id, "text " + id, JSON.stringify(similarEmbedding()), now, now);
}

describe("yieldToEventLoop helpers", () => {
  it("yieldToEventLoop resolves on a later event-loop turn", async () => {
    let immediateRan = false;
    setImmediate(() => {
      immediateRan = true;
    });
    // If yield did not actually defer, the setImmediate above could not have run.
    await yieldToEventLoop();
    expect(immediateRan).toBe(true);
  });

  it("makeYieldEvery defers only every Nth call", async () => {
    const tick = makeYieldEvery(3);
    let deferred = 0;
    for (let i = 1; i <= 9; i++) {
      let ran = false;
      setImmediate(() => {
        ran = true;
      });
      await tick();
      if (ran) {
        deferred++;
      }
    }
    // Calls 3, 6, 9 defer (and let the setImmediate fire); the rest are no-ops.
    expect(deferred).toBe(3);
  });
});

describe("consolidation cooperative yielding", () => {
  it("hands control back to the event loop during a large pass", async () => {
    const db = createDb();
    // Well above SIMILARITY_YIELD_EVERY (32) so the discovery sweeps yield many times.
    for (let i = 0; i < 200; i++) {
      insertChunk(db, `c${String(i).padStart(4, "0")}`);
    }

    // Nothing forgets, everything promotes, and the merge threshold is set
    // impossibly high so no chunk is removed — the full O(n^2) sweep runs.
    const engine = new ConsolidationEngine(db, {
      forgetThreshold: 0,
      promoteThreshold: 0,
      mergeOverlapThreshold: 2,
    });

    // A self-rescheduling setImmediate chain can only advance if run() yields.
    let turns = 0;
    let stop = false;
    const tick = (): void => {
      turns++;
      if (!stop) {
        setImmediate(tick);
      }
    };
    setImmediate(tick);

    await engine.run();
    stop = true;

    // A fully synchronous run would have blocked the chain at 0; yielding lets
    // the loop tick repeatedly mid-pass.
    expect(turns).toBeGreaterThan(1);
    db.close();
  });
});
