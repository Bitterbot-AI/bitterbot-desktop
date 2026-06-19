/**
 * scorePendingChunks runs a KNN per chunk (seconds of work for a full batch),
 * so it is async, capped at a batch limit, and yields to the event loop while
 * scoring — otherwise it freezes the gateway and bounces the Control UI's WS
 * connection. This verifies it scores, respects the cap, and yields. The
 * per-chunk GCCRF compute is stubbed (it is exercised elsewhere) so the test
 * measures the loop/yield/throttle behaviour, not reward math.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CuriosityEngine } from "./curiosity-engine.js";
import { GCCRFRewardFunction, type GCCRFRewardResult } from "./gccrf-reward.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

type Db = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];

function openDb(): Db {
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

function insertPending(db: Db, count: number, startAt = 0): void {
  const ins = db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text,
      embedding, updated_at, curiosity_reward, lifecycle_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'active')`,
  );
  for (let i = startAt; i < startAt + count; i += 1) {
    ins.run(
      `c${i}`,
      `p/${i}.md`,
      "memory",
      0,
      0,
      `h${i}`,
      "test",
      `text ${i}`,
      "[0.1,0.2,0.3,0.4]",
      1,
    );
  }
}

describe("CuriosityEngine.scorePendingChunks (async + yielding)", () => {
  let db: Db;
  let computeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = openDb();
    // Stub the expensive per-chunk reward compute; we test the loop, not math.
    computeSpy = vi.spyOn(GCCRFRewardFunction.prototype, "compute").mockReturnValue({
      reward: 0.5,
    } as unknown as GCCRFRewardResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("scores pending chunks, sets the reward, and yields to the event loop", async () => {
    insertPending(db, 20);
    const engine = new CuriosityEngine(db, { enabled: true });
    const immediateSpy = vi.spyOn(global, "setImmediate");

    const scored = await engine.scorePendingChunks();

    expect(computeSpy).toHaveBeenCalled(); // stub is active (test stays fast)
    expect(scored).toBe(20);
    const unscored = (
      db.prepare("SELECT count(*) c FROM chunks WHERE curiosity_reward IS NULL").get() as {
        c: number;
      }
    ).c;
    expect(unscored).toBe(0);
    // 20 chunks, yielding every 8 → at least 2 yields.
    expect(immediateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("caps each pass at the batch limit so it never runs unbounded", async () => {
    insertPending(db, 120);
    const engine = new CuriosityEngine(db, { enabled: true });

    const first = await engine.scorePendingChunks();
    expect(first).toBeLessThanOrEqual(50);

    // a second pass picks up more — the backlog drains across cycles.
    const second = await engine.scorePendingChunks();
    expect(second).toBeGreaterThan(0);
  });
});
