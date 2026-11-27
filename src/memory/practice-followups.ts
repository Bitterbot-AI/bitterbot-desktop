/**
 * PLAN-64 Phase 1b: learning standing practices from follow-ups on a
 * recurring request.
 *
 * Phase 0 found that the owner rarely phrases behavioural feedback as a
 * correction. What they do is ask a recurring question, read the answer, and
 * ask for the part it left out ("how about our npm downloads"). This module
 * turns that into a practice, with the owner's yes in between:
 *
 * 1. Follow-up gap. The reply path records the answer to each owner turn
 *    (`practice_session_state`, persisted) with the recurring task type the
 *    turn was typed as, if any. The owner's NEXT message in that session
 *    (no other owner turn in between) within FOLLOW_UP_WINDOW_MS is checked
 *    when the answered turn was a recurring task, or when that turn was
 *    untyped and the new message itself matches a recurring type by words
 *    (the gap is then attributed to the new message's type). ONE cheap-model
 *    call (the correction lane, folded into the correction pass's own call
 *    when its pre-filter fires on the same turn) classifies the message as
 *    `gap` (asks for something the answer should have contained) or `other`.
 *    At most one such call per answer.
 * 2. Candidate. A gap is a short imperative ("Include npm downloads") whose
 *    element must be grounded in the owner's own words. It is stored as a
 *    `candidate` practice at `task:<slug>`, origin `follow_up`, never
 *    rendered. A matching gap seen again adds a sighting to the same row.
 * 3. Offer. When a candidate has two independent sightings (different
 *    sessions or days), or one whose owner text was an explicit instruction,
 *    one generated line is appended to a reply: "You have asked for npm
 *    downloads after repo stats twice. Include it every time? (yes / no)".
 *    At most MAX_OFFERS_PER_PRACTICE offers per candidate, never twice in a
 *    session, one per reply, direct chats only.
 * 4. Answer. A bare yes or no as the owner's next message within
 *    OFFER_ANSWER_WINDOW_MS promotes the candidate to an active owner-tier
 *    practice or suppresses it for good. No model call. Anything else does
 *    nothing and the offer lapses.
 *
 * Trust: identical to the correction capture (the owner's first-party direct
 * turns only; the caller gates). Nothing here is written by a model: the
 * model's output is a label and a short statement that must pass the
 * grounding rule, and every line shown to the owner is generated here.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ScopeContext } from "./canonical-facts.js";
import { extractFirstJsonObject, hasRetraction } from "./model-json.js";
import {
  arePracticesNearDuplicate,
  cleanPracticeStatement,
  type Practice,
  practiceDayKey,
  type PracticeOrigin,
  type PracticesStore,
  practiceStatementRejection,
} from "./practices.js";
import { contentWords, stripMessageEnvelope } from "./task-types.js";

const log = createSubsystemLogger("memory/practice-followups");

/**
 * A follow-up is the owner's next message in the session after the answer,
 * when it arrives within this long. Six hours, not minutes: in the owner's
 * real history the follow-ups ("how about our npm downloads") came one to
 * three hours after the answer, in the same session. The cost stays one
 * check per answer, because only the next message is looked at.
 */
export const FOLLOW_UP_WINDOW_MS = 6 * 3_600_000;
/** A yes or no counts as the answer to an offer for this long. */
export const OFFER_ANSWER_WINDOW_MS = 30 * 60_000;
export const MAX_OFFERS_PER_PRACTICE = 2;
/** How long the persisted "task type of the turn before" is used for scoping a correction. */
export const PRECEDING_TASK_WINDOW_MS = 30 * 60_000;
const MAX_STATE_OWNER_CHARS = 600;
const MAX_STATE_ANSWER_CHARS = 2_000;
const STATE_RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_OFFER_LINE_CHARS = 320;

// ── Persisted per-session state ─────────────────────────────────────────────

