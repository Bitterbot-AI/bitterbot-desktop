/**
 * PLAN-36 Phase C: the group canvas — collective agent (and human) output as a
 * board of typed CARDS, materialized from the circle's chained event log.
 *
 * Per the transport research, the existing hash-chained "tab" is ~90% of a CRDT,
 * so a card is modeled as an OR-Set entry with last-writer-wins fields:
 *   - `canvas.card.put`    — create/update a card (by card_id)
 *   - `canvas.card.remove` — tombstone a card
 * Every mutation is one signed, chained `event` envelope (tab.ts), so it
 * replicates + syncs over direct-dial / mailbox / gossip for free and converges
 * on every member's node — no CRDT library, no round-trips.
 *
 * The fold here is the deterministic reducer: for each card_id, the event with
 * the greatest (updated_at, event_hash) wins — a total order every node agrees
 * on from the same event set. The tiebreak is the content-derived event_hash,
 * NEVER the node-local event_id: two nodes assign different event_ids to the
 * same received event, so an id tiebreak would let a delete/put race resolve
 * differently per node (§3.2.9 made this load-bearing). A losing concurrent
 * edit is silently dropped (the documented LWW caveat); C2+ can move to
 * per-field registers if needed.
 *
 * NOTE (hostile principal): title/text are peer content. The event.append scan
 * rejects critical-severity injection on receipt, and the renderer shows card
 * text as escaped text (never HTML). Richer editable bodies in later card types
 * must keep that boundary.
 */

import type { DatabaseSync } from "node:sqlite";

/** A per-member contribution to one slot of a card (e.g. a vote). */
export type CanvasSlice = {
  slot: string;
  value: string;
  note: string;
  authorPubkey: string;
  updatedAt: number;
};

export type CanvasCard = {
  cardId: string;
  cardType: string;
  title: string;
  text: string;
  authorPubkey: string;
  updatedAt: number;
  /** Folded per-member slices for this card (one per (slot, author), LWW). */
  slices: CanvasSlice[];
};

/** A tombstoned card, exposed so removal is legible (narration + Undo). */
export type RemovedCanvasCard = {
  cardId: string;
  /** From the last winning put — what "Undo" would restore. */
  cardType: string;
  title: string;
  text: string;
  removedBy: string;
  removedAt: number;
};

export type CanvasState = {
  cards: CanvasCard[];
  /** Most recent tombstones first, capped — enough for narration, not a history UI. */
  removed: RemovedCanvasCard[];
};

const REMOVED_CARDS_CAP = 20;

type EventRow = {
  event_id: string;
  author_pubkey: string;
  event_type: string;
  body_json: string;
  event_hash: string;
};

/**
 * Does `a` win the last-writer-wins race against `b`? Tiebreak is the
 * content-derived event_hash (identical on every node), NEVER the node-local
 * event_id — same rule as the sandbox fold (sandbox.ts).
 */
function wins(aUpdated: number, aHash: string, bUpdated: number, bHash: string): boolean {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated;
  return aHash > bHash;
}

/** The canvas's current cards (with folded per-member slices) from the log. */
export function computeCanvasCards(db: DatabaseSync, circleId: string): CanvasCard[] {
  return computeCanvasState(db, circleId).cards;
}

