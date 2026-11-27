/**
 * PLAN-64 Phase 5: scheduled jobs that learn from the owner's corrections.
 *
 * 1. Announcement record. When an isolated cron job's report is announced to
 *    the owner, one row is written to `practice_job_announcements`: which
 *    job, the conversation it was announced in (the agent's main session),
 *    when, an excerpt of the job's instruction and of its report, and the
 *    practices whose "Changed since last time" line that run consumed.
 *    Persisted, so a gateway restart between the report and the owner's
 *    reply loses nothing.
 * 2. Job link. The owner's NEXT message in that conversation, within
 *    JOB_LINK_WINDOW_MS, with no other owner turn in between, is "about that
 *    job": the correction pass may store an explicit instruction at
 *    `job:<jobId>`, and the follow-up check runs with the report in the
 *    role of the previous answer. Every owner turn consumes the pending
 *    announcement of its conversation, whatever the turn was about. When an
 *    answer to a later owner turn exists, that answer wins and there is no
 *    link.
 * 3. Canary. The first run after a `job:` practice was saved or changed
 *    carries one generated line naming it. When the owner's next message
 *    contradicts that practice, it is retired with reason `rolled_back`.
 *    The same instruction said again is counted as a repeat and kept.
 *
 * EXTENSION POINT (not built): the plan's propose / probe / compose step
 * (re-running the job once per candidate practice in a scratch session and
 * adopting what the probe shows) would start from `JobLink` in the reply
 * path, where a job-scoped correction is known, and from a failed run in
 * src/cron/job-practices.ts. Nothing here re-runs a job.
 *
 * No model call in this module.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeScopeName } from "./canonical-facts.js";
import { practiceFollowedIn, formatPracticeDay } from "./practice-attribution.js";
import { FOLLOW_UP_WINDOW_MS } from "./practice-followups.js";
import type { Practice, PracticesStore } from "./practices.js";

const log = createSubsystemLogger("memory/practice-jobs");

/** The owner's next message counts as being about the job for this long. */
export const JOB_LINK_WINDOW_MS = FOLLOW_UP_WINDOW_MS;
const MAX_REQUEST_CHARS = 600;
const MAX_OUTPUT_CHARS = 2_000;
const RETENTION_MS = 30 * 24 * 3_600_000;
const MAX_LINE_CHARS = 320;
const MAX_STATEMENT_CHARS_IN_LINE = 160;

export type JobAnnouncement = {
  id: string;
  /** The job id as the cron store has it. */
  jobId: string;
  jobName: string | null;
  /** The conversation the report was announced in. */
  sessionKey: string;
  /** Where the report went: `main`, or `<channel>:<to>`. */
  destination: string | null;
  /** An excerpt of the job's own instruction (`payload.message`). */
  requestText: string;
  /** An excerpt of the report. */
  outputText: string;
  /** The practices whose canary line this run consumed. */
  canaryPracticeIds: string[];
  announcedAt: number;
  consumedAt: number | null;
};

type Row = {
  id: string;
  job_id: string;
  job_name: string | null;
  session_key: string;
  destination: string | null;
  request_text: string | null;
  output_text: string | null;
  canary_practice_ids: string;
  announced_at: number;
  consumed_at: number | null;
};

const COLUMNS =
  "id, job_id, job_name, session_key, destination, request_text, output_text, " +
  "canary_practice_ids, announced_at, consumed_at";

function parseIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const toAnnouncement = (row: Row): JobAnnouncement => ({
  id: row.id,
  jobId: row.job_id,
  jobName: row.job_name,
  sessionKey: row.session_key,
  destination: row.destination,
  requestText: row.request_text ?? "",
  outputText: row.output_text ?? "",
  canaryPracticeIds: parseIds(row.canary_practice_ids),
  announcedAt: row.announced_at,
  consumedAt: row.consumed_at,
});

/**
 * Which job was announced where and when. Never throws: on a database
 * without the table every read is null and every write a no-op.
 */
