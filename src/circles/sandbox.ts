/**
 * PLAN-38 P1: the canvas sandbox — several private memories safely working one
 * shared artifact. This module owns the grammar and the deterministic fold; NO
 * generation, NO UI, NO tools live here (those are later slices, and
 * everything wire-reachable stays inside the §4 invariants).
 *
 * **Cards are alive by nature** `[reshaped 2026-07-28]`. There is no session to
 * open and no per-card enrollment: every card on the canvas can be worked by
 * the members whose agents participate in the circle. The vocabulary below is
 * internal — none of it belongs on screen.
 *
 * Six event types ride the existing `circle/event.append` verb (no new wire
 * verbs; old nodes tolerate them silently because the handler validates chain
 * and scan, not type):
 *
 *  - sandbox.frame.put    — OPTIONAL override of a card's goal or round cap.
 *                           Never required: a card's own title is its goal.
 *                           `task_type` is a closed server-owned enum (R1);
 *                           the free-text goal is peer content, so untrusted.
 *  - sandbox.enroll.put   — the PUBLIC half of participation: `mode` only (R4 —
 *                           presentation, never authorization), declared once
 *                           per CIRCLE. The private half (budgets, guidance)
 *                           is a node-local row in
 *                           `circle_sandbox_participation` and never leaves.
 *  - sandbox.move         — one contribution to one round, from a closed move
 *                           grammar (M5/R6). At most one move per
 *                           (card, author, round) is honored (R11/R12), so
 *                           concurrent moves are harmless and a mailbox-lagged
 *                           move folds into its original round retroactively.
 *  - sandbox.close        — terminal, with a legible attributed reason (§3.1:
 *                           "quietly stopped" is a bug).
 *  - sandbox.plan.put     — typed pre-flight plan steps (§3.2.4: the gate and
 *                           the diff, not a ticker). Closed state enum;
 *                           `blocked` requires a reason.
 *  - sandbox.evidence.put — cited sources as evidence cards (§3.2.3): host +
 *                           title + content hash only. NEVER path or query —
 *                           a source list encodes private constraints (T11).
 *
 * Rounds are a fold-level construct: nothing prevents concurrent moves, the
 * fold makes them harmless. Speaker order for round r = enrolled speakers
 * sorted by sha256(cardId:r:pubkey) — deterministic everywhere, rotates
 * fairly, ungameable. Timeouts (later slice) only ever PERMIT later speakers;
 * they never invalidate an earlier move.
 *
 * Trust shape: every string folded here is peer content. Fold-side re-caps
 * and enum re-validation mirror the sender-side normalization — a hostile
 * peer signs raw bodies, so sender caps are NEVER trusted (canvas.ts rule).
 * LWW tie-breaks use `event_hash` (content-derived, identical on every node),
 * never `event_id` (a node-local UUID).
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { JsonValue } from "../commerce/sku.js";
import { computeCanvasCards } from "./canvas.js";

// ---------------------------------------------------------------------------
// Closed server-owned enums (R1, R6, M5) and caps. Peer values outside an
// enum are dropped or defaulted fold-side, never interpreted.
// ---------------------------------------------------------------------------

export const SANDBOX_TASK_TYPES = ["negotiation"] as const;
export type SandboxTaskType = (typeof SANDBOX_TASK_TYPES)[number];

/** `auto` exists on the wire for forward-compat (peers may advertise it one
 *  day) but is refused sender-side until P2 ships its machinery (R19). */
export const SANDBOX_MODES = ["off", "propose", "auto"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const SANDBOX_MOVE_KINDS = ["constraint", "option.add", "vote", "pass"] as const;
export type SandboxMoveKind = (typeof SANDBOX_MOVE_KINDS)[number];

export const SANDBOX_CLOSE_REASONS = ["done", "cap", "no_progress", "budget", "human"] as const;
export type SandboxCloseReason = (typeof SANDBOX_CLOSE_REASONS)[number];

export const SANDBOX_PLAN_STEP_STATES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "deviated",
] as const;
export type SandboxPlanStepState = (typeof SANDBOX_PLAN_STEP_STATES)[number];

/** §3.1: default round caps stay low; 20 is the hard ceiling everywhere. */
export const SANDBOX_DEFAULT_ROUND_CAP = 3;
export const SANDBOX_ROUND_HARD_CEILING = 20;
export const SANDBOX_MAX_PLAN_STEPS = 12;
export const SANDBOX_MAX_EVIDENCE_SOURCES = 8;
export const SANDBOX_MAX_DERIVED_FROM = 16;

const GOAL_CAP = 1000;
const MOVE_TEXT_CAP = 500;
const OPTION_LABEL_CAP = 200;
const STEP_LABEL_CAP = 120;
const STEP_REASON_CAP = 200;
const SOURCE_TITLE_CAP = 120;

/** Slug charset for ids that reach fold keys and (later) trusted prompt
 *  frames — same rule as the study/B2 slot paths. */
const SLUG_RE = /^[a-z0-9_-]{1,32}$/i;
const EVENT_HASH_RE = /^[a-f0-9]{64}$/;
/** T11: only a hostname ever crosses the wire — no scheme, path, query,
 *  port, or credentials (the charset alone excludes `/:?#@`). */
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

