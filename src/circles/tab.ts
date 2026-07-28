/**
 * PLAN-31 C2: the shared tab — v1's structural loop ("the ledger is social,
 * settlement is money", v3 amendment). A tracked ledger of typed events on
 * per-member signed hash chains. NO money moves here: no wallet, no send,
 * no settlement — a tab that never settles is a shared note with math.
 *
 * Event types are NAMESPACED and extensible (§11 build discipline): an
 * expense is `expense.add`; a care shift or co-op order is another namespace
 * on the same machinery, a skill away, not a rewrite.
 *
 *  - expense.add      {memo, amount_cents, participants[]} — author paid.
 *  - expense.reversal {reverses: event_id} — corrections are reversals,
 *                     never edits (§3.3).
 *  - note.add         {memo} — the plain shared-notes doc.
 *
 * Balance fold (§3.3): deterministic union fold of member chains, ordered by
 * chain position (author, seq) — claimed dates are display metadata only.
 * Shares use largest-remainder rounding with hash-based tie-breaks so every
 * node computes the identical split. Output is net pairwise balances for
 * DISPLAY (the briefing's "who's up, who's down"), never a payment
 * instruction.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { JsonValue } from "../commerce/sku.js";
import { normalizeSandboxInput, type SandboxEventInput } from "./sandbox.js";

export type TabEventInput =
  | { type: "expense.add"; memo: string; amountCents: number; participants: string[] }
  | { type: "expense.reversal"; reverses: string }
  | { type: "note.add"; memo: string }
  // PLAN-36 Phase C: the group canvas rides the SAME chained event log. A card is
  // an OR-Set entry (put/remove) with last-writer-wins fields; `updated_at` gives
  // the fold a deterministic cross-author order (see canvas.ts computeCanvasCards).
  | {
      type: "canvas.card.put";
      cardId: string;
      cardType: string;
      title: string;
      text: string;
      updatedAt: number;
    }
  | { type: "canvas.card.remove"; cardId: string; updatedAt: number }
  // A per-member contribution to one SLOT of a card (PLAN-36 C2) — e.g. a vote
  // on a Decision Card, or a section contribution on a study guide (C3). One
  // slice per (card, slot, author), LWW; this is the "typed slot each member's
  // agent fills on their behalf" primitive.
  | {
      type: "canvas.slice.put";
      cardId: string;
      slot: string;
      value: string;
      note: string;
      updatedAt: number;
    }
  // PLAN-36 Phase D (deferred from A): message annotations ride the same log.
  // A reaction is the author's FULL emoji set on one message (LWW per
  // (target, author) — toggling re-emits the set, no add/remove tombstones);
  // a pin is circle-wide LWW per target (any member may flip it).
  | { type: "message.react"; targetEnvelopeId: string; emojis: string[]; updatedAt: number }
  | { type: "message.pin"; targetEnvelopeId: string; pinned: boolean; updatedAt: number }
  | { type: "message.delete"; targetEnvelopeId: string; updatedAt: number }
  // PLAN-38 P1(a): the canvas sandbox rides the same chained log. Grammar,
  // caps, and the deterministic fold live in sandbox.ts.
  | SandboxEventInput;

/** The signed-envelope body fields for a chained event append. */
export type ChainedEventBody = {
  seq: number;
  prev_hash: string | null;
  event_type: string;
  event: Record<string, JsonValue>;
  claimed_at: number;
  heads: Record<string, JsonValue>;
};

/**
 * Build the next chained event body for an author: reads the author's local
 * chain head + every member's current head (embedded for fork evidence,
 * §3.3) and returns the body to sign into an `event` envelope.
 */
