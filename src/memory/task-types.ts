/**
 * PLAN-64 Phase 1: recurring task types.
 *
 * Phase 0 found that 42% of the owner's real messages are one recurring
 * request (repo and npm stats) asked in near-identical words. A task type is
 * that kind of request: a slug, a label and a few exemplar texts. A practice
 * scoped `task:<slug>` is rendered only on turns typed as that task.
 *
 * Typing is word overlap, no model call: an owner turn's content words
 * (lowercased, stopwords dropped, lightly stemmed, the channel's
 * `[Day YYYY-MM-DD HH:MM TZ]` envelope stripped) are compared with each
 * stored exemplar's by overlap coefficient. Every typed owner turn is
 * recorded (`observe`): it joins the best matching type or starts a pending
 * one. A type becomes `recurring` at RECURRING_MIN_OCCURRENCES occurrences on
 * RECURRING_MIN_DAYS distinct days, and only recurring types are returned to
 * callers. Its slug and label are generated once, by one injected cheap-model
 * call, with a deterministic fallback from its most frequent content words.
 *
 * Limits, stated plainly: this is lexical. Two requests for the same thing
 * in different words do not cluster, and two different requests that share
 * their content words do. Pending types are capped and the least recently
 * seen are dropped. All work is bounded by those caps (a few hundred short
 * word sets per turn), so `observe` and `classify` are synchronous.
 *
 * PLAN-64 Phase 1b, because a replay of the owner's real messages split one
 * task into three types:
 * - Merge at naming time. The one naming call is shown the label and up to
 *   four exemplars of each existing recurring type, is told which of them
 *   shares the most exemplar words with the new one (a hint), and may answer
 *   `same_as` instead of a new name; the pending type is then folded into that type
 *   (`merge`). The owner can merge two types by hand as well. Without a model
 *   nothing is merged automatically.
 * - A follow-up does not found a type. The owner's next turn after a
 *   recurring-task answer that does not match a recurring type on its own
 *   is not counted (`deferred`); the caller counts it later only when the
 *   follow-up check says it was a new topic. Likewise a turn that matches a
 *   recurring type right after an untyped request is typed but not counted
 *   until the check says it was not the missing part of that request.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeScopeName } from "./canonical-facts.js";
import { extractFirstJsonObject } from "./model-json.js";

const log = createSubsystemLogger("memory/task-types");

export const RECURRING_MIN_OCCURRENCES = 3;
export const RECURRING_MIN_DAYS = 3;
/** Overlap coefficient (shared words / smaller set) a turn needs to join a type. */
export const TASK_MATCH_THRESHOLD = 0.6;
/** Shared content words a match needs, whatever the ratio. */
const TASK_MATCH_MIN_SHARED = 2;
const MIN_CONTENT_WORDS = 2;
/** Longer messages are briefs or pastes, not a recurring short request. */
const MAX_CONTENT_WORDS = 24;
const MAX_TYPING_CHARS = 600;
const MAX_EXEMPLARS = 8;
const MAX_EXEMPLAR_CHARS = 200;
/** A merged type keeps more exemplars, so the folded-in phrasings still match. */
const MAX_MERGED_EXEMPLARS = 16;
/** Exemplars of the folded-in type that survive a merge whatever the target holds. */
const MERGE_KEPT_FROM = 4;
/** Existing recurring types shown to the naming call. */
const MAX_NAMING_EXISTING_TYPES = 20;
/** Exemplars of each existing type the naming call is shown. */
const MAX_NAMING_EXISTING_EXEMPLARS = 4;
/** Shared exemplar content words an existing type needs to be pointed out to the naming call. */
const NAMING_HINT_MIN_SHARED = 2;
/** ... and the share of the smaller of the two word sets they must make up. */
const NAMING_HINT_MIN_SHARE = 0.2;
export const MAX_PENDING_TYPES = 150;
const PENDING_PREFIX = "pending-";
const LABEL_TIMEOUT_MS = 8_000;

const STOPWORDS = new Set(
  (
    "a an the and or but if then so of to in on at for from by with about into over as is are was were be been being am " +
    "do does did doing done have has had having i me my mine we us our ours you your yours he him his she her hers it its " +
    "they them their this that these those there here what which who whom whose when where why how many much can could " +
    "would should will shall may might must please hey hi hello thanks thank ok okay yes no not just also very really " +
    "get got give gave tell show make made let lets want need like know think see look some any all more most again now " +
    "up out off s t d ll re ve m im ive dont cant whats thats"
  ).split(" "),
);

/** `[Fri 2026-11-27 09:14 EST]` (and the bracketed variants the channels use) at the start. */
const ENVELOPE_RX =
  /^\s*\[[^\]\n]{0,40}\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?[^\]\n]{0,24}\]\s*/;