// ---------------------------------------------------------------------------
// Sender-side inputs + normalization (the move grammar). tab.ts delegates the
// `sandbox.*` cases of normalizeInput here so the grammar lives in one place.
// ---------------------------------------------------------------------------

export type SandboxPlanStepInput = {
  id: string;
  label: string;
  state: SandboxPlanStepState;
  /** Required (non-empty) when state === "blocked" — §3.2.4. */
  reason?: string;
};

export type SandboxEvidenceSourceInput = {
  /** Hostname only (use `evidenceHost` to derive it from a URL). */
  host: string;
  title?: string;
  /** sha256 hex of the fetched content; ships on the ledger from day one so
   *  cross-member pixels stay purely additive later (decision 7). */
  contentHash?: string;
};

export type SandboxEventInput =
  | {
      type: "sandbox.frame.put";
      cardId: string;
      taskType: SandboxTaskType;
      goal: string;
      roundCap?: number;
      updatedAt: number;
    }
  // Circle-wide since 2026-07-28: no cardId, because participation is a
  // standing choice about the circle, not a per-card act.
  | { type: "sandbox.enroll.put"; mode: SandboxMode; updatedAt: number }
  | {
      type: "sandbox.move";
      cardId: string;
      round: number;
      kind: SandboxMoveKind;
      /** Free text — propose-mode only, in every phase (R6/I7). */
      text?: string;
      optionId?: string;
      label?: string;
      /** R2/M1: event hashes of the moves this one derives from. Receivers
       *  recompute the transitive author set from their own chain view. */
      derivedFrom?: string[];
      /** I10/R18 wire label. Sender-asserted flags are theater as a control
       *  (§4.4) — this is honest labeling by our own node, not a defense. */
      agentAuthored: boolean;
    }
  | { type: "sandbox.close"; cardId: string; reason: SandboxCloseReason; updatedAt: number }
  | {
      type: "sandbox.plan.put";
      cardId: string;
      round: number;
      steps: SandboxPlanStepInput[];
      updatedAt: number;
    }
  | {
      type: "sandbox.evidence.put";
      cardId: string;
      round: number;
      sources: SandboxEvidenceSourceInput[];
      updatedAt: number;
    };

/** Hostname of a URL (or an already-bare host), for evidence sources. */
export function evidenceHost(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes("://")) {
    host = new URL(host).hostname;
  }
  if (!HOST_RE.test(host)) {
    throw new Error("evidence host must be a bare hostname");
  }
  return host;
}

function requireCardId(cardId: string): string {
  const id = cardId.slice(0, 64);
  if (!id) throw new Error("cardId required");
  return id;
}

function requireRound(round: number): number {
  if (!Number.isInteger(round) || round < 0 || round >= SANDBOX_ROUND_HARD_CEILING) {
    throw new Error(`round must be an integer in [0, ${SANDBOX_ROUND_HARD_CEILING})`);
  }
  return round;
}

/**
 * Sender-side normalization for every `sandbox.*` event (called from tab.ts
 * normalizeInput). Throws before anything is signed. Receivers re-validate
 * everything fold-side regardless — this protects honest nodes from their own
 * bugs, not the circle from hostile peers.
 */
