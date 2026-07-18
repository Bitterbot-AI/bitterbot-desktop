/**
 * PLAN-36 Phase D (deferred from Phase A): message annotations — reactions and
 * pins — folded from the circle's chained event log, exactly like the canvas
 * (same replication, same fork-freeze, same injection scan on receipt).
 *
 *  - `message.react` — the author's FULL emoji set on one message. LWW per
 *    (target_envelope_id, author): toggling re-emits the whole set, so there
 *    are no add/remove tombstone pairs to reconcile. An empty set clears.
 *  - `message.pin` — circle-wide pin flag per message. LWW per target by
 *    (updated_at, event_id); any member may flip it (friends-tier trust, v1).
 *
 * Targets are envelope ids — stable on every node (the dedupe key), the same
 * reference reply-to uses — so annotations resolve locally everywhere.
 */

import type { DatabaseSync } from "node:sqlite";

export type MessageReaction = {
  authorPubkey: string;
  emojis: string[];
  updatedAt: number;
};

export type MessageAnnotations = {
  /** envelope_id -> per-member reaction sets (empties dropped). */
  reactions: Record<string, MessageReaction[]>;
  /** envelope_ids currently pinned, oldest pin first. */
  pins: string[];
};

type EventRow = {
  event_id: string;
  author_pubkey: string;
  event_type: string;
  body_json: string;
};

function wins(aUpdated: number, aEventId: string, bUpdated: number, bEventId: string): boolean {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated;
  return aEventId > bEventId;
}

/** The current annotation state for a circle, from the log. */
export function computeMessageAnnotations(db: DatabaseSync, circleId: string): MessageAnnotations {
  const rows = db
    .prepare(
      `SELECT event_id, author_pubkey, event_type, body_json
         FROM circle_events
        WHERE circle_id = ? AND event_type IN ('message.react', 'message.pin')`,
    )
    .all(circleId) as unknown as EventRow[];

  type ReactWinner = { emojis: string[]; updatedAt: number; eventId: string };
  const reactWinners = new Map<string, ReactWinner>(); // (target \n author) -> set
  type PinWinner = { pinned: boolean; updatedAt: number; eventId: string };
  const pinWinners = new Map<string, PinWinner>(); // target -> flag

  for (const row of rows) {
    let body: {
      target_envelope_id?: string;
      emojis?: unknown;
      pinned?: unknown;
      updated_at?: number;
    };
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      continue;
    }
    const target = typeof body.target_envelope_id === "string" ? body.target_envelope_id : "";
    if (!target) continue;
    const updatedAt = typeof body.updated_at === "number" ? body.updated_at : 0;

    if (row.event_type === "message.react") {
      const key = `${target}\n${row.author_pubkey}`;
      const cur = reactWinners.get(key);
      if (!cur || wins(updatedAt, row.event_id, cur.updatedAt, cur.eventId)) {
        const emojis = Array.isArray(body.emojis)
          ? (body.emojis as unknown[]).filter((e): e is string => typeof e === "string")
          : [];
        reactWinners.set(key, { emojis, updatedAt, eventId: row.event_id });
      }
    } else {
      const cur = pinWinners.get(target);
      if (!cur || wins(updatedAt, row.event_id, cur.updatedAt, cur.eventId)) {
        pinWinners.set(target, {
          pinned: body.pinned === true,
          updatedAt,
          eventId: row.event_id,
        });
      }
    }
  }

  const reactions: Record<string, MessageReaction[]> = {};
  for (const [key, w] of reactWinners) {
    if (w.emojis.length === 0) continue; // cleared
    const [target, author] = key.split("\n") as [string, string];
    (reactions[target] ??= []).push({
      authorPubkey: author,
      emojis: w.emojis,
      updatedAt: w.updatedAt,
    });
  }
  for (const list of Object.values(reactions)) {
    list.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  const pins = [...pinWinners.entries()]
    .filter(([, w]) => w.pinned)
    .toSorted((a, b) => a[1].updatedAt - b[1].updatedAt)
    .map(([target]) => target);

  return { reactions, pins };
}