export type FollowUpState = {
  sessionKey: string;
  sessionId: string | null;
  /**
   * The recurring type of the last answered owner turn; null when that turn
   * matched none (its text and answer are still kept, see `pendingUntypedAnswer`).
   */
  taskSlug: string | null;
  ownerText: string | null;
  answerText: string | null;
  answeredAt: number | null;
  /** The one gap check this answer allows was spent. */
  gapChecked: boolean;
  /** The candidate the last reply offered. */
  offerPracticeId: string | null;
  offeredAt: number | null;
  /** The owner's answer to an offer, until the reply reports it. */
  answerPracticeId: string | null;
  answerKind: "confirmed" | "declined" | null;
  answerRunId: string | null;
  answerAt: number | null;
};

type StateRow = {
  session_key: string;
  session_id: string | null;
  task_slug: string | null;
  owner_text: string | null;
  answer_text: string | null;
  answered_at: number | null;
  gap_checked: number;
  offer_practice_id: string | null;
  offered_at: number | null;
  answer_practice_id: string | null;
  answer_kind: string | null;
  answer_run_id: string | null;
  answer_at: number | null;
};

const STATE_COLUMNS = [
  "session_id",
  "task_slug",
  "owner_text",
  "answer_text",
  "answered_at",
  "gap_checked",
  "offer_practice_id",
  "offered_at",
  "answer_practice_id",
  "answer_kind",
  "answer_run_id",
  "answer_at",
] as const;
type StateColumn = (typeof STATE_COLUMNS)[number];

/**
 * The link between an answer and the owner's next message, and between an
 * offer and its answer. One row per session key, in the memory database, so
 * a gateway restart in between loses nothing. Never throws: on a database
 * without the table every read is null and every write a no-op.
 */
export class FollowUpStateStore {
  constructor(private readonly db: DatabaseSync) {}

  get(sessionKey: string | undefined | null): FollowUpState | null {
    if (!sessionKey) {
      return null;
    }
    try {
      const row = this.db
        .prepare(
          `SELECT session_key, ${STATE_COLUMNS.join(", ")} FROM practice_session_state
            WHERE session_key = ?`,
        )
        .get(sessionKey) as StateRow | undefined;
      if (!row) {
        return null;
      }
      return {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        taskSlug: row.task_slug,
        ownerText: row.owner_text,
        answerText: row.answer_text,
        answeredAt: row.answered_at,
        gapChecked: row.gap_checked === 1,
        offerPracticeId: row.offer_practice_id,
        offeredAt: row.offered_at,
        answerPracticeId: row.answer_practice_id,
        answerKind:
          row.answer_kind === "confirmed" || row.answer_kind === "declined"
            ? row.answer_kind
            : null,
        answerRunId: row.answer_run_id,
        answerAt: row.answer_at,
      };
    } catch (err) {
      log.debug(`follow-up state unavailable: ${String(err)}`);
      return null;
    }
  }

