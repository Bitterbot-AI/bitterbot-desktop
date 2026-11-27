/**
 * PLAN-64 Phase 3: the use-time attribution line.
 *
 * When the prompt of an owner turn carried a practice through a real scope
 * match (a task type, a project or a person; never `global`, never the
 * conditional fallback lines, which write no `applied` event), the reply may
 * end with one generated line:
 *
 *   Applied: "Include npm downloads" for repo stats, from 12 Nov.
 *
 * "Applied" has the meaning documented in docs/memory/practices.md: the
 * practice was in the prompt of this run AND more than half of its content
 * words are in the answer (a word match, no model). A practice that was in
 * the prompt and does not show in the answer gets no line, keeps its
 * showings, and gets a `not_followed` event instead.
 *
 * Rules: a practice is named the first two times, and once more after the
 * owner rewords or re-scopes it. One line per reply; when several practices
 * qualify the most specific one is named and the rest are counted ("and 2
 * more"). The count of times shown is the number of `attributed` events, so
 * it survives a gateway restart. The caller decides who gets a line at all
 * (direct owner chats only) and drops it when the reply already carries a
 * "Memory updated", "Practice saved" or offer line.
 *
 * No model call anywhere on this path.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { describePracticeScope } from "./correction-capture.js";
import { countElementWordsIn, namesAnswerContent } from "./practice-followups.js";
import type { Practice, PracticesStore } from "./practices.js";

const log = createSubsystemLogger("memory/practice-attribution");

/** A practice is named this many times, then stays silent. */
export const ATTRIBUTION_MAX_SHOWN = 2;
/** And this many more times after the owner rewords or re-scopes it. */
export const ATTRIBUTION_SHOWN_AFTER_CHANGE = 1;
const MAX_LINE_CHARS = 280;
const MAX_STATEMENT_CHARS_IN_LINE = 160;

/**
 * The scopes whose match is specific to the turn. `job:` practices render
 * in a cron job's own session only, whose report gets the canary line
 * (practice-jobs.ts) and never this one. `person:` is left out: person scopes are not routed (they render on
 * every owner turn), so naming one would credit it on turns it has nothing
 * to do with.
 */
function isAttributableScope(scope: string): boolean {
  return scope.startsWith("task:") || scope.startsWith("project:");
}

/**
 * A practice that says what to leave out or stop doing. Its words being
 * absent from an answer is what following it looks like, so a word match
 * cannot tell either way.
 */
