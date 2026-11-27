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
 * practice was in the prompt of this run. Nothing here checks whether the
 * answer followed it, and the line does not say so.
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
import type { Practice, PracticesStore } from "./practices.js";

const log = createSubsystemLogger("memory/practice-attribution");

/** A practice is named this many times, then stays silent. */
export const ATTRIBUTION_MAX_SHOWN = 2;
/** And this many more times after the owner rewords or re-scopes it. */
export const ATTRIBUTION_SHOWN_AFTER_CHANGE = 1;
const MAX_LINE_CHARS = 280;
const MAX_STATEMENT_CHARS_IN_LINE = 160;

/**
 * The scopes whose match is specific to the turn. `job:` waits for the cron
 * phase. `person:` is left out: person scopes are not routed (they render on
 * every owner turn), so naming one would credit it on turns it has nothing
 * to do with.
 */
function isAttributableScope(scope: string): boolean {
  return scope.startsWith("task:") || scope.startsWith("project:");
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
  practice: Practice;
  /** Other practices that also qualified on this run (not named, not counted as shown). */
  more: number;
};

/**
 * The practice to name for this run, or null. Read-only: `sessionRef` is the
 * `session:<file>` ref the prompt path wrote on the run's `applied` events,
 * `since` the moment the run started.
 */
export function pickAttribution(
  store: Pick<PracticesStore, "appliedInRun" | "attributionState">,
  params: { sessionRef: string; since: number },
): AttributionPick | null {
  const qualifying = store
    .appliedInRun(params)
    .filter((p) => isAttributableScope(p.scope))
    .filter((p) => attributionAllowed(store.attributionState(p.id)));
  const first = qualifying[0];
  return first ? { practice: first, more: qualifying.length - 1 } : null;
}

/**
 * Pick, record and format in one step. Returns the line, or null when no
 * practice qualifies. The named practice gets one `attributed` event; the
 * ones only counted in "and N more" do not, so each is still named later.
 * Never throws.
 */
export function resolveAttributionLine(
  store: Pick<
    PracticesStore,
    "appliedInRun" | "attributionState" | "recordAttribution" | "savedAt"
  >,
  params: {
    /** The run's session file (the prompt path refs it as `session:<file>`). */
    sessionFile?: string;
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
    const pick = pickAttribution(store, { sessionRef, since: params.since });
    if (!pick) {
      return null;
    }
    const { practice } = pick;
    const now = params.now ?? Date.now();
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
