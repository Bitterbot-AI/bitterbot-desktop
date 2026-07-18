import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  PENDING_OUTBOUND_TTL_MS,
  claimPendingOutbound,
  listPendingOutbound,
  queuePendingOutbound,
} from "./pending-outbound.js";

// §5.3 completed: the human approval queue. An agent write queues with its
// exact params; only an atomic claim (the human's approve/reject) resolves it,
// and racing resolutions get exactly one winner.

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

describe("pending-outbound approval queue", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
  });

  it("queues with params + preview and lists per circle until resolved", () => {
    const id = queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "movie night?" },
      preview: { circle: "Roomies", text: "movie night?" },
    });
    queuePendingOutbound(db, {
      circleId: "c2",
      action: "ask",
      params: { circleId: "c2", question: "free thu?", category: "general" },
      preview: { circle: "Trip", question: "free thu?" },
    });
    const c1 = listPendingOutbound(db, "c1");
    expect(c1).toHaveLength(1);
    expect(c1[0]?.id).toBe(id);
    expect(c1[0]?.preview.text).toBe("movie night?");
    expect(listPendingOutbound(db, "c2")).toHaveLength(1);
  });

  it("claims atomically: one winner, no approve-after-reject, no double-approve", () => {
    const id = queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "hi" },
      preview: { text: "hi" },
    });
    const approved = claimPendingOutbound(db, id, "approved");
    expect(approved?.params.text).toBe("hi");
    // Replay and cross-resolution both lose.
    expect(claimPendingOutbound(db, id, "approved")).toBeNull();
    expect(claimPendingOutbound(db, id, "rejected")).toBeNull();
    expect(listPendingOutbound(db, "c1")).toHaveLength(0);
  });

  it("expires unapproved writes: not listed, not claimable", () => {
    const t0 = Date.now() - PENDING_OUTBOUND_TTL_MS - 1000;
    const id = queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "stale" },
      preview: { text: "stale" },
      now: t0,
    });
    expect(listPendingOutbound(db, "c1")).toHaveLength(0);
    expect(claimPendingOutbound(db, id, "approved")).toBeNull();
  });

  it("ignores legacy v37 token rows (no params to execute)", () => {
    db.prepare(
      `INSERT INTO circle_pending_outbound (token, action, params_hash, created_at, expires_at)
       VALUES ('legacy', 'send', 'hash', ?, ?)`,
    ).run(Date.now(), Date.now() + 60_000);
    expect(listPendingOutbound(db, "c1")).toHaveLength(0);
    expect(claimPendingOutbound(db, "legacy", "approved")).toBeNull();
  });
});
