import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  PENDING_OUTBOUND_TTL_MS,
  claimPendingOutbound,
  listPendingOutbound,
  pendingOutboundCounts,
  queuePendingOutbound,
  revertPendingOutbound,
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

  it("counts pending approvals per circle for attention badges (Phase C)", () => {
    queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "a" },
      preview: {},
    });
    queuePendingOutbound(db, {
      circleId: "c1",
      action: "ask",
      params: { circleId: "c1", question: "b", category: "general" },
      preview: {},
    });
    const expiredId = queuePendingOutbound(db, {
      circleId: "c2",
      action: "send",
      params: { circleId: "c2", text: "c" },
      preview: {},
    });
    expect(pendingOutboundCounts(db)).toEqual({ c1: 2, c2: 1 });
    // Resolved and expired rows stop counting — the badge is live pressure.
    claimPendingOutbound(db, expiredId, "rejected");
    expect(pendingOutboundCounts(db)).toEqual({ c1: 2 });
    expect(pendingOutboundCounts(db, Date.now() + PENDING_OUTBOUND_TTL_MS + 1)).toEqual({});
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

  it("caps unresolved cards per circle (approval-fatigue spam, review F2)", () => {
    for (let i = 0; i < 5; i += 1) {
      queuePendingOutbound(db, {
        circleId: "c1",
        action: "send",
        params: { circleId: "c1", text: `spam ${i}` },
        preview: { text: `spam ${i}` },
      });
    }
    expect(() =>
      queuePendingOutbound(db, {
        circleId: "c1",
        action: "send",
        params: { circleId: "c1", text: "one more" },
        preview: { text: "one more" },
      }),
    ).toThrow(/queue is full/);
    // A different circle has its own budget.
    expect(() =>
      queuePendingOutbound(db, {
        circleId: "c2",
        action: "send",
        params: { circleId: "c2", text: "fine" },
        preview: { text: "fine" },
      }),
    ).not.toThrow();
  });

  it("revert hands a claimed-but-unexecuted approval back to the queue (review F3)", () => {
    const id = queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "hi" },
      preview: { text: "hi" },
    });
    expect(claimPendingOutbound(db, id, "approved")).toBeTruthy();
    revertPendingOutbound(db, id);
    expect(listPendingOutbound(db, "c1")).toHaveLength(1); // the card is back
    // A REJECTED card cannot be revived through revert.
    const id2 = queuePendingOutbound(db, {
      circleId: "c1",
      action: "send",
      params: { circleId: "c1", text: "no" },
      preview: { text: "no" },
    });
    claimPendingOutbound(db, id2, "rejected");
    revertPendingOutbound(db, id2);
    expect(listPendingOutbound(db, "c1").some((p) => p.id === id2)).toBe(false);
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