export const PROHIBITION_RX =
  /^(?:please\s+)?(?:always\s+)?(?:do\s+not|don['\u2019]?t|never|stop|no\s+need|avoid|skip|omit|exclude|drop|remove|leave\s+out|without)\b/i;

/** Does the statement tell the agent NOT to do something? */
export function isProhibition(statement: string): boolean {
  return PROHIBITION_RX.test(statement.trim());
}

export type PracticeFollowed = "followed" | "not_followed" | "unknown";

/**
 * Does the answer show the practice? A word match, no model and no
 * judgement, and deliberately cautious in both directions:
 * - `followed`: more than half of the practice's content words (the
 *   statement without its leading instruction verb) are in the answer text,
 *   with the typo tolerance the grounding rule uses. An answer that says "no
 *   traffic data today" counts.
 * - `not_followed`: none of them is, and the practice names content for the
 *   answer ("Include npm downloads", "Show the unique counts").
 * - `unknown`: everything in between. Some of the words are there but not
 *   most (a real case: "Include unique counts every time you report repo
 *   traffic" and the answer "Clones: 379 (45 unique)"); or the practice is
 *   about manner ("Keep answers short"), so its words were never going to be
 *   in the answer; or it says what to leave out, where absent words are what
 *   following it looks like.
 */
export function practiceFollowedIn(replyText: string, statement: string): PracticeFollowed {
  const { present, wanted } = countElementWordsIn(replyText, statement);
  if (PROHIBITION_RX.test(statement.trim()) || wanted === 0) {
    return "unknown";
  }
  if (present / wanted > 0.5) {
    return "followed";
  }
  return present === 0 && namesAnswerContent(statement) ? "not_followed" : "unknown";
}

/** May the line still be shown for this practice? */
export function attributionAllowed(state: {
  shown: number;
  shownSinceChange: number;
  changedAt: number | null;
}): boolean {
  if (state.shown < ATTRIBUTION_MAX_SHOWN) {
    return true;
  }
  return state.changedAt !== null && state.shownSinceChange < ATTRIBUTION_SHOWN_AFTER_CHANGE;
}

/**
 * A short day for the owner ("12 Nov"), in their timezone. The year is added
 * when it is not the current one. Null when the timezone cannot be used.
 */
export function formatPracticeDay(ts: number, timeZone: string, now: number = Date.now()): string {
  const day = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).format(new Date(ts));
  try {
    const year = (t: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" }).format(new Date(t));
    return year(ts) === year(now)
      ? day({ day: "numeric", month: "short" })
      : day({ day: "numeric", month: "short", year: "numeric" });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
      new Date(ts),
    );
  }
}

function clipStatement(statement: string): string {
  const flat = statement.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const points = Array.from(flat);
  return points.length > MAX_STATEMENT_CHARS_IN_LINE
    ? `${points.slice(0, MAX_STATEMENT_CHARS_IN_LINE - 3).join("")}...`
    : flat;
}

/** The generated line. `more` is the number of other practices that also qualified. */
export function formatAttributionLine(params: {
  statement: string;
  scope: string;
  taskLabel?: string;
  savedAt: number;
  more: number;
  timeZone: string;
  now?: number;
}): string {
  const where = describePracticeScope(params.scope, params.taskLabel);
  const from = formatPracticeDay(params.savedAt, params.timeZone, params.now);
  const more = params.more > 0 ? `, and ${params.more} more` : "";
  const line = `Applied: "${clipStatement(params.statement)}" for ${where}, from ${from}${more}.`;
  const points = Array.from(line);
  return points.length > MAX_LINE_CHARS
    ? `${points.slice(0, MAX_LINE_CHARS - 3).join("")}...`
    : line;
}

export type AttributionPick = {
  /** The practice to name, or null when none qualifies. */
  practice: Practice | null;
  /** Other practices that also qualified on this run (not named, not counted as shown). */
  more: number;
  /** Scoped practices of this run whose content words are not in the answer. */
  notFollowed: Practice[];
};

/**
 * The practice to name for this run, and the ones the answer did not show.
 * Read-only: `sessionRef` is the `session:<file>` ref the prompt path wrote
 * on the run's `applied` events, `since` the moment the run started. A
 * practice is named only when the answer shows it (`practiceFollowedIn`).
 */
export function pickAttribution(
  store: Pick<PracticesStore, "appliedInRun" | "attributionState">,
  params: { sessionRef: string; since: number; replyText: string },
): AttributionPick {
  const scoped = store.appliedInRun(params).filter((p) => isAttributableScope(p.scope));
  const verdicts = new Map(
    scoped.map((p) => [p.id, practiceFollowedIn(params.replyText, p.statement)]),
  );
  const qualifying = scoped
    .filter((p) => verdicts.get(p.id) === "followed")
    .filter((p) => attributionAllowed(store.attributionState(p.id)));
  return {
    practice: qualifying[0] ?? null,
    more: Math.max(0, qualifying.length - 1),
    notFollowed: scoped.filter((p) => verdicts.get(p.id) === "not_followed"),
  };
}

/**
 * Pick, record and format in one step. Returns the line, or null when no
 * practice qualifies. Scoped practices the answer does not show get a
 * `not_followed` event each. The named practice gets one `attributed` event; the
 * ones only counted in "and N more" do not, so each is still named later.
 * Never throws.
 */
export function resolveAttributionLine(
  store: Pick<
    PracticesStore,
    "appliedInRun" | "attributionState" | "recordAttribution" | "recordNotFollowed" | "savedAt"
  >,
  params: {
    /** The run's session file (the prompt path refs it as `session:<file>`). */
    sessionFile?: string;
    /** The answer of this run: a practice is named only when its words are in it. */
    replyText: string;
    /** When the run started. */
    since: number;
    /** `task:<slug>` scopes are shown by their label. */
    taskLabel?: (slug: string) => string | undefined;
    timeZone: string;
    now?: number;
  },
): string | null {
  if (!params.sessionFile) {
    return null;
  }
  try {
    const sessionRef = `session:${params.sessionFile}`;
    const pick = pickAttribution(store, {
      sessionRef,
      since: params.since,
      replyText: params.replyText,
    });
    const now = params.now ?? Date.now();
    for (const ignored of pick.notFollowed) {
      // No line and no showing used up: the practice was in the prompt and
      // the answer does not show it. Counted, nothing else.
      store.recordNotFollowed(ignored.id, { sessionRef, via: "reply", now });
    }
    const { practice } = pick;
    if (!practice) {
      return null;
    }
    if (!store.recordAttribution(practice.id, { sessionRef, now })) {
      // Not counted, so not shown: an uncounted line would repeat for ever.
      return null;
    }
    return formatAttributionLine({
      statement: practice.statement,
      scope: practice.scope,
      taskLabel: practice.scope.startsWith("task:")
        ? params.taskLabel?.(practice.scope.slice("task:".length))
        : undefined,
      savedAt: store.savedAt(practice.id) ?? practice.createdAt,
      more: pick.more,
      timeZone: params.timeZone,
      now,
    });
  } catch (err) {
    log.debug(`practice attribution failed: ${String(err)}`);
    return null;
  }
}