export class JobAnnouncementStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    jobId: string;
    jobName?: string | null;
    sessionKey: string;
    destination?: string | null;
    requestText: string;
    outputText: string;
    canaryPracticeIds?: string[];
    now?: number;
  }): JobAnnouncement | null {
    const now = input.now ?? Date.now();
    const row: Row = {
      id: crypto.randomUUID(),
      job_id: input.jobId,
      job_name: input.jobName?.trim() || null,
      session_key: input.sessionKey,
      destination: input.destination ?? null,
      request_text: input.requestText.trim().slice(0, MAX_REQUEST_CHARS),
      output_text: input.outputText.trim().slice(0, MAX_OUTPUT_CHARS),
      canary_practice_ids: JSON.stringify(input.canaryPracticeIds ?? []),
      announced_at: now,
      consumed_at: null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO practice_job_announcements (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.job_id,
          row.job_name,
          row.session_key,
          row.destination,
          row.request_text,
          row.output_text,
          row.canary_practice_ids,
          row.announced_at,
          row.consumed_at,
        );
      this.db
        .prepare(`DELETE FROM practice_job_announcements WHERE announced_at < ?`)
        .run(now - RETENTION_MS);
      return toAnnouncement(row);
    } catch (err) {
      log.debug(`job announcement not recorded: ${String(err)}`);
      return null;
    }
  }

  /** The most recent announcement in a conversation, consumed or not. */
  latest(sessionKey: string | undefined | null): JobAnnouncement | null {
    if (!sessionKey) {
      return null;
    }
    try {
      const row = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM practice_job_announcements
            WHERE session_key = ? ORDER BY announced_at DESC, rowid DESC LIMIT 1`,
        )
        .get(sessionKey) as Row | undefined;
      return row ? toAnnouncement(row) : null;
    } catch (err) {
      log.debug(`job announcements unavailable: ${String(err)}`);
      return null;
    }
  }

  /**
   * The announcement the owner's next message may be about: the most recent
   * one of the conversation, not yet consumed and inside the window. An
   * older announcement is never returned, consumed or not.
   */
  pending(sessionKey: string | undefined | null, now: number = Date.now()): JobAnnouncement | null {
    const latest = this.latest(sessionKey);
    if (
      !latest ||
      latest.consumedAt !== null ||
      now < latest.announcedAt ||
      now - latest.announcedAt > JOB_LINK_WINDOW_MS
    ) {
      return null;
    }
    return latest;
  }

  /** An owner turn came in this conversation: nothing announced before it links any more. */
  consume(sessionKey: string | undefined | null, now: number = Date.now()): number {
    if (!sessionKey) {
      return 0;
    }
    try {
      const res = this.db
        .prepare(
          `UPDATE practice_job_announcements SET consumed_at = ?
            WHERE session_key = ? AND consumed_at IS NULL AND announced_at <= ?`,
        )
        .run(now, sessionKey, now);
      return Number(res.changes);
    } catch (err) {
      log.debug(`job announcement consume failed: ${String(err)}`);
      return 0;
    }
  }

  listForJob(jobId: string, limit = 20): JobAnnouncement[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM practice_job_announcements
            WHERE job_id = ? ORDER BY announced_at DESC, rowid DESC LIMIT ?`,
        )
        .all(jobId, Math.min(Math.max(limit, 1), 200)) as unknown as Row[];
      return rows.map(toAnnouncement);
    } catch (err) {
      log.debug(`job announcements unavailable: ${String(err)}`);
      return [];
    }
  }

  /** The job was deleted: its announcements link nothing any more. */
  deleteForJob(jobId: string): number {
    try {
      const res = this.db
        .prepare(`DELETE FROM practice_job_announcements WHERE job_id = ?`)
        .run(jobId);
      return Number(res.changes);
    } catch (err) {
      log.debug(`job announcement delete failed: ${String(err)}`);
      return 0;
    }
  }
}

// ── The job link of an owner turn ───────────────────────────────────────────

/** The scheduled job the owner's message follows, for the correction pass. */
export type JobLink = {
  jobId: string;
  /** `job:<normalised id>`, or null when the id cannot be a scope. */
  scope: string | null;
  jobName: string | null;
  /** "the Repo stats report": how the job is named in generated lines. */
  label: string;
  requestText: string;
  outputText: string;
  announcedAt: number;
  /** Active practices whose canary line the announced run carried. */
  canaries: Practice[];
};

/** `job:<id>` for a cron job id, or null when the id cannot be a scope name. */
export function jobScopeOf(jobId: string): string | null {
  const name = normalizeScopeName(jobId);
  return name ? `job:${name}` : null;
}

/** How a job is named in a generated line: "the Repo stats report". */
export function jobReportLabel(jobName: string | null | undefined): string {
  const name = jobName?.replace(/\s+/g, " ").trim();
  return name ? `the ${name} report` : "the scheduled report";
}

/**
 * Resolve and consume the job link of an owner turn. Null when no
 * announcement is pending for this conversation, or when the answer to a
 * later owner turn exists (`lastAnswerAt` after the announcement: the most
 * recent of the two wins). The pending announcement is consumed either way:
 * only the owner's next message can be about a report.
 */
export function takeJobLink(
  deps: { announcements: JobAnnouncementStore; practices: PracticesStore },
  params: {
    sessionKey?: string | null;
    /** When the last owner turn of this conversation was answered, if one was. */
    lastAnswerAt?: number | null;
    now?: number;
  },
): JobLink | null {
  const now = params.now ?? Date.now();
  const pending = deps.announcements.pending(params.sessionKey, now);
  deps.announcements.consume(params.sessionKey, now);
  if (!pending) {
    return null;
  }
  if (typeof params.lastAnswerAt === "number" && params.lastAnswerAt > pending.announcedAt) {
    return null;
  }
  const canaries = pending.canaryPracticeIds
    .map((id) => deps.practices.get(id))
    .filter((p): p is Practice => p !== null && p.status === "active");
  return {
    jobId: pending.jobId,
    scope: jobScopeOf(pending.jobId),
    jobName: pending.jobName,
    label: jobReportLabel(pending.jobName),
    requestText: pending.requestText,
    outputText: pending.outputText,
    announcedAt: pending.announcedAt,
    canaries,
  };
}

