/**
 * Long-horizon task spine doctor section (PLAN-16/17).
 *
 * Doctor only ever opened the agent MEMORY DB; the task machinery lives in
 * three other stores it never looked at:
 *
 *   - `~/.bitterbot/tasks.sqlite` — Task rows + handoffs. An in-flight task
 *     whose `last_seen_at` is stale AND has no pending cron wakeup is
 *     orphaned: the agent suspended it and nothing will ever resume it. The
 *     wakeup cross-check matters — a task parked for days with a scheduled
 *     `task_schedule_wakeup` job is the system working as DESIGNED, not an
 *     orphan.
 *   - `~/.bitterbot/event-journal.sqlite` — on by default and append-only;
 *     unbounded growth is a real disk risk nothing reports.
 *   - the cron store — `task_schedule_wakeup` writes here. If the cron
 *     scheduler is wedged, every suspended long-horizon task is silently
 *     dead; enabled jobs far past `nextRunAt` while the gateway is RUNNING
 *     (and cron is not deliberately disabled) is the tell. `nextRunAt` only
 *     advances after a run completes, so the slack is generous enough that a
 *     long in-flight job or a post-restart backlog does not false-warn.
 *
 * All warn/info: task/journal/cron state is data health, never update-gate
 * material.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { resolveCronPaths } from "../cron/store.js";
import { defaultEventJournalDbPath, isEventJournalEnabled } from "../infra/event-journal.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";

const SECTION = "Long-Horizon Tasks";
const ORPHAN_STALE_MS = 24 * 60 * 60_000;
// Generous: nextRunAt advances only in post-run bookkeeping, so a legitimate
// long-running job (or a due backlog draining behind maxConcurrentRuns after
// a restart) can sit "overdue" for a while without the scheduler being wedged.
const CRON_OVERDUE_SLACK_MS = 2 * 60 * 60_000;
const JOURNAL_WARN_BYTES = 500 * 1024 * 1024;
// Matches TERMINAL_STATUSES in src/tasks/types.ts.
const TERMINAL_SQL = `('completed', 'failed', 'stopped')`;

type CronJobLite = {
  jobId?: string;
  name?: string;
  enabled?: boolean;
  nextRunAt?: number;
  consecutiveErrors?: number;
  payload?: { taskId?: string };
  schedule?: { kind?: string; at?: string };
};

function tasksDbPath(): string {
  return process.env.BITTERBOT_TASKS_DB ?? path.join(os.homedir(), ".bitterbot", "tasks.sqlite");
}

/** Parse the cron jobs file; null when unparseable. Exported for tests. */
export function parseCronJobs(raw: string): CronJobLite[] | null {
  try {
    const parsed = JSON.parse(raw) as { jobs?: CronJobLite[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return null;
  }
}

/**
 * Task ids that have a pending wakeup job (`task_schedule_wakeup` stamps
 * payload.taskId). Any enabled job counts — even an overdue one, since the
 * cron-wedge check below owns that failure mode.
 */
export function pendingWakeupTaskIds(jobs: CronJobLite[]): Set<string> {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (job.enabled === false) continue;
    const taskId = job.payload?.taskId;
    if (typeof taskId === "string" && taskId) ids.add(taskId);
  }
  return ids;
}

/** Pure task-store inspection — exported for tests. */
export function inspectTaskStore(
  db: DatabaseSync,
  scheduledTaskIds: ReadonlySet<string>,
  now: number = Date.now(),
): CheckResult[] {
  const results: CheckResult[] = [];
  try {
    const active = db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status NOT IN ${TERMINAL_SQL}`)
      .get() as { c: number };
    const staleRows = db
      .prepare(
        `SELECT id FROM tasks
          WHERE status NOT IN ${TERMINAL_SQL} AND last_seen_at < ?`,
      )
      .all(now - ORPHAN_STALE_MS) as Array<{ id: string }>;
    // Stale but with a pending wakeup = suspended by design, not orphaned.
    const orphaned = staleRows.filter((r) => !scheduledTaskIds.has(r.id));
    if (orphaned.length > 0) {
      results.push(
        warn(
          `${orphaned.length} in-flight task(s) not seen for >24h with NO pending wakeup — ` +
            `likely orphaned (suspended and nothing will resume them).`,
        ),
      );
    }
    results.push(
      orphaned.length === 0
        ? ok(
            `Task store: ${active.c} in-flight task(s)` +
              (staleRows.length > 0
                ? `, ${staleRows.length} parked with a scheduled wakeup`
                : ", none stale") +
              ".",
          )
        : info(`Task store: ${active.c} in-flight task(s) total.`),
    );
  } catch (err) {
    results.push(info(`Could not read tasks table: ${String(err)}`));
  }
  return results;
}

/** Pure cron-store inspection — exported for tests. */
export function inspectCronJobs(
  jobs: CronJobLite[],
  isGatewayRunning: boolean,
  now: number = Date.now(),
): CheckResult[] {
  const results: CheckResult[] = [];
  const enabled = jobs.filter((j) => j.enabled !== false);
  const overdue = enabled.filter(
    (j) => typeof j.nextRunAt === "number" && j.nextRunAt < now - CRON_OVERDUE_SLACK_MS,
  );
  const erroring = enabled.filter((j) => (j.consecutiveErrors ?? 0) >= 3);

  if (isGatewayRunning && overdue.length > 0) {
    results.push(
      warn(
        `${overdue.length} enabled cron job(s) are >2h past nextRunAt while the gateway is ` +
          `running — the cron scheduler may be wedged. Suspended tasks waiting on these wakeups ` +
          `are dead until it fires.`,
      ),
    );
  }
  for (const job of erroring.slice(0, 3)) {
    results.push(
      warn(
        `Cron job "${job.name ?? job.jobId ?? "?"}" has failed ${job.consecutiveErrors} times in a row.`,
      ),
    );
  }
  if (erroring.length > 3) {
    results.push(info(`…and ${erroring.length - 3} more cron job(s) with repeated failures.`));
  }
  if (results.length === 0) {
    results.push(ok(`Cron: ${enabled.length} enabled job(s), none overdue or failing.`));
  }
  return results;
}

export function runTaskSpineChecks(params: {
  config: BitterbotConfig;
  isGatewayRunning: boolean;
}): void {
  const results: CheckResult[] = [];
  const cronDisabled =
    params.config.cron?.enabled === false || Boolean(process.env.BITTERBOT_SKIP_CRON);

  // ── Cron store first: the wakeup set feeds the orphan check ──
  let cronJobs: CronJobLite[] = [];
  let cronFileState: "absent" | "unparseable" | "ok" = "absent";
  const { jobsFile } = resolveCronPaths({ storePath: params.config.cron?.store });
  if (fs.existsSync(jobsFile)) {
    try {
      const parsed = parseCronJobs(fs.readFileSync(jobsFile, "utf-8"));
      if (parsed === null) {
        cronFileState = "unparseable";
      } else {
        cronJobs = parsed;
        cronFileState = "ok";
      }
    } catch (err) {
      cronFileState = "unparseable";
      results.push(warn(`Could not read cron jobs file: ${String(err)}`));
    }
  }

  // ── Task store ──
  const taskDb = tasksDbPath();
  if (!fs.existsSync(taskDb)) {
    results.push(info("No tasks.sqlite yet — no long-horizon tasks have been created."));
  } else {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(taskDb, { open: true, readOnly: true });
      results.push(...inspectTaskStore(db, pendingWakeupTaskIds(cronJobs)));
    } catch (err) {
      results.push(warn(`Could not open tasks.sqlite read-only: ${String(err)}`));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ── Event journal growth ──
  if (!isEventJournalEnabled()) {
    results.push(info("Event journal disabled (BITTERBOT_EVENT_JOURNAL)."));
  } else {
    try {
      const stat = fs.statSync(defaultEventJournalDbPath());
      const mb = stat.size / (1024 * 1024);
      results.push(
        stat.size > JOURNAL_WARN_BYTES
          ? warn(
              `Event journal is ${mb.toFixed(0)} MB and append-only — consider pruning or ` +
                `disabling (BITTERBOT_EVENT_JOURNAL=0) if disk matters on this node.`,
            )
          : ok(`Event journal: ${mb.toFixed(1)} MB.`),
      );
    } catch {
      results.push(info("No event journal yet."));
    }
  }

  // ── Cron verdicts ──
  if (cronDisabled) {
    results.push(
      info(
        "Cron is disabled (cron.enabled=false or BITTERBOT_SKIP_CRON) — scheduled wakeups will " +
          "not fire; suspended long-horizon tasks stay suspended.",
      ),
    );
  } else if (cronFileState === "absent") {
    results.push(info("No cron jobs file yet — nothing scheduled."));
  } else if (cronFileState === "unparseable") {
    results.push(warn("cron jobs file exists but is not parseable JSON."));
  } else {
    results.push(...inspectCronJobs(cronJobs, params.isGatewayRunning));
  }

  renderSection(SECTION, results);
}
