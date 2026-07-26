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
 * the greatest (updated_at, event_id) wins — a total order every node agrees on
 * from the same event set. A losing concurrent edit is silently dropped (the
 * documented LWW caveat); C2+ can move to per-field registers if needed.
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

type EventRow = {
  event_id: string;
  author_pubkey: string;
  event_type: string;
  body_json: string;
};

/** Does `a` win the last-writer-wins race against `b`? Deterministic tiebreak. */
function wins(aUpdated: number, aEventId: string, bUpdated: number, bEventId: string): boolean {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated;
  return aEventId > bEventId;
}

/** The canvas's current cards (with folded per-member slices) from the log. */
export function computeCanvasCards(db: DatabaseSync, circleId: string): CanvasCard[] {
  const rows = db
    .prepare(
      `SELECT event_id, author_pubkey, event_type, body_json
         FROM circle_events
        WHERE circle_id = ?
          AND event_type IN ('canvas.card.put', 'canvas.card.remove', 'canvas.slice.put')`,
    )
    .all(circleId) as unknown as EventRow[];

  type Winner = { row: EventRow; updatedAt: number };
  const cardWinners = new Map<string, Winner>(); // LWW per card_id
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
      if (!cur || wins(updatedAt, row.event_id, cur.updatedAt, cur.row.event_id)) {
        sliceWinners.set(key, { row, updatedAt });
      }
    } else {
      const cur = cardWinners.get(cardId);
      if (!cur || wins(updatedAt, row.event_id, cur.updatedAt, cur.row.event_id)) {
        cardWinners.set(cardId, { row, updatedAt });
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
  for (const [cardId, w] of cardWinners) {
    if (w.row.event_type === "canvas.card.remove") continue; // tombstoned
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
  cards.sort((a, b) => b.updatedAt - a.updatedAt); // newest first
  return cards;
}