export function buildChainedEventBody(
  db: DatabaseSync,
  args: {
    circleId: string;
    authorPubkey: string;
    input: TabEventInput;
    now?: number;
  },
): ChainedEventBody {
  const now = args.now ?? Date.now();
  const head = db
    .prepare(
      `SELECT seq, event_hash FROM circle_events
        WHERE circle_id = ? AND author_pubkey = ?
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(args.circleId, args.authorPubkey) as { seq: number; event_hash: string } | undefined;
  const headsRows = db
    .prepare(
      `SELECT author_pubkey, MAX(seq) AS seq FROM circle_events
        WHERE circle_id = ? GROUP BY author_pubkey`,
    )
    .all(args.circleId) as unknown as Array<{ author_pubkey: string; seq: number }>;
  const heads: Record<string, JsonValue> = {};
  for (const r of headsRows) {
    heads[r.author_pubkey] = r.seq;
  }
  const { type, ...rest } = normalizeInput(args.input);
  return {
    seq: head ? head.seq + 1 : 0,
    prev_hash: head ? head.event_hash : null,
    event_type: type,
    event: rest,
    claimed_at: now,
    heads,
  };
}

function normalizeInput(input: TabEventInput): { type: string } & Record<string, JsonValue> {
  switch (input.type) {
    case "expense.add": {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        throw new Error("amountCents must be a positive integer");
      }
      if (input.participants.length === 0) {
        throw new Error("participants required");
      }
      return {
        type: "expense.add",
        memo: input.memo.slice(0, 200),
        amount_cents: input.amountCents,
        participants: [...input.participants].toSorted() as unknown as JsonValue,
      };
    }
    case "expense.reversal":
      return { type: "expense.reversal", reverses: input.reverses };
    case "note.add":
      return { type: "note.add", memo: input.memo.slice(0, 2000) };
    case "canvas.card.put": {
      const cardId = input.cardId.slice(0, 64);
      if (!cardId) throw new Error("cardId required");
      // Title + text are top-level strings so the event.append injection scan
      // reaches them — peer card content is a hostile principal (§5.1).
      return {
        type: "canvas.card.put",
        card_id: cardId,
        card_type: input.cardType.slice(0, 32) || "note",
        title: input.title.slice(0, 200),
        text: input.text.slice(0, 4000),
        updated_at: input.updatedAt,
      };
    }
    case "canvas.card.remove": {
      const cardId = input.cardId.slice(0, 64);
      if (!cardId) throw new Error("cardId required");
      return { type: "canvas.card.remove", card_id: cardId, updated_at: input.updatedAt };
    }
    case "message.react": {
      const target = input.targetEnvelopeId.slice(0, 64);
      if (!target) throw new Error("targetEnvelopeId required");
      // Cap the set (8) and each entry (16 chars). "Emoji" is any short
      // string at this layer — peer values are scanned on receipt and
      // rendered as escaped text like all circle content.
      const emojis = [...new Set(input.emojis.map((e) => e.slice(0, 16)).filter(Boolean))]
        .toSorted()
        .slice(0, 8);
      return {
        type: "message.react",
        target_envelope_id: target,
        emojis: emojis as unknown as JsonValue,
        updated_at: input.updatedAt,
      };
    }
    case "message.pin": {
      const target = input.targetEnvelopeId.slice(0, 64);
      if (!target) throw new Error("targetEnvelopeId required");
      return {
        type: "message.pin",
        target_envelope_id: target,
        pinned: input.pinned,
        updated_at: input.updatedAt,
      };
    }
    case "message.delete": {
      // Author-only message retraction. The fold/ingest side enforces that
      // the event author matches the target message's author — a peer signing
      // a delete for someone else's message is stored (chain integrity) but
      // never applied.
      const target = input.targetEnvelopeId.slice(0, 64);
      if (!target) throw new Error("targetEnvelopeId required");
      return {
        type: "message.delete",
        target_envelope_id: target,
        updated_at: input.updatedAt,
      };
    }
    case "canvas.slice.put": {
      const cardId = input.cardId.slice(0, 64);
      const slot = input.slot.slice(0, 32);
      if (!cardId || !slot) throw new Error("cardId and slot required");
      return {
        type: "canvas.slice.put",
        card_id: cardId,
        slot,
        // 2000 chars: a study-guide section contribution (C3) is a paragraph,
        // not a vote. Value stays a top-level string so the event.append
        // injection scan reaches it.
        value: input.value.slice(0, 2000),
        note: input.note.slice(0, 1000),
        updated_at: input.updatedAt,
      };
    }
    case "sandbox.frame.put":
    case "sandbox.enroll.put":
    case "sandbox.move":
    case "sandbox.close":
    case "sandbox.plan.put":
    case "sandbox.evidence.put":
      return normalizeSandboxInput(input);
  }
}

/**
 * Largest-remainder split with hash tie-breaks (§3.3): every node computes
 * the identical shares for (eventId, amount, participants).
 */
export function splitAmount(
  eventId: string,
  amountCents: number,
  participants: string[],
): Map<string, number> {
  const sorted = [...participants].toSorted();
  const n = sorted.length;
  const base = Math.floor(amountCents / n);
  let remainder = amountCents - base * n;
  const shares = new Map<string, number>(sorted.map((p) => [p, base]));
  // Deterministic tie-break: hash(eventId + pubkey), descending.
  const ranked = sorted
    .map((p) => ({
      p,
      h: crypto.createHash("sha256").update(`${eventId}\n${p}`).digest("hex"),
    }))
    .toSorted((a, b) => (a.h < b.h ? 1 : a.h > b.h ? -1 : 0));
  for (const { p } of ranked) {
    if (remainder <= 0) break;
    shares.set(p, (shares.get(p) ?? 0) + 1);
    remainder -= 1;
  }
  return shares;
}

export type TabBalances = {
  /** Net position per member in cents: positive = the circle owes them. */
  net: Record<string, number>;
  /** Pairwise debts for display: debtor -> creditor -> cents. */
  pairwise: Record<string, Record<string, number>>;
  expenses: number;
  reversed: number;
  totalCents: number;
};

type EventRow = {
  event_id: string;
  author_pubkey: string;
  seq: number;
  event_type: string;
  body_json: string;
};

/**
 * Deterministic union fold of the circle's member chains. Ordering is by
 * chain position (author, seq) — stable on every node regardless of arrival
 * order. Reversals cancel the referenced expense wherever both exist.
 */
export function computeTabBalances(db: DatabaseSync, circleId: string): TabBalances {
  const rows = db
    .prepare(
      `SELECT event_id, author_pubkey, seq, event_type, body_json
         FROM circle_events WHERE circle_id = ?
        ORDER BY author_pubkey ASC, seq ASC`,
    )
    .all(circleId) as unknown as EventRow[];

  const reversed = new Set<string>();
  for (const row of rows) {
    if (row.event_type === "expense.reversal") {
      try {
        const body = JSON.parse(row.body_json) as { reverses?: string };
        // Only the expense's own author may reverse it (a correction is the
        // author owning a mistake, not a peer erasing history).
        if (typeof body.reverses === "string") {
          reversed.add(`${row.author_pubkey}\n${body.reverses}`);
        }
      } catch {
        // malformed reversal: ignored
      }
    }
  }

  const pairwise: Record<string, Record<string, number>> = {};
  const net: Record<string, number> = {};
  let expenses = 0;
  let reversedCount = 0;
  let totalCents = 0;

  for (const row of rows) {
    if (row.event_type !== "expense.add") {
      continue;
    }
    if (reversed.has(`${row.author_pubkey}\n${row.event_id}`)) {
      reversedCount += 1;
      continue;
    }
    let body: { amount_cents?: number; participants?: unknown };
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      continue;
    }
    const amount = typeof body.amount_cents === "number" ? body.amount_cents : 0;
    const participants = Array.isArray(body.participants)
      ? (body.participants as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    if (amount <= 0 || participants.length === 0) {
      continue;
    }
    expenses += 1;
    totalCents += amount;
    const payer = row.author_pubkey;
    const shares = splitAmount(row.event_id, amount, participants);
    for (const [member, share] of shares) {
      if (member === payer) {
        continue;
      }
      pairwise[member] ??= {};
      pairwise[member][payer] = (pairwise[member][payer] ?? 0) + share;
      net[member] = (net[member] ?? 0) - share;
      net[payer] = (net[payer] ?? 0) + share;
    }
    net[payer] ??= net[payer] ?? 0;
  }

  // Collapse mutual debts pair-by-pair for display (A owes B 500, B owes A
  // 200 -> A owes B 300). Display simplification only — NOT settlement.
  for (const debtor of Object.keys(pairwise)) {
    for (const creditor of Object.keys(pairwise[debtor] ?? {})) {
      const forward = pairwise[debtor]?.[creditor] ?? 0;
      const back = pairwise[creditor]?.[debtor] ?? 0;
      if (forward > 0 && back > 0) {
        const cancelled = Math.min(forward, back);
        setPair(pairwise, debtor, creditor, forward - cancelled);
        setPair(pairwise, creditor, debtor, back - cancelled);
      }
    }
  }

  return { net, pairwise, expenses, reversed: reversedCount, totalCents };
}

function setPair(
  pairwise: Record<string, Record<string, number>>,
  debtor: string,
  creditor: string,
  cents: number,
): void {
  if (cents <= 0) {
    if (pairwise[debtor]) {
      delete pairwise[debtor][creditor];
      if (Object.keys(pairwise[debtor]).length === 0) {
        delete pairwise[debtor];
      }
    }
    return;
  }
  pairwise[debtor] ??= {};
  pairwise[debtor][creditor] = cents;
}