/** Full canvas fold: live cards plus legible tombstones (§3.2.9). */
export function computeCanvasState(db: DatabaseSync, circleId: string): CanvasState {
  const rows = db
    .prepare(
      `SELECT event_id, author_pubkey, event_type, body_json, event_hash
         FROM circle_events
        WHERE circle_id = ?
          AND event_type IN ('canvas.card.put', 'canvas.card.remove', 'canvas.slice.put')`,
    )
    .all(circleId) as unknown as EventRow[];

  type Winner = { row: EventRow; updatedAt: number };
  const cardWinners = new Map<string, Winner>(); // LWW per card_id (put AND remove)
  const putWinners = new Map<string, Winner>(); // LWW per card_id among puts only
  const sliceWinners = new Map<string, Winner>(); // LWW per (card_id, slot, author)

  for (const row of rows) {
    let body: { card_id?: string; slot?: string; updated_at?: number };
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      continue;
    }
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    if (!cardId) continue;
    const updatedAt = typeof body.updated_at === "number" ? body.updated_at : 0;

    if (row.event_type === "canvas.slice.put") {
      const slot = typeof body.slot === "string" ? body.slot : "";
      if (!slot) continue;
      const key = `${cardId}\n${slot}\n${row.author_pubkey}`;
      const cur = sliceWinners.get(key);
      if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
        sliceWinners.set(key, { row, updatedAt });
      }
    } else {
      const cur = cardWinners.get(cardId);
      if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
        cardWinners.set(cardId, { row, updatedAt });
      }
      if (row.event_type === "canvas.card.put") {
        const curPut = putWinners.get(cardId);
        if (!curPut || wins(updatedAt, row.event_hash, curPut.updatedAt, curPut.row.event_hash)) {
          putWinners.set(cardId, { row, updatedAt });
        }
      }
    }
  }

  const slicesByCard = new Map<string, CanvasSlice[]>();
  for (const w of sliceWinners.values()) {
    let body: { card_id?: string; slot?: string; value?: string; note?: string };
    try {
      body = JSON.parse(w.row.body_json) as typeof body;
    } catch {
      continue;
    }
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    if (!cardId) continue;
    const list = slicesByCard.get(cardId) ?? [];
    // Fold-side re-caps: sender normalization (tab.ts) is NOT trusted — a
    // hostile peer signs raw bodies (same rule as annotations.ts).
    list.push({
      slot: typeof body.slot === "string" ? body.slot.slice(0, 32) : "",
      value: typeof body.value === "string" ? body.value.slice(0, 2000) : "",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
      authorPubkey: w.row.author_pubkey,
      updatedAt: w.updatedAt,
    });
    slicesByCard.set(cardId, list);
  }

  const cards: CanvasCard[] = [];
  const removed: RemovedCanvasCard[] = [];
  for (const [cardId, w] of cardWinners) {
    if (w.row.event_type === "canvas.card.remove") {
      // Tombstoned. Surface it (narration + Undo) with the last put's body —
      // a card that never had a winning put has nothing to narrate or restore.
      const put = putWinners.get(cardId);
      if (!put) continue;
      let removeBody: { superseded_by?: string };
      try {
        removeBody = JSON.parse(w.row.body_json) as typeof removeBody;
      } catch {
        removeBody = {};
      }
      // A CLEAR is a tombstone + immediate re-put under a fresh id; its remove
      // carries superseded_by. It is not a deletion, so it never enters the
      // removal strip — offering Undo on it would resurrect the old card
      // beside its replacement (§3.2.9 duplicate). Only true deletes narrate.
      if (typeof removeBody.superseded_by === "string" && removeBody.superseded_by) continue;
      let putBody: { card_type?: string; title?: string; text?: string };
      try {
        putBody = JSON.parse(put.row.body_json) as typeof putBody;
      } catch {
        continue;
      }
      removed.push({
        cardId,
        cardType: typeof putBody.card_type === "string" ? putBody.card_type.slice(0, 32) : "note",
        title: typeof putBody.title === "string" ? putBody.title.slice(0, 200) : "",
        text: typeof putBody.text === "string" ? putBody.text.slice(0, 4000) : "",
        removedBy: w.row.author_pubkey,
        removedAt: w.updatedAt,
      });
      continue;
    }
    let body: { card_type?: string; title?: string; text?: string };
    try {
      body = JSON.parse(w.row.body_json) as typeof body;
    } catch {
      continue;
    }
    cards.push({
      cardId,
      // Fold-side re-caps mirror the sender-side caps in tab.ts — a hostile
      // peer's signed 900KB body must not reach the renderer.
      cardType: typeof body.card_type === "string" ? body.card_type.slice(0, 32) : "note",
      title: typeof body.title === "string" ? body.title.slice(0, 200) : "",
      text: typeof body.text === "string" ? body.text.slice(0, 4000) : "",
      authorPubkey: w.row.author_pubkey,
      updatedAt: w.updatedAt,
      slices: (slicesByCard.get(cardId) ?? []).toSorted((a, b) => a.updatedAt - b.updatedAt),
    });
  }
  // Deterministic ordering AND cap membership across nodes: updatedAt/removedAt
  // are peer-supplied and tie-able (forced, or same-ms bulk), so a bare
  // timestamp sort would resolve ties by node-local Map insertion order (the
  // un-ORDER-BY'd scan order) — diverging the cap-20 tombstone SET between
  // members. cardId is content-derived and unique, so it is the stable
  // cross-node tiebreak (same rule the per-card LWW uses on event_hash).
  cards.sort((a, b) => b.updatedAt - a.updatedAt || (a.cardId < b.cardId ? -1 : 1));
  removed.sort((a, b) => b.removedAt - a.removedAt || (a.cardId < b.cardId ? -1 : 1));
  return { cards, removed: removed.slice(0, REMOVED_CARDS_CAP) };
}

/**
 * The greatest updated_at any put/remove event has claimed for this card slot,
 * or 0 if none. A write that must WIN the slot (delete, clear's tombstone, an
 * undo re-put) stamps at max(now, thisStamp + 1) so an honest actor can always
 * out-order a peer's future-dated event — §3.2.9's "cards can die" contract
 * cannot be defeated by a forged (or clock-skewed) timestamp. This is a
 * write-side clamp; the fold itself stays a pure function of claimed stamps.
 */
export function maxCardStamp(db: DatabaseSync, circleId: string, cardId: string): number {
  const rows = db
    .prepare(
      `SELECT body_json FROM circle_events
        WHERE circle_id = ?
          AND event_type IN ('canvas.card.put', 'canvas.card.remove')`,
    )
    .all(circleId) as unknown as { body_json: string }[];
  let max = 0;
  for (const r of rows) {
    try {
      const b = JSON.parse(r.body_json) as { card_id?: string; updated_at?: number };
      if (b.card_id === cardId && typeof b.updated_at === "number" && b.updated_at > max) {
        max = b.updated_at;
      }
    } catch {
      // skip unparseable
    }
  }
  return max;
}
