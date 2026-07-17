import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { markCircleRead, unreadCounts } from "./read-state.js";

// PLAN-36 A2: unread = inbound messages newer than the per-circle read marker;
// opening a circle (markCircleRead) clears it; our own outbound never counts.

let db: DatabaseSync;
let seq = 0;

function openDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: d,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(d);
  return d;
}

function addMessage(circleId: string, direction: "in" | "out", createdAt: number): void {
  seq += 1;
  db.prepare(
    `INSERT INTO circle_messages (message_id, circle_id, author_pubkey, direction, kind, content, created_at)
     VALUES (?, ?, 'ed25519:peer', ?, 'message', 'hi', ?)`,
  ).run(`m${seq}`, circleId, direction, createdAt);
}

beforeEach(() => {
  db = openDb();
  seq = 0;
});

describe("circle read-state", () => {
  it("counts only inbound messages newer than the read marker", () => {
    addMessage("c1", "in", 100);
    addMessage("c1", "in", 200);
    addMessage("c1", "out", 300); // our own send never counts as unread
    addMessage("c2", "in", 150);

    // No marker yet → all inbound is unread.
    expect(unreadCounts(db)).toEqual({ c1: 2, c2: 1 });

    // Read c1 up to ts 200 → its two inbound clear; c2 untouched.
    markCircleRead(db, "c1", 200);
    expect(unreadCounts(db)).toEqual({ c2: 1 });

    // A newer inbound in c1 becomes unread again.
    addMessage("c1", "in", 250);
    expect(unreadCounts(db)).toEqual({ c1: 1, c2: 1 });
  });

  it("markCircleRead never moves the marker backwards", () => {
    addMessage("c1", "in", 500);
    markCircleRead(db, "c1", 500);
    markCircleRead(db, "c1", 100); // stale/older mark must not un-read newer state
    addMessage("c1", "in", 400); // older than the 500 marker → still read
    expect(unreadCounts(db)).toEqual({});
  });
});
