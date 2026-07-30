import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { computeCanvasCards, computeCanvasState } from "./canvas.js";

// §3.2.9 made the canvas LWW tie-break load-bearing: delete/put races must
// resolve identically on every node, so ties break on the content-derived
// event_hash, NEVER the node-local event_id. These tests fold raw rows (the
// fold's actual input surface) so event ids, hashes, and insertion order can
// be controlled per simulated node.

const CIRCLE = "circle-1";
const NOW = 1_800_000_000_000;

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

type Row = {
  eventId: string;
  author: string;
  type: "canvas.card.put" | "canvas.card.remove" | "canvas.slice.put";
  body: Record<string, unknown>;
  hash: string;
};

function insert(db: DatabaseSync, row: Row): void {
  db.prepare(
    `INSERT INTO circle_events
       (event_id, circle_id, author_pubkey, seq, event_type, body_json,
        envelope_json, event_hash, claimed_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    row.eventId,
    CIRCLE,
    row.author,
    // seq only needs (circle, author) uniqueness for these fold tests.
    Number(row.eventId.replace(/\D/g, "") || 0),
    row.type,
    JSON.stringify(row.body),
    row.hash,
    NOW,
    NOW,
  );
}

describe("canvas LWW tie-break (event_hash, never event_id)", () => {
  const putA: Row = {
    eventId: "evt-1",
    author: "ana",
    type: "canvas.card.put",
    body: { card_id: "c1", card_type: "note", title: "Ana's title", text: "", updated_at: NOW },
    hash: "aaaa",
  };
  const putB: Row = {
    eventId: "evt-2",
    author: "bob",
    type: "canvas.card.put",
    body: { card_id: "c1", card_type: "note", title: "Bob's title", text: "", updated_at: NOW },
    hash: "bbbb",
  };

  it("same event set converges regardless of insertion order and local ids", () => {
    // Node 1 receives Ana first; node 2 receives Bob first AND assigns the
    // opposite local event ids. An event_id tiebreak would disagree here.
    const node1 = openDb();
    insert(node1, putA);
    insert(node1, putB);
    const node2 = openDb();
    insert(node2, { ...putB, eventId: "evt-1" });
    insert(node2, { ...putA, eventId: "evt-2" });

    const card1 = computeCanvasCards(node1, CIRCLE);
    const card2 = computeCanvasCards(node2, CIRCLE);
    expect(card1).toHaveLength(1);
    expect(card1[0]?.title).toBe("Bob's title"); // "bbbb" > "aaaa"
    expect(card2[0]?.title).toBe("Bob's title");
  });

  it("slice ties also break on event_hash", () => {
    const db = openDb();
    const slice = (hash: string, value: string, eventId: string): Row => ({
      eventId,
      author: "ana",
      type: "canvas.slice.put",
      body: { card_id: "c1", slot: "vote", value, updated_at: NOW },
      hash,
    });
    insert(db, putA);
    // Higher event_id, lower hash — hash must win.
    insert(db, slice("2222", "loser", "evt-9"));
    insert(db, slice("9999", "winner", "evt-3"));
    const cards = computeCanvasCards(db, CIRCLE);
    expect(cards[0]?.slices).toHaveLength(1);
    expect(cards[0]?.slices[0]?.value).toBe("winner");
  });
});

describe("delete and clear surface (§3.2.9)", () => {
  const put = (cardId: string, title: string, at: number, hash: string, eventId: string): Row => ({
    eventId,
    author: "ana",
    type: "canvas.card.put",
    body: { card_id: cardId, card_type: "note", title, text: "body text", updated_at: at },
    hash,
  });
  const remove = (
    cardId: string,
    at: number,
    hash: string,
    eventId: string,
    author = "bob",
  ): Row => ({
    eventId,
    author,
    type: "canvas.card.remove",
    body: { card_id: cardId, updated_at: at },
    hash,
  });

  it("a tombstoned card leaves the board and becomes a legible removal", () => {
    const db = openDb();
    insert(db, put("c1", "Venue", NOW, "aaaa", "evt-1"));
    insert(db, remove("c1", NOW + 1000, "cccc", "evt-2"));

    const state = computeCanvasState(db, CIRCLE);
    expect(state.cards).toHaveLength(0);
    expect(state.removed).toHaveLength(1);
    expect(state.removed[0]).toMatchObject({
      cardId: "c1",
      title: "Venue",
      text: "body text",
      removedBy: "bob",
      removedAt: NOW + 1000,
    });
  });

  it("a later put resurrects the card — undo exists by construction", () => {
    const db = openDb();
    insert(db, put("c1", "Venue", NOW, "aaaa", "evt-1"));
    insert(db, remove("c1", NOW + 1000, "cccc", "evt-2"));
    insert(db, put("c1", "Venue", NOW + 2000, "dddd", "evt-3"));

    const state = computeCanvasState(db, CIRCLE);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]?.title).toBe("Venue");
    expect(state.removed).toHaveLength(0);
  });

  it("a remove for a card that never had a put is silent (nothing to narrate)", () => {
    const db = openDb();
    insert(db, remove("ghost", NOW, "aaaa", "evt-1"));
    const state = computeCanvasState(db, CIRCLE);
    expect(state.cards).toHaveLength(0);
    expect(state.removed).toHaveLength(0);
  });

  it("removals are newest-first and capped", () => {
    const db = openDb();
    for (let i = 0; i < 25; i++) {
      insert(
        db,
        put(`c${i}`, `Card ${i}`, NOW + i, `put-${String(i).padStart(2, "0")}`, `evt-p${i}`),
      );
      insert(db, remove(`c${i}`, NOW + 100 + i, `rm-${String(i).padStart(2, "0")}`, `evt-r${i}`));
    }
    const state = computeCanvasState(db, CIRCLE);
    expect(state.removed).toHaveLength(20);
    expect(state.removed[0]?.title).toBe("Card 24"); // newest removal first
    expect(state.removed.at(-1)?.title).toBe("Card 5"); // oldest five aged out
  });

  it("a clear tombstone (superseded_by) never enters the removal strip", () => {
    const db = openDb();
    insert(db, put("c1", "Venue", NOW, "aaaa", "evt-1"));
    // Clear = remove marked superseded_by the replacement + a fresh-id re-put.
    insert(db, {
      eventId: "evt-2",
      author: "ana",
      type: "canvas.card.remove",
      body: { card_id: "c1", updated_at: NOW + 1000, superseded_by: "c2" },
      hash: "cccc",
    });
    insert(db, put("c2", "Venue", NOW + 1001, "dddd", "evt-3"));

    const state = computeCanvasState(db, CIRCLE);
    // The replacement is live; the cleared original is NOT offered as an Undo
    // (offering it would resurrect the old card beside its replacement).
    expect(state.cards.map((c) => c.cardId)).toEqual(["c2"]);
    expect(state.removed).toHaveLength(0);
  });

  it("removed[] cap membership is deterministic across nodes on removedAt ties", () => {
    // 21 tombstones, ALL tied on removedAt — only a content tiebreak (cardId)
    // keeps the cap-20 SET identical when nodes received events in different
    // orders. Build two nodes with opposite insertion order.
    const rows: Row[] = [];
    for (let i = 0; i < 21; i++) {
      const id = `card${String(i).padStart(2, "0")}`;
      rows.push(put(id, `Card ${i}`, NOW, `p${i}`, `evtp${i}`));
      rows.push(remove(id, NOW + 1000, `r${i}`, `evtr${i}`)); // identical removedAt
    }
    const node1 = openDb();
    for (const r of rows) insert(node1, r);
    const node2 = openDb();
    for (const r of rows.toReversed()) insert(node2, r);

    const s1 = computeCanvasState(node1, CIRCLE).removed.map((r) => r.cardId);
    const s2 = computeCanvasState(node2, CIRCLE).removed.map((r) => r.cardId);
    expect(s1).toHaveLength(20);
    expect(s1).toEqual(s2); // same SET and same order, from the same event set
  });
});