  private patch(
    sessionKey: string,
    fields: Partial<Record<StateColumn, string | number | null>>,
    now: number,
  ): void {
    const columns = STATE_COLUMNS.filter((c) => c in fields);
    try {
      this.db
        .prepare(
          `INSERT INTO practice_session_state (session_key, updated_at) VALUES (?, ?)
           ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(sessionKey, now);
      if (columns.length > 0) {
        this.db
          .prepare(
            `UPDATE practice_session_state SET ${columns.map((c) => `${c} = ?`).join(", ")}
              WHERE session_key = ?`,
          )
          .run(...columns.map((c) => fields[c] ?? null), sessionKey);
      }
      this.db
        .prepare(`DELETE FROM practice_session_state WHERE updated_at < ?`)
        .run(now - STATE_RETENTION_MS);
    } catch (err) {
      log.debug(`follow-up state write failed: ${String(err)}`);
    }
  }

  /**
   * The reply to an owner turn went out: the next message may be a follow-up.
   * `taskSlug` is the recurring type the turn was typed as, or null when it
   * matched none.
   */
  recordAnswer(
    sessionKey: string,
    params: {
      sessionId?: string | null;
      taskSlug: string | null;
      ownerText: string;
      answerText: string;
      now?: number;
    },
  ): void {
    const now = params.now ?? Date.now();
    this.patch(
      sessionKey,
      {
        session_id: params.sessionId ?? null,
        task_slug: params.taskSlug,
        owner_text: stripMessageEnvelope(params.ownerText).trim().slice(0, MAX_STATE_OWNER_CHARS),
        answer_text: params.answerText.trim().slice(0, MAX_STATE_ANSWER_CHARS),
        answered_at: now,
        gap_checked: 0,
      },
      now,
    );
  }

  /** Nothing to follow up on (follow-up learning is off for this turn). */
  clearAnswer(sessionKey: string, now: number = Date.now()): void {
    const state = this.get(sessionKey);
    if (!state?.taskSlug && state?.answeredAt == null) {
      return;
    }
    this.patch(
      sessionKey,
      { task_slug: null, owner_text: null, answer_text: null, answered_at: null, gap_checked: 0 },
      now,
    );
  }

  markGapChecked(sessionKey: string, now: number = Date.now()): void {
    this.patch(sessionKey, { gap_checked: 1 }, now);
  }

  setOffer(
    sessionKey: string,
    practiceId: string,
    opts: { sessionId?: string | null; now?: number } = {},
  ): void {
    const now = opts.now ?? Date.now();
    this.patch(
      sessionKey,
      {
        offer_practice_id: practiceId,
        offered_at: now,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      },
      now,
    );
  }

  clearOffer(sessionKey: string, now: number = Date.now()): void {
    if (!this.get(sessionKey)?.offerPracticeId) {
      return;
    }
    this.patch(sessionKey, { offer_practice_id: null, offered_at: null }, now);
  }

  /** The owner answered the offer; kept until the reply reports it. */
  setOfferAnswer(
    sessionKey: string,
    params: {
      practiceId: string;
      kind: "confirmed" | "declined";
      runId?: string | null;
      now?: number;
    },
  ): void {
    const now = params.now ?? Date.now();
    this.patch(
      sessionKey,
      {
        offer_practice_id: null,
        offered_at: null,
        answer_practice_id: params.practiceId,
        answer_kind: params.kind,
        answer_run_id: params.runId ?? null,
        answer_at: now,
      },
      now,
    );
  }

  clearOfferAnswer(sessionKey: string, now: number = Date.now()): void {
    this.patch(
      sessionKey,
      { answer_practice_id: null, answer_kind: null, answer_run_id: null, answer_at: null },
      now,
    );
  }

  /** The last answer, while inside the window with its one gap check not spent. */
  private openAnswer(
    sessionKey: string | undefined | null,
    now: number,
  ): (FollowUpState & { answeredAt: number }) | null {
    const state = this.get(sessionKey);
    if (
      !state ||
      state.gapChecked ||
      state.answeredAt === null ||
      now - state.answeredAt > FOLLOW_UP_WINDOW_MS ||
      now < state.answeredAt
    ) {
      return null;
    }
    return { ...state, answeredAt: state.answeredAt };
  }

  /**
   * The recurring-task answer the owner's next message may follow up on:
   * inside the window and its one gap check not spent. Null otherwise.
   */
  pendingAnswer(
    sessionKey: string | undefined | null,
    now: number = Date.now(),
  ): { taskSlug: string; ownerText: string; answerText: string; answeredAt: number } | null {
    const state = this.openAnswer(sessionKey, now);
    if (!state?.taskSlug) {
      return null;
    }
    return {
      taskSlug: state.taskSlug,
      ownerText: state.ownerText ?? "",
      answerText: state.answerText ?? "",
      answeredAt: state.answeredAt,
    };
  }

  /**
   * The answer to the owner's previous turn when that turn matched no task
   * type ("can you check the latest stats?"): the next message is checked as
   * a follow-up when it matches a recurring type by itself. Same window, same
   * one check. Null when the previous turn was typed, had no answer text, or
   * there was no previous turn (a message that opens a session is never a
   * follow-up).
   */
  pendingUntypedAnswer(
    sessionKey: string | undefined | null,
    now: number = Date.now(),
  ): {
    sessionId: string | null;
    ownerText: string;
    answerText: string;
    answeredAt: number;
  } | null {
    const state = this.openAnswer(sessionKey, now);
    if (!state || state.taskSlug || !state.ownerText?.trim() || !state.answerText?.trim()) {
      return null;
    }
    return {
      sessionId: state.sessionId,
      ownerText: state.ownerText,
      answerText: state.answerText,
      answeredAt: state.answeredAt,
    };
  }

  /** The recurring type of the last answered owner turn, while it is recent. */
  recentTaskSlug(
    sessionKey: string | undefined | null,
    now: number = Date.now(),
    windowMs: number = PRECEDING_TASK_WINDOW_MS,
  ): string | null {
    const state = this.get(sessionKey);
    if (!state?.taskSlug || state.answeredAt === null || now - state.answeredAt > windowMs) {
      return null;
    }
    return state.taskSlug;
  }

  /** A task type was merged or renamed. */
  repointTask(fromSlug: string, intoSlug: string): void {
    try {
      this.db
        .prepare(`UPDATE practice_session_state SET task_slug = ? WHERE task_slug = ?`)
        .run(intoSlug, fromSlug);
    } catch (err) {
      log.debug(`follow-up state repoint failed: ${String(err)}`);
    }
  }
}

// ── The owner's yes or no ───────────────────────────────────────────────────

const AFFIRMATIVE_RX =
  /^(?:y|yes|yep|yeah|yup|sure|absolutely|definitely|please do|do it|go ahead|sure thing)(?:,? (?:please|thanks|thank you|do it|do that|go ahead|every time|please do|include (?:it|them|that)(?: every time)?))?$/;
const NEGATIVE_RX =
  /^(?:n|no|nope|nah|don't|dont|do not|please don't|please dont|no need|never)(?:,? (?:thanks|thank you|please|don't|dont|need|need to))?$/;

/**
 * Is this message a bare yes or no? Tight on purpose: the whole message
 * (envelope and closing punctuation aside) must be one of a few short
 * forms. "yes but only weekly", "no, the endpoint is api2", "ok" (it may
 * acknowledge the answer, not the question) and "yes?" are null, and null
 * does nothing.
 */
export function parseOfferAnswer(text: string): "yes" | "no" | null {
  const cleaned = stripMessageEnvelope(text)
    .replace(/[‘’]/g, "'")
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 40) {
    return null;
  }
  if (AFFIRMATIVE_RX.test(cleaned)) {
    return "yes";
  }
  if (NEGATIVE_RX.test(cleaned)) {
    return "no";
  }
  return null;
}

// ── The follow-up check (one model call, or one section of the correction call) ──

export type FollowUpContext = {
  /** The recurring type a gap is attributed to. */
  taskSlug: string;
  taskLabel: string;
  /** The owner's request the answer was for. */
  previousOwnerMessage: string;
  /** The answer the follow-up may be pointing at a gap in. */
  previousAnswer: string;
  /**
   * What made this message a possible follow-up. `answer` (the default): the
   * previous owner turn was typed as the recurring task. `message`: that turn
   * matched no type and the follow-up itself matches the recurring type.
   */
  typedBy?: "answer" | "message";
};

export type FollowUpGap =
  | { kind: "gap"; statement: string }
  | { kind: "other" }
  /**
   * The model said `gap` but named one instance (a date, a number, "yesterday"):
   * a follow-up, not a new topic, and never a candidate.
   */
  | { kind: "specific"; statement: string };

const FOLLOW_UP_RULES = `- "gap": the follow-up asks for another metric, item, breakdown or time range of the same report or lookup, one the answer did not give ("how about our npm downloads", "what has the traffic been like the past few days?", "give me day by day clones and the npm downloads too"). It is still a gap when the assistant had offered that item at the end of its answer, and when it is "a different metric": a different metric of the same report is exactly what a gap is.
- "other": a different task, a reaction, thanks, a correction of a fact, a deeper question about something the answer did contain ("hmm, I wonder what drove the 68 unique clones"), or the whole request made again with other parameters (a new run of the task, not a missing part of this answer).
- For "gap", "missing" is one short imperative naming the missing element, starting with "Include" ("Include npm downloads"). Name the element with the words the owner used in the follow-up and nothing else: no dates and no numbers from this one instance.
- When unsure, answer "other".`;

function exchangeBlock(ctx: FollowUpContext, ownerMessage: string): string {
  const label = ctx.taskLabel || ctx.taskSlug.replace(/-/g, " ");
  const previous = ctx.previousOwnerMessage.slice(0, MAX_STATE_OWNER_CHARS);
  const answer = ctx.previousAnswer.slice(0, MAX_STATE_ANSWER_CHARS);
  const followUp = ownerMessage.slice(0, 1_000);
  return ctx.typedBy === "message"
    ? `Owner (request): ${previous}
Assistant (the answer): ${answer}
Owner (follow-up; it reads like "${label}", a request the owner makes regularly): ${followUp}`
    : `Owner (recurring request, "${label}"): ${previous}
Assistant (the answer): ${answer}
Owner (follow-up): ${followUp}`;
}

/** The stand-alone prompt, used when the correction pre-filter did not fire on this turn. */
export function buildFollowUpGapPrompt(ctx: FollowUpContext, ownerMessage: string): string {
  return `The owner of an assistant made a request${ctx.typedBy === "message" ? "" : " they make regularly"}, the assistant answered, and the owner then sent a follow-up. Decide whether the follow-up asks for something the answer should have contained.

## Rules
${FOLLOW_UP_RULES}

## Output Format
Respond with ONLY a JSON object (no markdown fences):
{"kind":"gap","missing":"Include npm downloads"}
or
{"kind":"other"}

## Exchange
${exchangeBlock(ctx, ownerMessage)}`;
}

/**
 * The same check as one more section of the correction prompt, so a turn
 * that earns both costs one call. The answer comes back under `follow_up`.
 */
export function buildFollowUpPromptSection(ctx: FollowUpContext, ownerMessage: string): string {
  return `

## Follow-up check
The user message above was the user's next message after the assistant answered ${ctx.typedBy === "message" ? "an earlier request" : "a request the user makes regularly"}. Decide whether it asks for something that earlier answer should have contained, and add one more top-level key to the JSON object you output:
"follow_up":{"kind":"gap","missing":"Include npm downloads"} or "follow_up":{"kind":"other"}
${FOLLOW_UP_RULES}

The earlier exchange:
${exchangeBlock(ctx, ownerMessage)}`;
}

const GAP_VERB_RX =
  /^(?:please\s+)?(?:always\s+)?(?:include|add|show|give|report|mention|provide|list)\s+(?:me\s+)?/i;

/** "Include npm downloads." -> "npm downloads": the missing element without the verb. */
export function gapElement(statement: string): string {
  return cleanPracticeStatement(statement)
    .replace(GAP_VERB_RX, "")
    .replace(/[.!\s]+$/g, "")
    .trim();
}

/** The content words of the missing element (the verb is ours, not the owner's). */
export function gapElementWords(statement: string): string[] {
  return contentWords(gapElement(statement));
}

const SPECIFIC_WORDS_RX =
  /\b(?:yesterday|today|tomorrow|tonight|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i;
/** A number or an ordinal ("24th", "7", "14-day"); a digit inside a name ("p95", "s3") is not one. */
const SPECIFIC_NUMBER_RX = /(?<![A-Za-z\d])\d/;

/**
 * Does a gap statement name one instance instead of a standing element: a
 * number or ordinal, a month or weekday name, or "yesterday / today /
 * tomorrow"? The prompt asks for none of these; this enforces it. ("May" is
 * not in the list: as a word it is far more often the verb.)
 */
export function isSpecificGapStatement(statement: string): boolean {
  return SPECIFIC_NUMBER_RX.test(statement) || SPECIFIC_WORDS_RX.test(statement);
}

/**
 * Parse the follow-up classification, stand-alone (`{"kind":..}`) or as the
 * `follow_up` key of the correction response. The answer is the first JSON
 * object in the response; prose around it is ignored, except that a `gap`
 * followed by a retraction ("Wait, let me reconsider ...") is unusable.
 * Fail-closed: anything unusable is null, and a `gap` without a usable
 * statement is null too. A statement that does not open with an instruction
 * verb gets "Include". A `gap` whose statement names one instance (a date, a
 * number) comes back as `specific`.
 */
export function parseFollowUpGap(raw: string): FollowUpGap | null {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted) {
    return null;
  }
  const parsed = extracted.value;
  const node =
    parsed.follow_up && typeof parsed.follow_up === "object"
      ? (parsed.follow_up as Record<string, unknown>)
      : parsed;
  const kind = typeof node.kind === "string" ? node.kind.trim().toLowerCase() : "";
  if (kind === "other") {
    return { kind: "other" };
  }
  if (kind !== "gap" || typeof node.missing !== "string" || hasRetraction(extracted.rest)) {
    return null;
  }
  let statement = cleanPracticeStatement(node.missing);
  if (!statement) {
    return null;
  }
  if (!GAP_VERB_RX.test(statement)) {
    statement = `Include ${statement}`;
  }
  statement = statement.charAt(0).toUpperCase() + statement.slice(1);
  if (practiceStatementRejection(statement) || gapElementWords(statement).length === 0) {
    return null;
  }
  return { kind: isSpecificGapStatement(statement) ? "specific" : "gap", statement };
}

const TYPO_MIN_WORD_CHARS = 5;

/** One insertion, deletion, substitution or swap of neighbours apart ("vistor", "visitor"). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) {
    return false;
  }
  let i = 0;
  while (i < short.length && short[i] === long[i]) {
    i += 1;
  }
  if (short.length === long.length) {
    return (
      short.slice(i + 1) === long.slice(i + 1) ||
      (short[i] === long[i + 1] &&
        short[i + 1] === long[i] &&
        short.slice(i + 2) === long.slice(i + 2))
    );
  }
  return short.slice(i) === long.slice(i + 1);
}

/**
 * Is this word of a gap statement in the owner's prose? Exactly, or one edit
 * away for words of TYPO_MIN_WORD_CHARS letters or more: the owner types
 * "vistors", the model writes "visitors", and it is still the owner's word.
 */
function ownerSaid(prose: ReadonlySet<string>, word: string): boolean {
  if (prose.has(word)) {
    return true;
  }
  if (word.length < TYPO_MIN_WORD_CHARS) {
    return false;
  }
  for (const said of prose) {
    if (said.length >= TYPO_MIN_WORD_CHARS && withinOneEdit(said, word)) {
      return true;
    }
  }
  return false;
}

/**
 * The grounding rule for a gap statement: more than half of the element's
 * content words are in the owner's own prose (the caller passes prose: code,
 * quotes and pasted blocks already stripped). The Phase 1 content-word rule,
 * applied to the element: the leading "Include" is generated, so it is not
 * asked of the owner. A longer word one typo away from the owner's counts.
 */
export function isGapGrounded(ownerProse: string, statement: string): boolean {
  const wanted = gapElementWords(statement);
  if (wanted.length === 0) {
    return false;
  }
  const prose = new Set(contentWords(ownerProse));
  const present = wanted.filter((word) => ownerSaid(prose, word)).length;
  return present / wanted.length > 0.5;
}

/**
 * Are two gap statements the same missing element? The Phase 1
 * near-duplicate rule, or one element's content words contained in the
 * other's ("Include npm" and "Include npm downloads"). The containment is
 * for follow-up candidates only: the owner confirms the wording before
 * anything is applied.
 */
export function areGapStatementsMatching(a: string, b: string): boolean {
  if (arePracticesNearDuplicate(a, b)) {
    return true;
  }
  const wa = new Set(gapElementWords(a));
  const wb = new Set(gapElementWords(b));
  if (wa.size === 0 || wb.size === 0) {
    return false;
  }
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const word of small) {
    if (!large.has(word)) {
      return false;
    }
  }
  return true;
}

// ── Candidates ──────────────────────────────────────────────────────────────

export type GapSightingInput = {
  store: PracticesStore;
  taskSlug: string;
  statement: string;
  /** The owner's follow-up, prose only. */
  ownerProse: string;
  evidenceRef: string | null;
  /** The session the follow-up was in (transcript identity). */
  sessionId: string;
  /** The owner's words were an explicit instruction ("give me X too"). */
  explicit: boolean;
  origin: Extract<PracticeOrigin, "follow_up" | "backfill">;
  /** What else the turn makes visible (the active project), for the repeat check. */
  activeProject?: string | null;
  /** When the follow-up was sent (the backfill passes the transcript time). */
  sightedAt?: number;
  now?: number;
};

export type GapSightingResult =
  /** Stored as a new candidate, or added as a sighting to an existing one. */
  | { kind: "candidate"; op: "add" | "strengthen"; practice: Practice }
  /** An active practice already says this: the owner had to ask again. */
  | { kind: "repeat"; practice: Practice }
  /** The owner declined or retired this before. */
  | { kind: "refused" }
  /** The statement's element is not in the owner's words. */
  | { kind: "ungrounded" }
  | { kind: "rejected"; reason: string };

/**
 * Record one detected gap. Synchronous; the caller serialises it with the
 * other memory writes. See the module header for the rules.
 */
export function recordGapSighting(input: GapSightingInput): GapSightingResult {
  const { store } = input;
  const now = input.now ?? Date.now();
  const scope = `task:${input.taskSlug}`;
  const grounded = isGapGrounded(input.ownerProse, input.statement);
  const prose = new Set(contentWords(input.ownerProse));
  // An existing row counts as "this gap again" when the statements match and
  // either the new statement is grounded or the owner's words name part of
  // the stored element (which was grounded when it was stored).
  const sameGap = (p: Practice) =>
    areGapStatementsMatching(p.statement, input.statement) &&
    (grounded || gapElementWords(p.statement).some((word) => prose.has(word)));

  const visible: ScopeContext = { taskSlug: input.taskSlug, activeProject: input.activeProject };
  const active = store.listVisible(visible).find(sameGap);
  if (active) {
    store.recordRepeat(active.id, { sessionRef: input.evidenceRef, via: "follow_up", now });
    return { kind: "repeat", practice: active };
  }
  const atScope = store.list({ scope }).filter(sameGap);
  if (atScope.some((p) => p.status === "suppressed" || p.status === "retired")) {
    return { kind: "refused" };
  }
  const sighting = {
    sighting: {
      sessionId: input.sessionId,
      day: practiceDayKey(input.sightedAt ?? now),
      explicit: input.explicit,
    },
  };
  const candidate = atScope.find((p) => p.status === "candidate");
  if (candidate) {
    const practice = store.addSighting(candidate.id, {
      evidenceRef: input.evidenceRef,
      detail: sighting,
      now,
    });
    return practice
      ? { kind: "candidate", op: "strengthen", practice }
      : { kind: "rejected", reason: "the candidate is gone" };
  }
  if (!grounded) {
    return { kind: "ungrounded" };
  }
  const res = store.upsert({
    statement: input.statement,
    scope,
    // Below the owner tier on purpose: a candidate until the owner says yes.
    source: "extraction",
    origin: input.origin,
    evidenceRef: input.evidenceRef,
    eventDetail: sighting,
    now,
  });
  if (!res.ok) {
    // Includes the owner's standing no at another scope (upsert's stickiness).
    return /declined|retired/.test(res.reason)
      ? { kind: "refused" }
      : { kind: "rejected", reason: res.reason };
  }
  return { kind: "candidate", op: res.op === "add" ? "add" : "strengthen", practice: res.practice };
}

/** Sightings that differ in session or in day, and whether any was an explicit instruction. */
export function countIndependentSightings(
  store: PracticesStore,
  practiceId: string,
): { independent: number; explicit: boolean } {
  const sightings = store.sightings(practiceId);
  return {
    independent: new Set(sightings.map((s) => `${s.sessionId}|${s.day}`)).size,
    explicit: sightings.some((s) => s.explicit),
  };
}

/**
 * The one candidate at `task:<slug>` this reply may offer, or null: two
 * independent sightings or one explicit one, fewer than
 * MAX_OFFERS_PER_PRACTICE offers so far, and not yet offered in this
 * session. `preferId` (the candidate sighted on this turn) goes first, then
 * the most sighted.
 */
export function pickOffer(
  store: PracticesStore,
  params: { taskSlug: string; sessionId: string; preferId?: string | null },
): { practice: Practice; sightings: number } | null {
  const eligible: Array<{ practice: Practice; sightings: number }> = [];
  for (const practice of store.list({
    statuses: ["candidate"],
    scope: `task:${params.taskSlug}`,
  })) {
    if (
      practice.offerCount >= MAX_OFFERS_PER_PRACTICE ||
      store.offeredInSession(practice.id, params.sessionId)
    ) {
      continue;
    }
    const { independent, explicit } = countIndependentSightings(store, practice.id);
    if (independent >= 2 || (explicit && independent >= 1)) {
      eligible.push({ practice, sightings: independent });
    }
  }
  if (eligible.length === 0) {
    return null;
  }
  return (
    eligible.find((e) => e.practice.id === params.preferId) ??
    eligible.toSorted(
      (a, b) => b.sightings - a.sightings || a.practice.createdAt - b.practice.createdAt,
    )[0]!
  );
}

function clip(line: string): string {
  const points = Array.from(line.replace(/\s+/g, " ").trim());
  return points.length > MAX_OFFER_LINE_CHARS
    ? `${points.slice(0, MAX_OFFER_LINE_CHARS - 3).join("")}...`
    : points.join("");
}

/** The generated offer line. Never written by a model. */
export function formatOfferLine(params: {
  statement: string;
  taskLabel: string;
  sightings: number;
}): string {
  const thing = gapElement(params.statement) || `"${params.statement}"`;
  const label = params.taskLabel.trim() || "that request";
  const times =
    params.sightings >= 3 ? ` ${params.sightings} times` : params.sightings === 2 ? " twice" : "";
  return clip(
    times
      ? `You have asked for ${thing} after ${label}${times}. Include it every time? (yes / no)`
      : `You asked for ${thing} after ${label}. Include it every time? (yes / no)`,
  );
}

/** The generated line that reports the owner's answer to an offer. */
export function formatOfferAnswerLine(params: {
  kind: "confirmed" | "declined";
  statement: string;
  taskLabel: string;
}): string {
  return params.kind === "confirmed"
    ? clip(`Practice saved for ${params.taskLabel.trim() || "that request"}: "${params.statement}"`)
    : "Understood, I will not ask again.";
}

/**
 * The note for the agent on the turn whose message answered an offer. The
 * offer and its answer line are generated outside the model (on the desktop
 * chat the offer is also in the transcript, on a channel it is not), so
 * without this the agent sees a bare "yes" with no question before it. The
 * note names exactly what was offered and what the answer did: a "no" to one
 * candidate must never be reported as dropping another practice.
 */
export function formatOfferAnswerNote(params: {
  kind: "confirmed" | "declined";
  statement: string;
  taskLabel: string;
}): string {
  const label = params.taskLabel.trim() || "a recurring request";
  const outcome =
    params.kind === "confirmed"
      ? `The owner said yes. The system saved "${params.statement}" as a standing practice for ${label}; it applies from now on.`
      : `The owner said no. The system dropped the proposal "${params.statement}" for ${label} and will not offer it again. It was only a proposal and was never in effect.`;
  return [
    "## Practice offer answered",
    `After your previous reply the system (not you) asked the owner one question: whether to make "${params.statement}" a standing practice for ${label}.`,
    `The owner's message this turn answers only that question. ${outcome}`,
    "No other practice changed: every standing practice listed in your instructions is still in effect exactly as before.",
    "The system adds its own confirmation line after your reply. Acknowledge in one short sentence. Do not treat the message as a new request, do not restate or change any other practice, do not claim that you saved, dropped or changed anything yourself, and do not repeat the confirmation.",
  ].join("\n");
}
