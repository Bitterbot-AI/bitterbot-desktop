/**
 * PLAN-36 Phase D (deferred from Phase A): message annotations — reactions and
 * pins — folded from the circle's chained event log, exactly like the canvas
 * (same replication, same fork-freeze, same injection scan on receipt).
 *
 *  - `message.react` — the author's FULL emoji set on one message. LWW per
 *    (target_envelope_id, author): toggling re-emits the whole set, so there
 *    are no add/remove tombstone pairs to reconcile. An empty set clears.
 *  - `message.pin` — circle-wide pin flag per message. LWW per target by
 *    (effective_updated_at, event_hash); any member may flip it (friends-tier
 *    trust, v1).
 *
 * Targets are envelope ids — stable on every node (the dedupe key), the same
 * reference reply-to uses — so annotations resolve locally everywhere.
 *
 * HOSTILE-INPUT rules (adversarial pass on the first cut):
 *  - Sender-side normalization (tab.ts caps) is NOT trusted here: a hostile
 *    peer signs raw bodies. The fold re-validates the target shape (printable
 *    ASCII, ≤64 — a newline previously let an attacker forge another member's
 *    attribution through the joined LWW key; the fold is also structurally
 *    nested now so no string-splitting exists to hijack) and re-caps emoji
 *    sets (8 × 16 chars).
 *  - `updated_at` is author-claimed, so it is CLAMPED to received_at + skew:
 *    a far-future timestamp cannot win LWW forever — honest later writes
 *    eventually out-clamp it.
 *  - Ties break on event_hash — replicated and identical on every node
 *    (event_id is minted per-node and would let same-millisecond ties
 *    diverge across nodes).
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
  event_hash: string;
  author_pubkey: string;
  event_type: string;
  body_json: string;
  received_at: number;
};

/** Printable ASCII, no whitespace — envelope ids (UUIDs) trivially pass. */
const TARGET_RE = /^[\x21-\x7E]{1,64}$/;
/** How far ahead of local receipt an author-claimed updated_at may run. */
const CLAMP_SKEW_MS = 5 * 60_000;
const MAX_EMOJIS = 8;
const MAX_EMOJI_CHARS = 16;

function wins(aUpdated: number, aHash: string, bUpdated: number, bHash: string): boolean {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated;
  return aHash > bHash;
}

/** The current annotation state for a circle, from the log. */
export function computeMessageAnnotations(db: DatabaseSync, circleId: string): MessageAnnotations {
  const rows = db
    .prepare(
      `SELECT event_hash, author_pubkey, event_type, body_json, received_at
         FROM circle_events
        WHERE circle_id = ? AND event_type IN ('message.react', 'message.pin')`,
    )
    .all(circleId) as unknown as EventRow[];

  type ReactWinner = { emojis: string[]; updatedAt: number; hash: string };
  const reactWinners = new Map<string, Map<string, ReactWinner>>(); // target -> author -> set
  type PinWinner = { pinned: boolean; updatedAt: number; hash: string };
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
    if (!TARGET_RE.test(target)) continue; // hostile/garbled target: dropped
    const claimed = typeof body.updated_at === "number" ? body.updated_at : 0;
    const updatedAt = Math.min(claimed, row.received_at + CLAMP_SKEW_MS);

    if (row.event_type === "message.react") {
      const byAuthor = reactWinners.get(target) ?? new Map<string, ReactWinner>();
      const cur = byAuthor.get(row.author_pubkey);
      if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.hash)) {
        // Re-cap on the fold side — sender normalization is not trusted.
        const emojis = Array.isArray(body.emojis)
          ? [
              ...new Set(
                (body.emojis as unknown[])
                  .filter((e): e is string => typeof e === "string")
                  .map((e) => e.slice(0, MAX_EMOJI_CHARS))
                  .filter(Boolean),
              ),
            ]
              .toSorted()
              .slice(0, MAX_EMOJIS)
          : [];
        byAuthor.set(row.author_pubkey, { emojis, updatedAt, hash: row.event_hash });
        reactWinners.set(target, byAuthor);
      }
    } else {
      const cur = pinWinners.get(target);
      if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.hash)) {
        pinWinners.set(target, {
          pinned: body.pinned === true,
          updatedAt,
          hash: row.event_hash,
        });
      }
    }
  }

  const reactions: Record<string, MessageReaction[]> = {};
  for (const [target, byAuthor] of reactWinners) {
    for (const [author, w] of byAuthor) {
      if (w.emojis.length === 0) continue; // cleared
      (reactions[target] ??= []).push({
        authorPubkey: author,
        emojis: w.emojis,
        updatedAt: w.updatedAt,
      });
    }
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
