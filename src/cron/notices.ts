/**
 * What the owner is told when a scheduled job goes wrong (PLAN-53 E3).
 *
 * One notice at the start of a failure streak, one when the job is turned
 * off or a one-shot fails for good. Not one per failed run: a job retrying on
 * backoff would bury everything else.
 */

import type { OwnerNotice } from "../infra/owner-notify.js";
import type { CronEngineEvent } from "./engine.js";
import type { CronJob } from "./types.js";

const nameOf = (job: CronJob) => `"${(job.name ?? job.jobId).slice(0, 80)}"`;
const errorOf = (error: string | undefined) => (error ? error.slice(0, 300) : "no error message");

const clock = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function ownerNoticeForCronEvent(event: CronEngineEvent): OwnerNotice | null {
  const { run, job } = event;
  if (!job || run.status !== "error") {
    return null;
  }
  if (event.kind === "disabled") {
    return {
      kind: "cron-disabled",
      dedupeKey: `cron-disabled:${job.jobId}`,
      text:
        `Scheduled job ${nameOf(job)} failed ${job.consecutiveErrors} times in a row and has been turned off. ` +
        `Last error: ${errorOf(run.error)}. Turn it back on from the Automations page once the cause is fixed.`,
    };
  }
  if (event.kind === "gave-up") {
    return {
      kind: "cron-error",
      dedupeKey: `cron-gave-up:${job.jobId}`,
      text:
        `Scheduled job ${nameOf(job)} failed and will not run again` +
        `${job.consecutiveErrors > 1 ? ` (tried ${job.consecutiveErrors} times)` : ""}. ` +
        `Error: ${errorOf(run.error)}.`,
    };
  }
  // A plain failed run: speak up at the start of a streak only. A job that is
  // about to be reported as turned off or given up says it there.
  if (job.consecutiveErrors !== 1 || !job.enabled) {
    return null;
  }
  const retry =
    typeof job.nextRunAt === "number" ? ` It will try again around ${clock(job.nextRunAt)}.` : "";
  return {
    kind: "cron-error",
    dedupeKey: `cron-error:${job.jobId}`,
    text: `Scheduled job ${nameOf(job)} failed. Error: ${errorOf(run.error)}.${retry}`,
  };
}
