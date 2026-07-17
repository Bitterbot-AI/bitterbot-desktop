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

export type CanvasCard = {
  cardId: string;
  cardType: string;
  title: string;
  text: string;
  authorPubkey: string;
  updatedAt: number;
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

/** The canvas's current cards, folded from the circle's canvas.* events. */
export function computeCanvasCards(db: DatabaseSync, circleId: string): CanvasCard[] {
  const rows = db
    .prepare(
      `SELECT event_id, author_pubkey, event_type, body_json
         FROM circle_events
        WHERE circle_id = ? AND event_type IN ('canvas.card.put', 'canvas.card.remove')`,
    )
    .all(circleId) as unknown as EventRow[];

  type Winner = { row: EventRow; updatedAt: number };
  const latest = new Map<string, Winner>();

  for (const row of rows) {
    let body: { card_id?: string; updated_at?: number };
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      continue;
    }
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    if (!cardId) continue;
    const updatedAt = typeof body.updated_at === "number" ? body.updated_at : 0;
    const current = latest.get(cardId);
    if (!current || wins(updatedAt, row.event_id, current.updatedAt, current.row.event_id)) {
      latest.set(cardId, { row, updatedAt });
    }
  }

  const cards: CanvasCard[] = [];
  for (const [cardId, w] of latest) {
    if (w.row.event_type === "canvas.card.remove") continue; // tombstoned
    let body: { card_type?: string; title?: string; text?: string };
    try {
      body = JSON.parse(w.row.body_json) as typeof body;
    } catch {
      continue;
    }
    cards.push({
      cardId,
      cardType: typeof body.card_type === "string" ? body.card_type : "note",
      title: typeof body.title === "string" ? body.title : "",
      text: typeof body.text === "string" ? body.text : "",
      authorPubkey: w.row.author_pubkey,
      updatedAt: w.updatedAt,
    });
  }
  // Newest first for display.
  cards.sort((a, b) => b.updatedAt - a.updatedAt);
  return cards;
}