// ── Generated lines ─────────────────────────────────────────────────────────

function clipStatement(statement: string): string {
  const flat = statement.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const points = Array.from(flat);
  return points.length > MAX_STATEMENT_CHARS_IN_LINE
    ? `${points.slice(0, MAX_STATEMENT_CHARS_IN_LINE - 3).join("")}...`
    : flat;
}

function clipLine(line: string): string {
  const points = Array.from(line);
  return points.length > MAX_LINE_CHARS
    ? `${points.slice(0, MAX_LINE_CHARS - 3).join("")}...`
    : line;
}

/**
 * The canary line of a run: `Changed since last time: "<statement>" (from
 * your message on <date>).` One line; further changes are counted.
 */
export function formatCanaryLine(params: {
  statement: string;
  savedAt: number;
  /** The practice came from the owner's words in a conversation (not typed into the Memory page). */
  fromMessage: boolean;
  more: number;
  timeZone: string;
  now?: number;
}): string {
  const day = formatPracticeDay(params.savedAt, params.timeZone, params.now);
  const source = params.fromMessage ? `from your message on ${day}` : `saved on ${day}`;
  const more = params.more > 0 ? `, and ${params.more} more` : "";
  return clipLine(
    `Changed since last time: "${clipStatement(params.statement)}" (${source})${more}.`,
  );
}

/** The line that reports a rollback. */
export function formatRollbackLine(statement: string): string {
  return clipLine(`Rolled back: "${clipStatement(statement)}". The job runs as before.`);
}

// ── A run's announcement ────────────────────────────────────────────────────

export type JobRunCanary = {
  /** The generated line for this run's announcement, or null. */
  line: string | null;
  /** The practices whose canary this run consumes. */
  practiceIds: string[];
};

/**
 * What a finished run of a job changes on the practices side, before its
 * report is announced: the canary line for the practices saved or changed
 * before the run started that the run's prompt carried, and a
 * `not_followed` event for each of the job's practices that was in the
 * prompt and does not show in the report. Read-only except for those
 * events; the canary is consumed by `commitJobAnnouncement`. Never throws.
 */
export function prepareJobRun(
  store: PracticesStore,
  params: {
    jobId: string;
    reply: string;
    runStartedAt: number;
    timeZone: string;
    now?: number;
  },
): JobRunCanary {
  const none: JobRunCanary = { line: null, practiceIds: [] };
  const scope = jobScopeOf(params.jobId);
  if (!scope) {
    return none;
  }
  try {
    const now = params.now ?? Date.now();
    // In the prompt of this run: its `applied` bump is not older than the run.
    const inPrompt = (p: Practice) =>
      p.lastAppliedAt !== null && p.lastAppliedAt >= params.runStartedAt;
    for (const practice of store.list({ statuses: ["active"], scope }).filter(inPrompt)) {
      if (practiceFollowedIn(params.reply, practice.statement) === "not_followed") {
        store.recordNotFollowed(practice.id, { via: "job", now });
      }
    }
    const pending = store.pendingJobCanaries(params.jobId, params.runStartedAt).filter(inPrompt);
    const first = pending[0];
    if (!first) {
      return none;
    }
    return {
      line: formatCanaryLine({
        statement: first.statement,
        savedAt: store.savedAt(first.id) ?? first.createdAt,
        fromMessage: first.origin !== "owner_ui",
        more: pending.length - 1,
        timeZone: params.timeZone,
        now,
      }),
      practiceIds: pending.map((p) => p.id),
    };
  } catch (err) {
    log.debug(`job canary unavailable: ${String(err)}`);
    return none;
  }
}

/**
 * The report was announced: consume the canary of this run (shown or not,
 * the owner replying or not) and record where and when the job was
 * announced. Never throws.
 */
export function commitJobAnnouncement(
  deps: { announcements: JobAnnouncementStore; practices: PracticesStore },
  params: {
    jobId: string;
    jobName?: string | null;
    sessionKey: string;
    destination: string;
    requestText: string;
    outputText: string;
    canary: JobRunCanary;
    now?: number;
  },
): JobAnnouncement | null {
  const now = params.now ?? Date.now();
  if (!jobScopeOf(params.jobId)) {
    // An id that cannot be a scope can hold no practice: nothing to link.
    return null;
  }
  try {
    if (params.canary.practiceIds.length > 0) {
      deps.practices.recordCanary(params.canary.practiceIds, { now });
    }
    return deps.announcements.record({
      jobId: params.jobId,
      jobName: params.jobName,
      sessionKey: params.sessionKey,
      destination: params.destination,
      requestText: params.requestText,
      outputText: params.outputText,
      canaryPracticeIds: params.canary.practiceIds,
      now,
    });
  } catch (err) {
    log.debug(`job announcement commit failed: ${String(err)}`);
    return null;
  }
}