export function normalizeSandboxInput(
  input: SandboxEventInput,
): { type: string } & Record<string, JsonValue> {
  switch (input.type) {
    case "sandbox.frame.put": {
      if (!SANDBOX_TASK_TYPES.includes(input.taskType)) {
        throw new Error(`taskType must be one of: ${SANDBOX_TASK_TYPES.join(", ")}`);
      }
      const roundCap = input.roundCap ?? SANDBOX_DEFAULT_ROUND_CAP;
      if (!Number.isInteger(roundCap) || roundCap < 1 || roundCap > SANDBOX_ROUND_HARD_CEILING) {
        throw new Error(`roundCap must be an integer in [1, ${SANDBOX_ROUND_HARD_CEILING}]`);
      }
      return {
        type: "sandbox.frame.put",
        card_id: requireCardId(input.cardId),
        task_type: input.taskType,
        // Goal is a top-level string so the event.append injection scan
        // reaches it; it is peer content and stays in the untrusted envelope.
        goal: input.goal.slice(0, GOAL_CAP),
        round_cap: roundCap,
        updated_at: input.updatedAt,
      };
    }
    case "sandbox.enroll.put": {
      if (input.mode === "auto") {
        throw new Error("auto mode ships in P2 behind its own opt-in (R19); use 'propose'");
      }
      if (!SANDBOX_MODES.includes(input.mode)) {
        throw new Error(`mode must be one of: ${SANDBOX_MODES.join(", ")}`);
      }
      return {
        type: "sandbox.enroll.put",
        card_id: "", // circle-wide; kept for wire shape only
        mode: input.mode,
        updated_at: input.updatedAt,
      };
    }
    case "sandbox.move": {
      if (!SANDBOX_MOVE_KINDS.includes(input.kind)) {
        throw new Error(`kind must be one of: ${SANDBOX_MOVE_KINDS.join(", ")}`);
      }
      const optionId = (input.optionId ?? "").slice(0, 32);
      const needsOption = input.kind === "option.add" || input.kind === "vote";
      if (needsOption && !SLUG_RE.test(optionId)) {
        throw new Error("optionId must be alphanumeric/-/_ (max 32)");
      }
      if (input.kind === "option.add" && !input.label?.trim()) {
        throw new Error("option.add requires a label");
      }
      if (input.kind === "constraint" && !input.text?.trim()) {
        throw new Error("constraint requires text");
      }
      const derivedFrom = [...new Set(input.derivedFrom ?? [])]
        .filter((h) => EVENT_HASH_RE.test(h))
        .toSorted()
        .slice(0, SANDBOX_MAX_DERIVED_FROM);
      return {
        type: "sandbox.move",
        card_id: requireCardId(input.cardId),
        round: requireRound(input.round),
        kind: input.kind,
        text: (input.text ?? "").slice(0, MOVE_TEXT_CAP),
        option_id: needsOption ? optionId : "",
        label: input.kind === "option.add" ? (input.label ?? "").slice(0, OPTION_LABEL_CAP) : "",
        derived_from: derivedFrom as unknown as JsonValue,
        agent_authored: input.agentAuthored,
      };
    }
    case "sandbox.close": {
      if (!SANDBOX_CLOSE_REASONS.includes(input.reason)) {
        throw new Error(`reason must be one of: ${SANDBOX_CLOSE_REASONS.join(", ")}`);
      }
      return {
        type: "sandbox.close",
        card_id: requireCardId(input.cardId),
        reason: input.reason,
        updated_at: input.updatedAt,
      };
    }
    case "sandbox.plan.put": {
      if (input.steps.length === 0 || input.steps.length > SANDBOX_MAX_PLAN_STEPS) {
        throw new Error(`steps must have 1-${SANDBOX_MAX_PLAN_STEPS} entries`);
      }
      const steps = input.steps.map((s) => {
        const id = s.id.slice(0, 32);
        if (!SLUG_RE.test(id)) throw new Error("step id must be alphanumeric/-/_ (max 32)");
        if (!SANDBOX_PLAN_STEP_STATES.includes(s.state)) {
          throw new Error(`step state must be one of: ${SANDBOX_PLAN_STEP_STATES.join(", ")}`);
        }
        if (s.state === "blocked" && !s.reason?.trim()) {
          throw new Error("a blocked step requires a reason (§3.2.4)");
        }
        return {
          id,
          label: s.label.slice(0, STEP_LABEL_CAP),
          state: s.state,
          reason: (s.reason ?? "").slice(0, STEP_REASON_CAP),
        };
      });
      return {
        type: "sandbox.plan.put",
        card_id: requireCardId(input.cardId),
        round: requireRound(input.round),
        steps: steps as unknown as JsonValue,
        updated_at: input.updatedAt,
      };
    }
    case "sandbox.evidence.put": {
      if (input.sources.length === 0 || input.sources.length > SANDBOX_MAX_EVIDENCE_SOURCES) {
        throw new Error(`sources must have 1-${SANDBOX_MAX_EVIDENCE_SOURCES} entries`);
      }
      const sources = input.sources.map((s) => {
        const host = s.host.trim().toLowerCase();
        if (!HOST_RE.test(host)) {
          throw new Error("source host must be a bare hostname — never a path or query (T11)");
        }
        const contentHash = (s.contentHash ?? "").toLowerCase();
        if (contentHash && !EVENT_HASH_RE.test(contentHash)) {
          throw new Error("contentHash must be sha256 hex");
        }
        return {
          host,
          title: (s.title ?? "").slice(0, SOURCE_TITLE_CAP),
          content_hash: contentHash,
        };
      });
      return {
        type: "sandbox.evidence.put",
        card_id: requireCardId(input.cardId),
        round: requireRound(input.round),
        sources: sources as unknown as JsonValue,
        updated_at: input.updatedAt,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Speaker order + turn test
// ---------------------------------------------------------------------------

/**
 * Speaker order for one round: enrolled speakers sorted by
 * sha256(cardId:round:pubkey). Deterministic on every node, rotates fairly
 * across rounds, and ungameable (nobody controls their digest short of
 * grinding a keypair per card per round).
 */
export function speakerOrderFor(cardId: string, round: number, pubkeys: string[]): string[] {
  return [...new Set(pubkeys)]
    .map((pk) => ({
      pk,
      h: crypto.createHash("sha256").update(`${cardId}:${round}:${pk}`).digest("hex"),
    }))
    .toSorted((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.pk < b.pk ? -1 : 1))
    .map((x) => x.pk);
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export type SandboxMove = {
  round: number;
  kind: SandboxMoveKind;
  text: string;
  optionId: string;
  label: string;
  authorPubkey: string;
  agentAuthored: boolean;
  derivedFrom: string[];
  /** R2/M1: transitive author set, recomputed from OUR chain view — the
   *  sender's copy is never trusted (T1: authorship laundering). */
  authors: string[];
  eventHash: string;
  seq: number;
  claimedAt: number;
};

export type SandboxOption = {
  optionId: string;
  label: string;
  text: string;
  proposedBy: string;
  round: number;
};

export type SandboxPlanStep = {
  id: string;
  label: string;
  state: SandboxPlanStepState;
  reason: string;
};

export type SandboxPlan = {
  authorPubkey: string;
  round: number;
  steps: SandboxPlanStep[];
  updatedAt: number;
};

export type SandboxEvidence = {
  authorPubkey: string;
  round: number;
  sources: Array<{ host: string; title: string; contentHash: string }>;
  updatedAt: number;
};

export type SandboxSession = {
  cardId: string;
  taskType: SandboxTaskType;
  goal: string;
  roundCap: number;
  framedBy: string;
  frameUpdatedAt: number;
  /** All advertised enrollments (R4: presentation only, never authorization). */
  enrollments: Array<{ authorPubkey: string; mode: SandboxMode; updatedAt: number }>;
  /** Enrolled speakers (mode !== 'off'), sorted. */
  speakers: string[];
  /** Honored moves (one per (author, round)), ordered by round then speaker
   *  order within the round. */
  moves: SandboxMove[];
  options: SandboxOption[];
  /** optionId -> voter pubkeys (each author's latest-round honored vote,
   *  tallied only against real options — M5 value validation). */
  votes: Record<string, string[]>;
  /** Latest plan per author (LWW; "updated rather than rewritten"). */
  plans: SandboxPlan[];
  evidence: SandboxEvidence[];
  closed: { reason: SandboxCloseReason; byPubkey: string; at: number } | null;
  /** Smallest round some enrolled speaker has not yet moved in; equals
   *  roundCap when every round is complete. */
  currentRound: number;
  status: "gathering" | "live" | "closed";
};

type EventRow = {
  author_pubkey: string;
  seq: number;
  event_type: string;
  body_json: string;
  event_hash: string;
  claimed_at: number;
};

/** LWW winner test on (updated_at, event_hash) — both content-derived, so
 *  identical on every node (event_id is a node-local UUID and never used). */
function wins(aUpdated: number, aHash: string, bUpdated: number, bHash: string): boolean {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated;
  return aHash > bHash;
}

function parseBody(row: EventRow): Record<string, unknown> | null {
  try {
    const body = JSON.parse(row.body_json) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown, cap: number): string {
  return typeof v === "string" ? v.slice(0, cap) : "";
}

/**
 * The fold: EVERY card on the canvas carries a live session, materialized
 * from the circle's chained event log `[reshaped 2026-07-28 — cards are alive
 * by nature, not by opt-in]`.
 *
 * There is no "open a session" act. A card exists, therefore it can be worked:
 * the goal is the card's own title, the task type defaults to the only one we
 * have. `sandbox.frame.put` survives ONLY as an optional override (a custom
 * goal, a different round cap) and is never required — which is also why
 * cards that predate this code light up with no migration and no backfill.
 *
 * Participation is circle-wide (see `sandbox.enroll.put` below): a member
 * declares once that their agent works this circle's canvas, and that applies
 * to every card in it. Speaker order still derives from the ledger, so it
 * stays deterministic on every node.
 *
 * Deterministic from the same event set regardless of arrival order. All
 * strings are re-capped and all enums re-validated here — sender
 * normalization is NOT trusted.
 */
export function computeSandboxSessions(db: DatabaseSync, circleId: string): SandboxSession[] {
  const rows = db
    .prepare(
      `SELECT author_pubkey, seq, event_type, body_json, event_hash, claimed_at
         FROM circle_events
        WHERE circle_id = ?
          AND event_type IN ('sandbox.frame.put', 'sandbox.enroll.put', 'sandbox.move',
                             'sandbox.close', 'sandbox.plan.put', 'sandbox.evidence.put')`,
    )
    .all(circleId) as unknown as EventRow[];

  type Framed = { row: EventRow; body: Record<string, unknown>; updatedAt: number };
  const frames = new Map<string, Framed>(); // LWW per card_id (optional override)
  const enrolls = new Map<string, Framed>(); // LWW per author — CIRCLE-wide
  const moveCandidates = new Map<string, Framed>(); // honored per (card, author, round)
  const plans = new Map<string, Framed>(); // LWW per (card, author)
  const evidence = new Map<string, Framed>(); // LWW per (card, author, round)
  const closes = new Map<string, Framed>(); // earliest-honored per card

  for (const row of rows) {
    const body = parseBody(row);
    if (!body) continue;
    const cardId = str(body.card_id, 64);
    const updatedAt = typeof body.updated_at === "number" ? body.updated_at : 0;
    const entry: Framed = { row, body, updatedAt };
    // Every type except the circle-wide participation declaration is scoped
    // to one card and is meaningless without it.
    if (!cardId && row.event_type !== "sandbox.enroll.put") continue;

    switch (row.event_type) {
      case "sandbox.frame.put": {
        // Fail closed: an invalid task_type never creates a session (R1 — the
        // enum is server-owned; unknown values are not interpreted).
        if (!SANDBOX_TASK_TYPES.includes(body.task_type as SandboxTaskType)) continue;
        const cur = frames.get(cardId);
        if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
          frames.set(cardId, entry);
        }
        break;
      }
      case "sandbox.enroll.put": {
        // CIRCLE-scoped since 2026-07-28: one standing declaration per member
        // covers every card here, so `card_id` is ignored (older per-card
        // events still fold correctly — they just apply circle-wide).
        const key = row.author_pubkey;
        const cur = enrolls.get(key);
        if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
          enrolls.set(key, entry);
        }
        break;
      }
      case "sandbox.move": {
        const round = typeof body.round === "number" ? body.round : -1;
        if (!Number.isInteger(round) || round < 0 || round >= SANDBOX_ROUND_HARD_CEILING) {
          continue;
        }
        if (!SANDBOX_MOVE_KINDS.includes(body.kind as SandboxMoveKind)) continue;
        // R11/R12: at most one move per (card, author, round) is honored —
        // the EARLIEST by the author's own chain position, so a duplicate or
        // a flood from one author cannot displace their first move, and every
        // node picks the same winner regardless of arrival order.
        const key = `${cardId}\n${row.author_pubkey}\n${round}`;
        const cur = moveCandidates.get(key);
        if (
          !cur ||
          row.seq < cur.row.seq ||
          (row.seq === cur.row.seq && row.event_hash < cur.row.event_hash)
        ) {
          moveCandidates.set(key, entry);
        }
        break;
      }
      case "sandbox.plan.put": {
        const key = `${cardId}\n${row.author_pubkey}`;
        const cur = plans.get(key);
        if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
          plans.set(key, entry);
        }
        break;
      }
      case "sandbox.evidence.put": {
        const round = typeof body.round === "number" ? body.round : -1;
        if (!Number.isInteger(round) || round < 0) continue;
        const key = `${cardId}\n${row.author_pubkey}\n${round}`;
        const cur = evidence.get(key);
        if (!cur || wins(updatedAt, row.event_hash, cur.updatedAt, cur.row.event_hash)) {
          evidence.set(key, entry);
        }
        break;
      }
      case "sandbox.close": {
        // Closing is the safe direction: any member's close is honored. The
        // attributed winner is the earliest (updated_at, event_hash) so every
        // node names the same closer.
        const cur = closes.get(cardId);
        if (!cur || wins(cur.updatedAt, cur.row.event_hash, updatedAt, row.event_hash)) {
          closes.set(cardId, entry);
        }
        break;
      }
    }
  }

  // Participation is circle-wide, so it is computed ONCE and shared by every
  // card's session rather than recomputed per card.
  const enrollments: SandboxSession["enrollments"] = [];
  for (const e of enrolls.values()) {
    const mode = SANDBOX_MODES.includes(e.body.mode as SandboxMode)
      ? (e.body.mode as SandboxMode)
      : "off"; // fail closed on garbage
    enrollments.push({ authorPubkey: e.row.author_pubkey, mode, updatedAt: e.updatedAt });
  }
  enrollments.sort((a, b) => (a.authorPubkey < b.authorPubkey ? -1 : 1));
  const speakers = enrollments.filter((e) => e.mode !== "off").map((e) => e.authorPubkey);

  // One session per LIVE CARD — the card is the session. A frame event, when
  // one exists, only overrides the goal and round cap.
  const sessions: SandboxSession[] = [];
  for (const card of computeCanvasCards(db, circleId)) {
    const cardId = card.cardId;
    const frame = frames.get(cardId);
    const taskType =
      frame && SANDBOX_TASK_TYPES.includes(frame.body.task_type as SandboxTaskType)
        ? (frame.body.task_type as SandboxTaskType)
        : "negotiation";
    const roundCapRaw = frame?.body.round_cap;
    const roundCap =
      Number.isInteger(roundCapRaw) &&
      (roundCapRaw as number) >= 1 &&
      (roundCapRaw as number) <= SANDBOX_ROUND_HARD_CEILING
        ? (roundCapRaw as number)
        : SANDBOX_DEFAULT_ROUND_CAP;

    // Honored moves, with fold-side re-caps and per-kind validation.
    const byHash = new Map<string, SandboxMove>();
    const moves: SandboxMove[] = [];
    for (const [key, m] of moveCandidates) {
      if (!key.startsWith(`${cardId}\n`)) continue;
      const round = m.body.round as number;
      if (round >= roundCap) continue; // receiver-side round bound (R12)
      const kind = m.body.kind as SandboxMoveKind;
      const optionId = str(m.body.option_id, 32);
      if ((kind === "option.add" || kind === "vote") && !SLUG_RE.test(optionId)) continue;
      const derivedFrom = Array.isArray(m.body.derived_from)
        ? (m.body.derived_from as unknown[])
            .filter((h): h is string => typeof h === "string" && EVENT_HASH_RE.test(h))
            .toSorted()
            .slice(0, SANDBOX_MAX_DERIVED_FROM)
        : [];
      const move: SandboxMove = {
        round,
        kind,
        text: str(m.body.text, MOVE_TEXT_CAP),
        optionId: kind === "option.add" || kind === "vote" ? optionId : "",
        label: kind === "option.add" ? str(m.body.label, OPTION_LABEL_CAP) : "",
        authorPubkey: m.row.author_pubkey,
        agentAuthored: m.body.agent_authored === true,
        derivedFrom,
        authors: [], // filled below, from OUR view
        eventHash: m.row.event_hash,
        seq: m.row.seq,
        claimedAt: m.row.claimed_at,
      };
      moves.push(move);
      byHash.set(move.eventHash, move);
    }

    // Transitive author sets (M1), recomputed receiver-side over honored
    // moves only. Bounded walk; references to unknown hashes are ignored.
    for (const move of moves) {
      const authors = new Set<string>([move.authorPubkey]);
      const queue = [...move.derivedFrom];
      const visited = new Set<string>([move.eventHash]);
      while (queue.length > 0 && visited.size <= 64) {
        const hash = queue.pop()!;
        if (visited.has(hash)) continue;
        visited.add(hash);
        const parent = byHash.get(hash);
        if (!parent) continue;
        authors.add(parent.authorPubkey);
        queue.push(...parent.derivedFrom);
      }
      move.authors = [...authors].toSorted();
    }

    // Display order: round, then this round's speaker order, then hash.
    const orderCache = new Map<number, Map<string, number>>();
    const posOf = (round: number, pk: string): number => {
      let byPk = orderCache.get(round);
      if (!byPk) {
        byPk = new Map(speakerOrderFor(cardId, round, speakers).map((p, i) => [p, i]));
        orderCache.set(round, byPk);
      }
      return byPk.get(pk) ?? Number.MAX_SAFE_INTEGER;
    };
    moves.sort((a, b) => {
      if (a.round !== b.round) return a.round - b.round;
      const pa = posOf(a.round, a.authorPubkey);
      const pb = posOf(b.round, b.authorPubkey);
      if (pa !== pb) return pa - pb;
      return a.eventHash < b.eventHash ? -1 : 1;
    });

    // Option set: keyed by option_id; winner = earliest (round, event_hash).
    const options = new Map<string, SandboxOption & { eventHash: string }>();
    for (const m of moves) {
      if (m.kind !== "option.add") continue;
      const cur = options.get(m.optionId);
      if (!cur || m.round < cur.round || (m.round === cur.round && m.eventHash < cur.eventHash)) {
        options.set(m.optionId, {
          optionId: m.optionId,
          label: m.label,
          text: m.text,
          proposedBy: m.authorPubkey,
          round: m.round,
          eventHash: m.eventHash,
        });
      }
    }

    // Votes: each author's latest-round honored vote, tallied only against
    // options that exist in the fold (M5: server-side value validation — a
    // vote for a phantom option is stored on the chain but never counted).
    const latestVote = new Map<string, SandboxMove>();
    for (const m of moves) {
      if (m.kind !== "vote" || !options.has(m.optionId)) continue;
      const cur = latestVote.get(m.authorPubkey);
      if (!cur || m.round > cur.round) latestVote.set(m.authorPubkey, m);
    }
    const votes: Record<string, string[]> = {};
    for (const v of latestVote.values()) {
      (votes[v.optionId] ??= []).push(v.authorPubkey);
    }
    for (const k of Object.keys(votes)) votes[k]!.sort();

    const foldedPlans: SandboxPlan[] = [];
    for (const [key, p] of plans) {
      if (!key.startsWith(`${cardId}\n`)) continue;
      const round = Number.isInteger(p.body.round) ? (p.body.round as number) : 0;
      const rawSteps = Array.isArray(p.body.steps) ? (p.body.steps as unknown[]) : [];
      const steps: SandboxPlanStep[] = [];
      for (const raw of rawSteps.slice(0, SANDBOX_MAX_PLAN_STEPS)) {
        if (!raw || typeof raw !== "object") continue;
        const s = raw as Record<string, unknown>;
        const id = str(s.id, 32);
        if (!SLUG_RE.test(id)) continue;
        steps.push({
          id,
          label: str(s.label, STEP_LABEL_CAP),
          state: SANDBOX_PLAN_STEP_STATES.includes(s.state as SandboxPlanStepState)
            ? (s.state as SandboxPlanStepState)
            : "pending",
          reason: str(s.reason, STEP_REASON_CAP),
        });
      }
      if (steps.length === 0) continue;
      foldedPlans.push({ authorPubkey: p.row.author_pubkey, round, steps, updatedAt: p.updatedAt });
    }
    foldedPlans.sort((a, b) => (a.authorPubkey < b.authorPubkey ? -1 : 1));

    const foldedEvidence: SandboxEvidence[] = [];
    for (const [key, ev] of evidence) {
      if (!key.startsWith(`${cardId}\n`)) continue;
      const round = ev.body.round as number;
      const rawSources = Array.isArray(ev.body.sources) ? (ev.body.sources as unknown[]) : [];
      const sources: SandboxEvidence["sources"] = [];
      for (const raw of rawSources.slice(0, SANDBOX_MAX_EVIDENCE_SOURCES)) {
        if (!raw || typeof raw !== "object") continue;
        const s = raw as Record<string, unknown>;
        const host = typeof s.host === "string" ? s.host.toLowerCase() : "";
        // T11 holds fold-side too: a signed body carrying a path or query in
        // `host` is dropped, never rendered.
        if (!HOST_RE.test(host)) continue;
        const contentHash =
          typeof s.content_hash === "string" && EVENT_HASH_RE.test(s.content_hash.toLowerCase())
            ? s.content_hash.toLowerCase()
            : "";
        sources.push({ host, title: str(s.title, SOURCE_TITLE_CAP), contentHash });
      }
      if (sources.length === 0) continue;
      foldedEvidence.push({
        authorPubkey: ev.row.author_pubkey,
        round,
        sources,
        updatedAt: ev.updatedAt,
      });
    }
    foldedEvidence.sort((a, b) =>
      a.round !== b.round ? a.round - b.round : a.authorPubkey < b.authorPubkey ? -1 : 1,
    );

    const closeEntry = closes.get(cardId);
    const closed = closeEntry
      ? {
          reason: SANDBOX_CLOSE_REASONS.includes(closeEntry.body.reason as SandboxCloseReason)
            ? (closeEntry.body.reason as SandboxCloseReason)
            : // A garbage reason is still a member's signed choice to stop —
              // honor the close, attribute it as a human call (§3.1: every
              // terminal state is legible and attributed).
              "human",
          byPubkey: closeEntry.row.author_pubkey,
          at: closeEntry.updatedAt,
        }
      : null;

    // Current round: smallest round some enrolled speaker has not moved in.
    const movedIn = new Map<number, Set<string>>();
    for (const m of moves) {
      let set = movedIn.get(m.round);
      if (!set) {
        set = new Set();
        movedIn.set(m.round, set);
      }
      set.add(m.authorPubkey);
    }
    let currentRound = roundCap;
    if (speakers.length === 0) {
      currentRound = 0;
    } else {
      for (let r = 0; r < roundCap; r++) {
        const moved = movedIn.get(r);
        if (!moved || speakers.some((pk) => !moved.has(pk))) {
          currentRound = r;
          break;
        }
      }
    }

    sessions.push({
      cardId,
      taskType,
      // The card IS the goal. An explicit frame only overrides it.
      goal: frame ? str(frame.body.goal, GOAL_CAP) || card.title : card.title,
      roundCap,
      framedBy: frame ? frame.row.author_pubkey : card.authorPubkey,
      frameUpdatedAt: frame ? frame.updatedAt : card.updatedAt,
      enrollments,
      speakers,
      moves,
      options: [...options.values()]
        .map(({ eventHash: _eventHash, ...o }) => o)
        .toSorted((a, b) => (a.optionId < b.optionId ? -1 : 1)),
      votes,
      plans: foldedPlans,
      evidence: foldedEvidence,
      closed,
      currentRound,
      status: closed ? "closed" : moves.length === 0 ? "gathering" : "live",
    });
  }
  sessions.sort((a, b) => b.frameUpdatedAt - a.frameUpdatedAt); // newest first
  return sessions;
}

/**
 * The my-turn test: it is my turn in the current round when I am an enrolled
 * speaker, I have not moved yet, and every speaker ordered before me already
 * has. (Timeouts — a later slice — only ever PERMIT later speakers; they
 * never invalidate this.)
 */
export function isMyTurn(session: SandboxSession, myPubkey: string): boolean {
  if (session.status === "closed") return false;
  const r = session.currentRound;
  if (r >= session.roundCap) return false;
  const order = speakerOrderFor(session.cardId, r, session.speakers);
  const mine = order.indexOf(myPubkey);
  if (mine < 0) return false;
  const moved = new Set(session.moves.filter((m) => m.round === r).map((m) => m.authorPubkey));
  if (moved.has(myPubkey)) return false;
  return order.slice(0, mine).every((pk) => moved.has(pk));
}

// ---------------------------------------------------------------------------
// The PRIVATE half of participation: circle_sandbox_participation. ONE row per
// circle — "my agent works this circle's canvas" is a single standing choice,
// not a per-card ceremony `[reshaped 2026-07-28]`. Node-local, never fanned
// out, and still the ONLY thing that gates spend (I4/I5, R4/R5/R10). A peer
// learns `mode` from sandbox.enroll.put; budgets and guidance stay here on
// member-own hardware.
//
// Moving from per-card to per-circle loses no safety: spend is still bounded
// by budgets only this human refills, and every generated move still waits for
// their tap before it reaches the wire. What it removes is the ceremony that
// stood between a person and the thing working.
// ---------------------------------------------------------------------------

export const SANDBOX_DEFAULT_TURN_BUDGET = 20;
export const SANDBOX_DEFAULT_TOKEN_BUDGET = 400_000;

export type SandboxParticipation = {
  circleId: string;
  mode: "off" | "propose";
  turnBudget: number;
  turnsUsed: number;
  tokenBudget: number;
  tokensUsed: number;
  guidance: string;
  pausedAt: number | null;
  pauseReason: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type ParticipationRow = {
  circle_id: string;
  mode: string;
  turn_budget: number;
  turns_used: number;
  token_budget: number;
  tokens_used: number;
  guidance: string;
  paused_at: number | null;
  pause_reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

function toParticipation(r: ParticipationRow): SandboxParticipation {
  return {
    circleId: r.circle_id,
    mode: r.mode === "propose" ? "propose" : "off",
    turnBudget: r.turn_budget,
    turnsUsed: r.turns_used,
    tokenBudget: r.token_budget,
    tokensUsed: r.tokens_used,
    guidance: r.guidance,
    pausedAt: r.paused_at,
    pauseReason: r.pause_reason,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Set this human's standing participation for a circle. Only the local human
 * reaches this path (there is no wire verb into it), which is what makes the
 * budget human-only-refillable (R10). Setting budgets here IS the refill, and
 * setting participation again clears a pause (the human deciding to resume).
 */
export function setSandboxParticipation(
  db: DatabaseSync,
  args: {
    circleId: string;
    mode: "off" | "propose";
    turnBudget?: number;
    tokenBudget?: number;
    guidance?: string;
    expiresAt?: number | null;
    now?: number;
  },
): SandboxParticipation {
  const now = args.now ?? Date.now();
  if (args.mode !== "off" && args.mode !== "propose") {
    // 'auto' arrives in P2 behind its own separate opt-in (R19); until that
    // machinery exists the store refuses to represent it.
    throw new Error("mode must be 'off' or 'propose'");
  }
  const turnBudget = args.turnBudget ?? SANDBOX_DEFAULT_TURN_BUDGET;
  const tokenBudget = args.tokenBudget ?? SANDBOX_DEFAULT_TOKEN_BUDGET;
  if (!Number.isInteger(turnBudget) || turnBudget < 0) throw new Error("turnBudget must be >= 0");
  if (!Number.isInteger(tokenBudget) || tokenBudget < 0)
    throw new Error("tokenBudget must be >= 0");
  db.prepare(
    `INSERT INTO circle_sandbox_participation
       (circle_id, mode, turn_budget, turns_used, token_budget, tokens_used,
        guidance, paused_at, pause_reason, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, 0, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(circle_id) DO UPDATE SET
       mode = excluded.mode,
       turn_budget = excluded.turn_budget,
       token_budget = excluded.token_budget,
       guidance = excluded.guidance,
       paused_at = NULL,
       pause_reason = NULL,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(
    args.circleId,
    args.mode,
    turnBudget,
    tokenBudget,
    (args.guidance ?? "").slice(0, 2000),
    args.expiresAt ?? null,
    now,
    now,
  );
  return getSandboxParticipation(db, args.circleId)!;
}

export function getSandboxParticipation(
  db: DatabaseSync,
  circleId: string,
): SandboxParticipation | null {
  const row = db
    .prepare(`SELECT * FROM circle_sandbox_participation WHERE circle_id = ?`)
    .get(circleId) as ParticipationRow | undefined;
  return row ? toParticipation(row) : null;
}

/**
 * Atomically claim one agent turn (the claimAgentDraft guarded-UPDATE
 * pattern, R5): succeeds only while participation is on, unpaused, unexpired,
 * and inside both budgets. Returns false otherwise — the caller must not
 * generate. A claimed turn is spent even if generation then fails
 * (conservative by design: a crashing generation must not become an unmetered
 * retry loop).
 */
export function claimSandboxTurn(
  db: DatabaseSync,
  args: { circleId: string; now?: number },
): boolean {
  const now = args.now ?? Date.now();
  const res = db
    .prepare(
      `UPDATE circle_sandbox_participation
          SET turns_used = turns_used + 1, updated_at = ?
        WHERE circle_id = ?
          AND mode = 'propose'
          AND paused_at IS NULL
          AND turns_used < turn_budget
          AND tokens_used < token_budget
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .run(now, args.circleId, now);
  return Number(res.changes) === 1;
}

/** Record consumption-side token spend for one circle (R10/M3). */
export function recordSandboxTokenSpend(
  db: DatabaseSync,
  args: { circleId: string; tokens: number; now?: number },
): void {
  if (!Number.isInteger(args.tokens) || args.tokens < 0) {
    throw new Error("tokens must be a non-negative integer");
  }
  db.prepare(
    `UPDATE circle_sandbox_participation
        SET tokens_used = tokens_used + ?, updated_at = ?
      WHERE circle_id = ?`,
  ).run(args.tokens, args.now ?? Date.now(), args.circleId);
}

/**
 * Every circle whose agent could spend RIGHT NOW: propose mode, unpaused,
 * unexpired, inside both budgets. The turn sweep iterates exactly this set —
 * anything filtered here can never reach a generation (R5 spend-time gate,
 * first check of two; claimSandboxTurn re-checks atomically).
 */
export function listSpendableSandboxCircles(
  db: DatabaseSync,
  now: number = Date.now(),
): SandboxParticipation[] {
  const rows = db
    .prepare(
      `SELECT * FROM circle_sandbox_participation
        WHERE mode = 'propose'
          AND paused_at IS NULL
          AND turns_used < turn_budget
          AND tokens_used < token_budget
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY circle_id`,
    )
    .all(now) as unknown as ParticipationRow[];
  return rows.map(toParticipation);
}

/**
 * Pause with a stated reason (§3.1: every stop is legible — this is what the
 * no-progress detector and the pause control both call).
 */
export function pauseSandboxParticipation(
  db: DatabaseSync,
  args: { circleId: string; reason: string; now?: number },
): void {
  const now = args.now ?? Date.now();
  db.prepare(
    `UPDATE circle_sandbox_participation
        SET paused_at = ?, pause_reason = ?, updated_at = ?
      WHERE circle_id = ?`,
  ).run(now, args.reason.slice(0, 200), now, args.circleId);
}

/** The human resuming: clears the pause, touches nothing else. */
export function resumeSandboxParticipation(
  db: DatabaseSync,
  args: { circleId: string; now?: number },
): void {
  db.prepare(
    `UPDATE circle_sandbox_participation
        SET paused_at = NULL, pause_reason = NULL, updated_at = ?
      WHERE circle_id = ?`,
  ).run(args.now ?? Date.now(), args.circleId);
}