/** Drop the leading timestamp envelope the channels prepend to a message. */
export function stripMessageEnvelope(text: string): string {
  let out = text;
  for (let i = 0; i < 3 && ENVELOPE_RX.test(out); i++) {
    out = out.replace(ENVELOPE_RX, "");
  }
  return out;
}

/** Light stemming: possessive, plural, -ing, -ed. Enough for "clones" = "clone". */
export function stemWord(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  if (w.length > 5 && w.endsWith("ing")) {
    w = w.slice(0, -3);
  } else if (w.length > 4 && w.endsWith("ed")) {
    w = w.slice(0, -2);
  } else if (w.length > 3 && w.endsWith("es") && /(s|x|z|ch|sh)es$/.test(w)) {
    w = w.slice(0, -2);
  } else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) {
    w = w.slice(0, -1);
  }
  return w;
}

/**
 * The content words of a text, in order, without duplicates: lowercased,
 * envelope and punctuation dropped, possessives cut, stopwords removed,
 * lightly stemmed. Shared by task typing and practice matching.
 */
export function contentWords(text: string): string[] {
  const cleaned = stripMessageEnvelope(text)
    .slice(0, 4_000)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cleaned.split(" ")) {
    if (!raw || STOPWORDS.has(raw)) {
      continue;
    }
    const stem = stemWord(raw);
    if (stem.length < 2 || STOPWORDS.has(stem) || seen.has(stem)) {
      continue;
    }
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

/** Shared words over the smaller set; 0 when fewer than `minShared` are shared. */
export function overlapCoefficient(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
  minShared = TASK_MATCH_MIN_SHARED,
): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) {
    if (large.has(word)) {
      shared += 1;
    }
  }
  return shared < minShared ? 0 : shared / small.size;
}

export type TaskType = {
  slug: string;
  label: string;
  exemplars: string[];
  occurrences: number;
  distinctDays: number;
  firstSeen: number;
  lastSeen: number;
  recurring: boolean;
};

type Row = {
  slug: string;
  label: string;
  exemplars: string;
  occurrences: number;
  distinct_days: number;
  first_seen: number;
  last_seen: number;
  recurring: number;
};

const COLUMNS =
  "slug, label, exemplars, occurrences, distinct_days, first_seen, last_seen, recurring";

