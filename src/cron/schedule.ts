import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

const MIN_EVERY_MS = 1_000;
const MAX_EVERY_MS = 365 * 24 * 60 * 60 * 1_000;

export type ParsedSchedule = {
  schedule: CronSchedule;
  // Compute the next fire time at-or-after `from`. Returns null when no
  // future fire is possible (e.g. a one-shot that already fired).
  nextRunAt: (from: number) => number | null;
};

function parseAt(at: string): number {
  const trimmed = String(at).trim();
  if (!trimmed) {
    throw new Error("schedule.at is required");
  }
  // Treat plain `YYYY-MM-DDTHH:mm:ss` (no offset, no `Z`) as UTC, matching
  // the docs ("treated as UTC when omitted"). Date constructor in V8 reads
  // such strings as local time, which would be surprising on the gateway.
  const looksUnzoned =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const iso = looksUnzoned ? `${trimmed}Z` : trimmed;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`schedule.at is not a valid ISO 8601 timestamp: ${at}`);
  }
  return ms;
}

function parseEvery(everyMs: unknown): number {
  const ms = typeof everyMs === "number" ? Math.floor(everyMs) : Number.NaN;
  if (!Number.isFinite(ms) || ms < MIN_EVERY_MS) {
    throw new Error(`schedule.everyMs must be a number >= ${MIN_EVERY_MS}`);
  }
  if (ms > MAX_EVERY_MS) {
    throw new Error(`schedule.everyMs must be <= ${MAX_EVERY_MS}`);
  }
  return ms;
}

function buildCron(expr: string, tz?: string): Cron {
  const opts: { timezone?: string } = {};
  if (typeof tz === "string" && tz.trim()) {
    opts.timezone = tz.trim();
  }
  // Croner throws on invalid expressions / timezones; surface that as our error.
  try {
    return new Cron(expr, { ...opts, paused: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid cron expression "${expr}"${tz ? ` (tz=${tz})` : ""}: ${detail}`, {
      cause: err,
    });
  }
}

export function parseSchedule(schedule: CronSchedule): ParsedSchedule {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("schedule is required");
  }
  switch (schedule.kind) {
    case "at": {
      const ts = parseAt(schedule.at);
      return {
        schedule: { kind: "at", at: schedule.at },
        nextRunAt: (from) => (ts >= from ? ts : null),
      };
    }
    case "every": {
      const ms = parseEvery(schedule.everyMs);
      return {
        schedule: { kind: "every", everyMs: ms },
        nextRunAt: (from) => from + ms,
      };
    }
    case "cron": {
      if (typeof schedule.expr !== "string" || !schedule.expr.trim()) {
        throw new Error("schedule.expr is required for cron schedules");
      }
      const job = buildCron(schedule.expr, schedule.tz);
      return {
        schedule: { kind: "cron", expr: schedule.expr.trim(), tz: schedule.tz },
        nextRunAt: (from) => {
          const next = job.nextRun(new Date(from - 1));
          return next ? next.getTime() : null;
        },
      };
    }
    default: {
      const exhaustive: never = schedule;
      throw new Error(`unsupported schedule.kind: ${(exhaustive as { kind?: string })?.kind}`);
    }
  }
}

// Convenience for callers that just need "the next fire time after now".
export function computeNextRunAt(schedule: CronSchedule, fromMs = Date.now()): number | null {
  return parseSchedule(schedule).nextRunAt(fromMs);
}

// Validate without retaining the parsed schedule (used at write-time).
export function assertScheduleValid(schedule: CronSchedule): void {
  parseSchedule(schedule);
}

// Render a 5/6/7-field cron string or "every Xms" / "at <iso>" for UIs that
// expect a string-shaped schedule (legacy CronJobWire.schedule).
export function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr;
    case "every":
      return `every ${schedule.everyMs}ms`;
    case "at":
      return `at ${schedule.at}`;
  }
}