function parseExemplars(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

const rowToType = (row: Row): TaskType => ({
  slug: row.slug,
  label: row.label,
  exemplars: parseExemplars(row.exemplars),
  occurrences: row.occurrences,
  distinctDays: row.distinct_days,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  recurring: row.recurring === 1,
});

/** The calendar day of a timestamp on this machine (the owner's day, near enough). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** The text an exemplar keeps: prose, one line, capped. */
function exemplarText(text: string): string {
  return stripMessageEnvelope(text).replace(/\s+/g, " ").trim().slice(0, MAX_EXEMPLAR_CHARS);
}

/** Slug from the content words most exemplars share ("clone-repo-yesterday"). */
export function fallbackTaskSlug(exemplars: string[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const exemplar of exemplars) {
    for (const word of contentWords(exemplar)) {
      if (!counts.has(word)) {
        order.push(word);
      }
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const top = order
    .map((word, index) => ({ word, index, n: counts.get(word) ?? 0 }))
    .toSorted((a, b) => b.n - a.n || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.word);
  return normalizeScopeName(top.join("-")) ?? "task";
}

export type TaskLabelLlmCall = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

/** An existing recurring type as the naming call sees it. */
export type NamingExistingType = { slug: string; label: string; exemplars: string[] };

/**
 * The existing type whose exemplars share the most content words with the
 * new type's, or null when none shares enough (NAMING_HINT_MIN_SHARED words
 * making up NAMING_HINT_MIN_SHARE of the smaller word set). Deterministic;
 * it is shown to the naming call as a hint and decides nothing by itself.
 */
export function closestExistingType(
  exemplars: string[],
  existing: NamingExistingType[],
): { slug: string; shared: string[] } | null {
  const mine = new Set(exemplars.flatMap((e) => contentWords(e)));
  let best: { slug: string; shared: string[] } | null = null;
  for (const type of existing) {
    const theirs = new Set(type.exemplars.flatMap((e) => contentWords(e)));
    const shared = [...mine].filter((word) => theirs.has(word));
    const share = shared.length / Math.max(1, Math.min(mine.size, theirs.size));
    if (
      shared.length >= NAMING_HINT_MIN_SHARED &&
      share >= NAMING_HINT_MIN_SHARE &&
      shared.length > (best?.shared.length ?? 0)
    ) {
      best = { slug: type.slug, shared };
    }
  }
  return best;
}

export function buildTaskLabelPrompt(
  exemplars: string[],
  existing: NamingExistingType[] = [],
): string {
  const known = existing.slice(0, MAX_NAMING_EXISTING_TYPES);
  const closest = closestExistingType(exemplars, known);
  const knownBlock =
    known.length > 0
      ? `
Kinds of request that already have a name:
${known
  .map(
    (t) =>
      `- ${t.slug} (${t.label || t.slug.replace(/-/g, " ")}): ${t.exemplars
        .slice(0, MAX_NAMING_EXISTING_EXEMPLARS)
        .map((e) => JSON.stringify(e.slice(0, MAX_EXEMPLAR_CHARS)))
        .join("; ")}`,
  )
  .join("\n")}
${
  closest
    ? `
Of these, "${closest.slug}" shares the most words with the requests above (${closest.shared.slice(0, 6).join(", ")}). That is a hint, not a decision.
`
    : ""
}
Answer with the slug of one of these instead of a new name:
{"same_as":"${(closest ?? known[0]!).slug}"}
when the requests above would be answered by the same kind of report or lookup as that one, or are often asked in the same breath as it, even if they name a different metric or item of that report. Give a new name only when they are a different kind of task.
`
      : "";
  return `The owner of an assistant asks for the same kind of thing repeatedly. Name that kind of request.

Requests:
${exemplars
  .slice(0, MAX_EXEMPLARS)
  .map((e) => `- ${e}`)
  .join("\n")}
${knownBlock}
Respond with ONLY a JSON object (no markdown fences):
{"slug":"repo-stats","label":"repo stats"}
"slug": 1 to 3 lowercase words joined by hyphens. "label": the same in plain words, at most 4 words. Describe the kind of request, not one instance: no dates, no numbers, no names of people. Name the general task, not one metric or item of it ("repo stats", not "repository clone count").`;
}

export type TaskNaming =
  | { kind: "new"; slug: string; label: string }
  | { kind: "same"; slug: string };

/**
 * Parse the naming response when existing types were offered: `same_as`
 * counts only when it names one of the slugs that were shown (anything else
 * is ignored and the new name, if any, is used).
 */
export function parseTaskNamingResponse(
  raw: string,
  existingSlugs: ReadonlySet<string>,
): TaskNaming | null {
  const parsed = extractFirstJsonObject(raw)?.value;
  if (!parsed) {
    return null;
  }
  if (typeof parsed.same_as === "string") {
    const same = normalizeScopeName(parsed.same_as.trim().slice(0, 64));
    if (same && existingSlugs.has(same)) {
      return { kind: "same", slug: same };
    }
  }
  const named = parseTaskLabelResponse(raw);
  return named ? { kind: "new", ...named } : null;
}

/** Parse the labelling response. Null on anything unusable (the fallback is used then). */
export function parseTaskLabelResponse(raw: string): { slug: string; label: string } | null {
  const parsed = extractFirstJsonObject(raw)?.value;
  if (!parsed || typeof parsed.slug !== "string") {
    return null;
  }
  const slug = normalizeScopeName(parsed.slug.trim().slice(0, 40));
  if (!slug || slug.startsWith(PENDING_PREFIX) || !/[a-z]/.test(slug)) {
    return null;
  }
  const label =
    typeof parsed.label === "string" && parsed.label.trim()
      ? parsed.label.replace(/\s+/g, " ").trim().slice(0, 40)
      : slug.replace(/-/g, " ");
  return { slug, label };
}

export type TaskMatch = { type: TaskType; score: number };

export type ObserveResult = {
  /** The type this turn was counted under; null when the text is not typeable. */
  type: TaskType | null;
  /** True when this observation was a repeat of an already counted turn. */
  duplicate: boolean;
  /**
   * The type reached the recurring threshold on this turn and still carries
   * its pending slug: the caller should run `promote` (it names the type).
   */
  needsPromotion: boolean;
  /**
   * The turn was not counted because it may be a follow-up: it sits in the
   * follow-up window of a recurring-task answer and matched no recurring
   * type on its own (`type` is null), or it matches a recurring type and
   * follows an untyped request (`type` is that type). The caller counts it
   * later (`countDeferred`) when the follow-up check says it was not a gap.
   */
  deferred?: boolean;
};

export type TaskTypesStoreOptions = {
  /**
   * Called inside the merge transaction, after the type rows changed: the
   * place to re-point whatever is scoped to the merged or renamed slug.
   */
  onMerge?: (fromSlug: string, intoSlug: string) => void;
};

export type MergeResult = { ok: true; type: TaskType } | { ok: false; reason: string };

type SessionTurn = { turnKey: string; textHash: string; slug: string | null; at: number };

const MAX_TRACKED_SESSIONS = 200;
const MAX_TRACKED_TURN_KEYS = 500;
/** "The immediately preceding owner turn" stops counting after this long. */
const PRECEDING_TURN_WINDOW_MS = 30 * 60_000;

const textHash = (text: string): string =>
  crypto.createHash("sha256").update(contentWords(text).join(" ")).digest("hex").slice(0, 16);

export class TaskTypesStore {
  /** Turn keys already counted, so a retried run attempt is one occurrence. */
  private readonly seenTurnKeys = new Set<string>();
  /** The last two typed owner turns per session (in memory; lost on restart). */
  private readonly sessionTurns = new Map<string, SessionTurn[]>();
  private readonly promoting = new Set<string>();
  /** Deferred follow-up turns (`<sessionKey>|<text hash>`), until counted or forgotten. */
  private readonly deferredTurns = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: TaskTypesStoreOptions = {},
  ) {}

  list(opts: { recurringOnly?: boolean } = {}): TaskType[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM task_types ${opts.recurringOnly ? "WHERE recurring = 1" : ""}
           ORDER BY recurring DESC, last_seen DESC`,
        )
        .all() as unknown as Row[];
      return rows.map(rowToType);
    } catch (err) {
      log.debug(`task_types unavailable: ${String(err)}`);
      return [];
    }
  }

  get(slug: string): TaskType | null {
    try {
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM task_types WHERE slug = ?`).get(slug) as
        | Row
        | undefined;
      return row ? rowToType(row) : null;
    } catch {
      return null;
    }
  }

  /** The best matching type at or above the threshold, among `types`. */
  private bestMatch(words: ReadonlySet<string>, types: TaskType[]): TaskMatch | null {
    let best: TaskMatch | null = null;
    for (const type of types) {
      for (const exemplar of type.exemplars) {
        const score = overlapCoefficient(words, new Set(contentWords(exemplar)));
        if (
          score >= TASK_MATCH_THRESHOLD &&
          (!best ||
            score > best.score ||
            // A recurring type wins a tie with a pending one.
            (score === best.score && type.recurring && !best.type.recurring))
        ) {
          best = { type, score };
        }
      }
    }
    return best;
  }

  private typeableWords(text: string): Set<string> | null {
    const words = contentWords(text.slice(0, MAX_TYPING_CHARS));
    if (words.length < MIN_CONTENT_WORDS || words.length > MAX_CONTENT_WORDS) {
      return null;
    }
    return new Set(words);
  }

  /**
   * Read-only: the recurring task type this text belongs to, or null.
   * Pending types never match here, so nothing is scoped to a kind of
   * request the owner has not actually repeated.
   */
  classify(text: string): TaskType | null {
    const words = this.typeableWords(text);
    if (!words) {
      return null;
    }
    return this.bestMatch(words, this.list({ recurringOnly: true }))?.type ?? null;
  }

  /**
   * Count one owner turn. Joins the best matching type (recurring or
   * pending) or starts a pending one. `turnKey` (the run id) makes a
   * retried attempt count once; `sessionKey` records the turn for
   * `precedingRecurringType`. Never throws.
   */
  observe(
    text: string,
    opts: {
      now?: number;
      turnKey?: string;
      sessionKey?: string;
      /**
       * Slug of the recurring type whose answer this turn follows (same
       * session, inside the follow-up window). Set: a turn that matches no
       * recurring type on its own is deferred instead of counted.
       */
      followUpOf?: string | null;
      /**
       * The owner's previous turn in this session matched no type and its
       * answer is still open for a follow-up. Set: a turn that matches a
       * recurring type is typed as it (the practices of that type apply) but
       * not counted yet, because it may be a follow-up to that answer.
       */
      followsUntypedAnswer?: boolean;
    } = {},
  ): ObserveResult {
    const none: ObserveResult = { type: null, duplicate: false, needsPromotion: false };
    const now = opts.now ?? Date.now();
    try {
      if (opts.turnKey && this.seenTurnKeys.has(opts.turnKey)) {
        const type = this.classify(text);
        return { type, duplicate: true, needsPromotion: false };
      }
      const words = this.typeableWords(text);
      if (opts.turnKey) {
        this.rememberTurnKey(opts.turnKey);
      }
      if (!words) {
        this.rememberSessionTurn(opts.sessionKey, opts.turnKey, text, null, now);
        return none;
      }
      const match = this.bestMatch(words, this.list());
      if (opts.followUpOf && !match?.type.recurring) {
        // A follow-up never founds (or feeds) a type of its own.
        this.rememberSessionTurn(opts.sessionKey, opts.turnKey, text, null, now);
        this.defer(opts.sessionKey, text);
        return { ...none, deferred: true };
      }
      if (opts.followsUntypedAnswer && !opts.followUpOf && match?.type.recurring) {
        // It may be the missing part of the untyped request before it, not a
        // fresh occurrence: counted later, when the follow-up check says so.
        this.rememberSessionTurn(opts.sessionKey, opts.turnKey, text, match.type.slug, now);
        this.defer(opts.sessionKey, text);
        return { type: match.type, duplicate: false, needsPromotion: false, deferred: true };
      }
      const type = match ? this.bump(match.type, text, now) : this.insertPending(text, now);
      // The slug is kept even while the type is pending: it may be promoted
      // (and renamed) before the next turn asks what preceded it.
      this.rememberSessionTurn(opts.sessionKey, opts.turnKey, text, type.slug, now);
      const eligible =
        !type.recurring &&
        type.occurrences >= RECURRING_MIN_OCCURRENCES &&
        type.distinctDays >= RECURRING_MIN_DAYS;
      return { type, duplicate: false, needsPromotion: eligible };
    } catch (err) {
      log.debug(`task typing failed: ${String(err)}`);
      return none;
    }
  }

  private defer(sessionKey: string | undefined, text: string): void {
    this.deferredTurns.add(`${sessionKey ?? ""}|${textHash(text)}`);
    if (this.deferredTurns.size > MAX_TRACKED_TURN_KEYS) {
      const first = this.deferredTurns.values().next().value;
      if (first !== undefined) {
        this.deferredTurns.delete(first);
      }
    }
  }

  /**
   * The follow-up check said a deferred turn was a new topic after all:
   * count it now, as any other turn. A turn that was not deferred (or whose
   * deferral this process no longer remembers) is left alone, so nothing is
   * counted twice.
   */
  countDeferred(sessionKey: string | undefined, text: string, now: number = Date.now()): boolean {
    const key = `${sessionKey ?? ""}|${textHash(text)}`;
    if (!this.deferredTurns.delete(key)) {
      return false;
    }
    // A type that reaches the threshold here is named on its next turn
    // (`observe` reports `needsPromotion` for as long as it is eligible).
    return this.observe(text, { now }).type !== null;
  }

  /** A deferred turn turned out to be a follow-up: forget it without counting. */
  dropDeferred(sessionKey: string | undefined, text: string): void {
    this.deferredTurns.delete(`${sessionKey ?? ""}|${textHash(text)}`);
  }

  private bump(type: TaskType, text: string, now: number): TaskType {
    const exemplar = exemplarText(text);
    const exemplars = [...type.exemplars];
    const known = new Set(exemplars.map((e) => contentWords(e).join(" ")));
    if (
      exemplar &&
      exemplars.length < MAX_EXEMPLARS &&
      !known.has(contentWords(exemplar).join(" "))
    ) {
      exemplars.push(exemplar);
    }
    const newDay = dayKey(now) !== dayKey(type.lastSeen);
    this.db
      .prepare(
        `UPDATE task_types SET occurrences = occurrences + 1, distinct_days = distinct_days + ?,
           last_seen = ?, exemplars = ? WHERE slug = ?`,
      )
      .run(newDay ? 1 : 0, now, JSON.stringify(exemplars), type.slug);
    return {
      ...type,
      exemplars,
      occurrences: type.occurrences + 1,
      distinctDays: type.distinctDays + (newDay ? 1 : 0),
      lastSeen: now,
    };
  }

  private insertPending(text: string, now: number): TaskType {
    const type: TaskType = {
      slug: `${PENDING_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
      label: "",
      exemplars: [exemplarText(text)],
      occurrences: 1,
      distinctDays: 1,
      firstSeen: now,
      lastSeen: now,
      recurring: false,
    };
    this.db
      .prepare(`INSERT INTO task_types (${COLUMNS}) VALUES (?, ?, ?, 1, 1, ?, ?, 0)`)
      .run(type.slug, type.label, JSON.stringify(type.exemplars), now, now);
    // Keep the pending set bounded: the least recently seen go first.
    this.db
      .prepare(
        `DELETE FROM task_types WHERE recurring = 0 AND slug NOT IN (
           SELECT slug FROM task_types WHERE recurring = 0 ORDER BY last_seen DESC LIMIT ?)`,
      )
      .run(MAX_PENDING_TYPES);
    return type;
  }

  /**
   * Make an eligible pending type recurring under its final slug and label:
   * one cheap-model call when `llmCall` is given, the deterministic fallback
   * when it is not, fails, times out or returns something unusable. Returns
   * the recurring type, or null when the type is gone or not eligible.
   */
  async promote(pendingSlug: string, llmCall?: TaskLabelLlmCall | null): Promise<TaskType | null> {
    if (this.promoting.has(pendingSlug)) {
      return null;
    }
    this.promoting.add(pendingSlug);
    try {
      const before = this.get(pendingSlug);
      if (!before || before.recurring) {
        return before;
      }
      let named: TaskNaming | null = null;
      const existing = this.namingCandidates(pendingSlug);
      if (llmCall) {
        const abort = new AbortController();
        const timer = setTimeout(
          () => abort.abort(new Error("task label timed out")),
          LABEL_TIMEOUT_MS,
        );
        try {
          named = parseTaskNamingResponse(
            await llmCall(buildTaskLabelPrompt(before.exemplars, existing), {
              signal: abort.signal,
            }),
            new Set(existing.map((t) => t.slug)),
          );
        } catch (err) {
          log.debug(`task label call failed, using the fallback: ${String(err)}`);
        } finally {
          clearTimeout(timer);
        }
      }
      if (named?.kind === "same") {
        // Re-read: eligibility may have changed while the model was called.
        const now = this.get(pendingSlug);
        if (!now || now.recurring) {
          return now;
        }
        const merged = this.merge(pendingSlug, named.slug);
        if (merged.ok) {
          log.info(`task type folded into ${named.slug} at naming time (${pendingSlug})`);
          return merged.type;
        }
        return this.finalize(pendingSlug, null);
      }
      return this.finalize(pendingSlug, named ? { slug: named.slug, label: named.label } : null);
    } finally {
      this.promoting.delete(pendingSlug);
    }
  }

  /** The recurring types a naming call may fold a type into, most recently seen first. */
  private namingCandidates(exceptSlug: string): NamingExistingType[] {
    return this.list({ recurringOnly: true })
      .filter((t) => t.slug !== exceptSlug)
      .slice(0, MAX_NAMING_EXISTING_TYPES)
      .map((t) => ({ slug: t.slug, label: t.label, exemplars: t.exemplars }));
  }

  /**
   * Fold one task type into another: exemplars (bounded, the folded-in
   * type's first MERGE_KEPT_FROM always kept), occurrence counts and first
   * and last seen are combined, the `from` row is deleted, and `onMerge`
   * re-points what was scoped to it. One transaction. The result is
   * recurring when either type was.
   */
  merge(fromSlug: string, intoSlug: string): MergeResult {
    if (fromSlug === intoSlug) {
      return { ok: false, reason: "a task type cannot be merged into itself" };
    }
    try {
      this.db.exec("SAVEPOINT task_type_merge");
      try {
        const from = this.get(fromSlug);
        const into = this.get(intoSlug);
        if (!from || !into) {
          this.db.exec("RELEASE task_type_merge");
          return { ok: false, reason: `no task type named ${!from ? fromSlug : intoSlug}` };
        }
        const known = new Set(into.exemplars.map((e) => contentWords(e).join(" ")));
        const extra = from.exemplars.filter((e) => !known.has(contentWords(e).join(" ")));
        const keptFrom = Math.min(extra.length, MERGE_KEPT_FROM);
        const base = into.exemplars.slice(0, MAX_MERGED_EXEMPLARS - keptFrom);
        const exemplars = [...base, ...extra].slice(0, MAX_MERGED_EXEMPLARS);
        const firstSeen = Math.min(from.firstSeen, into.firstSeen);
        const lastSeen = Math.max(from.lastSeen, into.lastSeen);
        // Both types may have been seen on the same days: the sum is capped
        // by the days the merged type spans.
        const span = Math.floor((lastSeen - firstSeen) / 86_400_000) + 1;
        const merged: TaskType = {
          ...into,
          exemplars,
          occurrences: into.occurrences + from.occurrences,
          distinctDays: Math.max(
            into.distinctDays,
            Math.min(into.distinctDays + from.distinctDays, span),
          ),
          firstSeen,
          lastSeen,
          recurring: into.recurring || from.recurring,
          label: into.label || from.label,
        };
        this.db.prepare(`DELETE FROM task_types WHERE slug = ?`).run(fromSlug);
        this.db
          .prepare(
            `UPDATE task_types SET label = ?, exemplars = ?, occurrences = ?, distinct_days = ?,
               first_seen = ?, last_seen = ?, recurring = ? WHERE slug = ?`,
          )
          .run(
            merged.label,
            JSON.stringify(exemplars),
            merged.occurrences,
            merged.distinctDays,
            firstSeen,
            lastSeen,
            merged.recurring ? 1 : 0,
            intoSlug,
          );
        this.opts.onMerge?.(fromSlug, intoSlug);
        this.db.exec("RELEASE task_type_merge");
        this.repointSessionTurns(fromSlug, intoSlug);
        return { ok: true, type: merged };
      } catch (err) {
        this.db.exec("ROLLBACK TO task_type_merge");
        this.db.exec("RELEASE task_type_merge");
        throw err;
      }
    } catch (err) {
      log.debug(`task type merge failed: ${String(err)}`);
      return { ok: false, reason: "the task types could not be merged" };
    }
  }

  /**
   * Name an already recurring type again with the model (the backfill names
   * with the fallback first, so it can count before it spends): `same_as`
   * folds it into another recurring type, a new name renames it (and
   * `onMerge` re-points what was scoped to the old slug). Returns the type
   * as it now is; unchanged when there is no usable answer.
   */
  async relabel(
    slug: string,
    llmCall: TaskLabelLlmCall,
    opts: {
      /** Only these types are offered as a merge target (the backfill: the ones already named). */
      mergeInto?: ReadonlySet<string>;
    } = {},
  ): Promise<TaskType | null> {
    const before = this.get(slug);
    if (!before?.recurring) {
      return before;
    }
    const existing = this.namingCandidates(slug).filter(
      (t) => !opts.mergeInto || opts.mergeInto.has(t.slug),
    );
    let named: TaskNaming | null = null;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error("task label timed out")),
      LABEL_TIMEOUT_MS,
    );
    try {
      named = parseTaskNamingResponse(
        await llmCall(buildTaskLabelPrompt(before.exemplars, existing), { signal: abort.signal }),
        new Set(existing.map((t) => t.slug)),
      );
    } catch (err) {
      log.debug(`task relabel call failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!named || !this.get(slug)) {
      return this.get(slug);
    }
    if (named.kind === "same") {
      const merged = this.merge(slug, named.slug);
      return merged.ok ? merged.type : this.get(slug);
    }
    if (named.slug === slug || this.get(named.slug)) {
      // Same slug, or the new one is taken: keep the slug, take the label.
      this.db.prepare(`UPDATE task_types SET label = ? WHERE slug = ?`).run(named.label, slug);
      return this.get(slug);
    }
    try {
      this.db.exec("SAVEPOINT task_type_rename");
      try {
        this.db
          .prepare(`UPDATE task_types SET slug = ?, label = ? WHERE slug = ?`)
          .run(named.slug, named.label, slug);
        this.opts.onMerge?.(slug, named.slug);
        this.db.exec("RELEASE task_type_rename");
      } catch (err) {
        this.db.exec("ROLLBACK TO task_type_rename");
        this.db.exec("RELEASE task_type_rename");
        throw err;
      }
      this.repointSessionTurns(slug, named.slug);
      return this.get(named.slug);
    } catch (err) {
      log.debug(`task type rename failed: ${String(err)}`);
      return this.get(slug);
    }
  }

  /**
   * Take over a recurring type found elsewhere (the backfill's replay of old
   * transcripts): inserted when the slug is new here; when it already exists
   * only its exemplars are extended (bounded), counts are left alone.
   * Returns "added", "extended" or null when nothing changed.
   */
  adopt(type: TaskType): "added" | "extended" | null {
    try {
      const existing = this.get(type.slug);
      if (!existing) {
        this.db
          .prepare(`INSERT INTO task_types (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(
            type.slug,
            type.label,
            JSON.stringify(type.exemplars.slice(0, MAX_MERGED_EXEMPLARS)),
            type.occurrences,
            type.distinctDays,
            type.firstSeen,
            type.lastSeen,
          );
        return "added";
      }
      const known = new Set(existing.exemplars.map((e) => contentWords(e).join(" ")));
      const extra = type.exemplars.filter((e) => !known.has(contentWords(e).join(" ")));
      const exemplars = [...existing.exemplars, ...extra].slice(0, MAX_MERGED_EXEMPLARS);
      if (exemplars.length === existing.exemplars.length) {
        return null;
      }
      this.db
        .prepare(`UPDATE task_types SET exemplars = ? WHERE slug = ?`)
        .run(JSON.stringify(exemplars), type.slug);
      return "extended";
    } catch (err) {
      log.debug(`task type adopt failed: ${String(err)}`);
      return null;
    }
  }

  private repointSessionTurns(fromSlug: string, intoSlug: string): void {
    for (const turns of this.sessionTurns.values()) {
      for (const turn of turns) {
        if (turn.slug === fromSlug) {
          turn.slug = intoSlug;
        }
      }
    }
  }

  /** Synchronous promotion with the fallback name (no model available). */
  promoteWithFallback(pendingSlug: string): TaskType | null {
    return this.finalize(pendingSlug, null);
  }

  private finalize(
    pendingSlug: string,
    named: { slug: string; label: string } | null,
  ): TaskType | null {
    try {
      // Re-read: the type may have changed or gone while the model was called.
      const type = this.get(pendingSlug);
      if (!type) {
        return null;
      }
      if (
        type.recurring ||
        type.occurrences < RECURRING_MIN_OCCURRENCES ||
        type.distinctDays < RECURRING_MIN_DAYS
      ) {
        return type.recurring ? type : null;
      }
      const base = named?.slug ?? fallbackTaskSlug(type.exemplars);
      let slug = base;
      for (let n = 2; this.get(slug) && n < 50; n++) {
        slug = `${base}-${n}`.slice(0, 64);
      }
      const label = named?.label ?? base.replace(/-/g, " ");
      this.db
        .prepare(`UPDATE task_types SET slug = ?, label = ?, recurring = 1 WHERE slug = ?`)
        .run(slug, label, pendingSlug);
      this.repointSessionTurns(pendingSlug, slug);
      log.info(`task type is now recurring: ${slug} (${type.occurrences} occurrences)`);
      return { ...type, slug, label, recurring: true };
    } catch (err) {
      log.debug(`task type promotion failed: ${String(err)}`);
      return null;
    }
  }

  private rememberTurnKey(turnKey: string): void {
    this.seenTurnKeys.add(turnKey);
    if (this.seenTurnKeys.size > MAX_TRACKED_TURN_KEYS) {
      const first = this.seenTurnKeys.values().next().value;
      if (first !== undefined) {
        this.seenTurnKeys.delete(first);
      }
    }
  }

  private rememberSessionTurn(
    sessionKey: string | undefined,
    turnKey: string | undefined,
    text: string,
    slug: string | null,
    at: number,
  ): void {
    if (!sessionKey) {
      return;
    }
    const turns = this.sessionTurns.get(sessionKey) ?? [];
    turns.push({ turnKey: turnKey ?? "", textHash: textHash(text), slug, at });
    this.sessionTurns.delete(sessionKey);
    this.sessionTurns.set(sessionKey, turns.slice(-2));
    if (this.sessionTurns.size > MAX_TRACKED_SESSIONS) {
      const first = this.sessionTurns.keys().next().value;
      if (first !== undefined) {
        this.sessionTurns.delete(first);
      }
    }
  }

  /**
   * The recurring task type of the owner turn just before `currentText` in
   * this session, when it was observed in this process within the window.
   * Lets "give me npm too", said right after a repo-stats answer, be scoped
   * to repo stats. In memory only: a gateway restart forgets it.
   */
  precedingRecurringType(
    sessionKey: string | undefined,
    currentText: string,
    now: number = Date.now(),
  ): TaskType | null {
    if (!sessionKey) {
      return null;
    }
    const turns = this.sessionTurns.get(sessionKey) ?? [];
    const current = textHash(currentText);
    // The current turn is usually the newest entry (the prompt path observed
    // it before the reply); the one before it is the preceding turn.
    const last = turns.at(-1);
    const preceding = last && last.textHash === current ? turns.at(-2) : last;
    if (!preceding?.slug || now - preceding.at > PRECEDING_TURN_WINDOW_MS) {
      return null;
    }
    const type = this.get(preceding.slug);
    return type?.recurring ? type : null;
  }
}

/**
 * Count one owner turn and return the recurring type it belongs to (or
 * null). A type that reaches the threshold on this turn is named in the
 * background when a model is available (it is returned from the next turn
 * on), or at once with the fallback name when none is. Synchronous: no
 * model call is awaited on this path.
 */
export function observeOwnerTurn(
  store: TaskTypesStore,
  params: {
    text: string;
    sessionKey?: string;
    turnKey?: string;
    now?: number;
    /** See TaskTypesStore.observe: the recurring type whose answer this turn follows. */
    followUpOf?: string | null;
    /** See TaskTypesStore.observe. */
    followsUntypedAnswer?: boolean;
  },
  llmCall?: TaskLabelLlmCall | null,
): { slug: string; label: string } | null {
  const observed = store.observe(params.text, {
    turnKey: params.turnKey,
    sessionKey: params.sessionKey,
    now: params.now,
    followUpOf: params.followUpOf,
    followsUntypedAnswer: params.followsUntypedAnswer,
  });
  let type = observed.type;
  if (type && observed.needsPromotion) {
    if (llmCall) {
      void store
        .promote(type.slug, llmCall)
        .catch((err) => log.debug(`task type promotion failed: ${String(err)}`));
    } else {
      type = store.promoteWithFallback(type.slug) ?? type;
    }
  }
  return type?.recurring ? { slug: type.slug, label: type.label } : null;
}
