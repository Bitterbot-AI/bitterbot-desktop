/**
 * PLAN-64 Phase 5: what a scheduled job's run means for the practices of
 * that job (src/memory/practice-jobs.ts has the rules).
 *
 * `beginJobAnnouncement` runs after an isolated job's turn and before its
 * report is announced: it returns the one generated "Changed since last
 * time" line for the report, if the run was the first after a `job:`
 * practice was saved or changed, and a callback that records the
 * announcement once the report went out. The owner's next message in the
 * main conversation is linked to the job through that record.
 *
 * Only jobs the owner scheduled, and never a long-horizon task wakeup (its
 * output is a task step, not a report to the owner). Off with
 * `memory.practices.jobs.enabled: false`. Nothing here throws into the cron
 * run, and nothing calls a model.
 *
 * EXTENSION POINT (not built): the plan's probe-based refinement (propose
 * two candidate practices, re-run the job once per candidate in a scratch
 * session with delivery off, adopt what the probe shows) would be triggered
 * from here on a failed run, and from the reply path on a job-scoped
 * correction. This module never re-runs a job.
 */

import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { BitterbotConfig } from "../config/config.js";
import { practiceJobsEnabled } from "../config/feature-switches.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeScopeName } from "../memory/canonical-facts.js";
import { getCronEngine } from "./active.js";
import { loadJobsFile, resolveCronPaths } from "./store.js";
import type { CronJob } from "./types.js";

const log = createSubsystemLogger("gateway/cron");

export type JobAnnouncementHook = {
  /** The generated line to add to this run's announcement, or null. */
  canaryLine: string | null;
  /** Call once the report was announced; `destination` is `main` or `<channel>:<to>`. */
  announced: (destination: string) => void;
};

const NO_HOOK: JobAnnouncementHook = { canaryLine: null, announced: () => {} };

/** The slice of the memory manager this module uses. */
type JobPracticesManager = {
  practiceJobRunCanary: (params: { jobId: string; reply: string; runStartedAt: number }) => {
    line: string | null;
    practiceIds: string[];
  };
  recordPracticeJobAnnouncement: (params: {
    jobId: string;
    jobName?: string | null;
    sessionKey: string;
    destination: string;
    requestText: string;
    outputText: string;
    canary: { line: string | null; practiceIds: string[] };
  }) => unknown;
};

/** Does this job take part: an owner-scheduled isolated agent turn that is not a task wakeup. */
export function jobLearnsFromCorrections(cfg: BitterbotConfig, job: CronJob): boolean {
  return (
    practiceJobsEnabled(cfg.memory?.practices) &&
    job.sessionTarget === "isolated" &&
    job.payload.kind === "agentTurn" &&
    job.payload.senderIsOwner !== false &&
    typeof job.payload.taskId !== "string"
  );
}

export async function beginJobAnnouncement(params: {
  cfg: BitterbotConfig;
  job: CronJob;
  agentId: string;
  reply: string;
  runStartedAt: number;
  /** Test seam; defaults to the agent's memory manager. */
  manager?: JobPracticesManager | null;
}): Promise<JobAnnouncementHook> {
  const { cfg, job, agentId } = params;
  try {
    if (!jobLearnsFromCorrections(cfg, job) || job.payload.kind !== "agentTurn") {
      return NO_HOOK;
    }
    let manager = params.manager;
    if (manager === undefined) {
      const { MemoryIndexManager } = await import("../memory/manager.js");
      manager = await MemoryIndexManager.get({ cfg, agentId, purpose: "status" });
    }
    if (!manager) {
      return NO_HOOK;
    }
    const m = manager;
    const canary = m.practiceJobRunCanary({
      jobId: job.jobId,
      reply: params.reply,
      runStartedAt: params.runStartedAt,
    });
    const requestText = job.payload.message;
    return {
      canaryLine: canary.line,
      announced: (destination) => {
        try {
          m.recordPracticeJobAnnouncement({
            jobId: job.jobId,
            jobName: job.name ?? null,
            sessionKey: resolveAgentMainSessionKey({ cfg, agentId }),
            destination,
            requestText,
            outputText: params.reply,
            canary,
          });
        } catch (err) {
          log.debug(`cron ${job.jobId}: announcement not recorded: ${formatErr(err)}`);
        }
      },
    };
  } catch (err) {
    log.debug(`cron ${job.jobId}: practices unavailable for the announcement: ${formatErr(err)}`);
    return NO_HOOK;
  }
}

/**
 * A job was deleted: its EXPERIENCE.md goes, and so do its announcement
 * records when the agent's memory is open in this process. The practices
 * stored for it are kept (they show with the job id and can be retired or
 * moved on the Memory page). Never throws.
 */
export async function forgetJobPractices(cfg: BitterbotConfig, job: CronJob): Promise<void> {
  try {
    const agentId = job.agentId ?? resolveDefaultAgentId(cfg);
    const { removeJobExperience } = await import("../memory/practice-job-experience.js");
    await removeJobExperience(resolveAgentDir(cfg, agentId), job.jobId);
    const { peekMemorySearchManager } = await import("../memory/index.js");
    const { manager } = await peekMemorySearchManager({ cfg, agentId });
    const m = manager as unknown as { forgetPracticeJob?: (jobId: string) => Promise<void> } | null;
    await m?.forgetPracticeJob?.(job.jobId);
  } catch (err) {
    log.debug(`cron ${job.jobId}: practice cleanup failed: ${formatErr(err)}`);
  }
}

export type JobForPractices = {
  jobId: string;
  name: string | null;
  /** An isolated agent-turn job: the only kind a `job:` practice is ever given to. */
  isolated: boolean;
};

/**
 * The scheduled jobs, keyed by the id as it appears in a `job:` scope
 * (lowercase), for showing a job practice by the job's name. Read from the
 * running cron engine, or from the jobs file in a process without one (the
 * CLI). Empty when neither can be read. Never throws.
 */
export async function readJobsByScopeName(
  cfg: BitterbotConfig,
): Promise<Map<string, JobForPractices>> {
  const out = new Map<string, JobForPractices>();
  try {
    const jobs =
      getCronEngine()?.listJobs() ??
      (await loadJobsFile(resolveCronPaths({ storePath: cfg.cron?.store }).jobsFile)).jobs;
    for (const job of jobs) {
      const key = normalizeScopeName(job.jobId);
      if (key) {
        out.set(key, {
          jobId: job.jobId,
          name: job.name?.trim() || null,
          isolated: job.sessionTarget === "isolated" && job.payload?.kind === "agentTurn",
        });
      }
    }
  } catch (err) {
    log.debug(`cron jobs unavailable for practice labels: ${formatErr(err)}`);
  }
  return out;
}

/**
 * The active `job:` practices of each job, by job id, for `cron.list`.
 * Reads the agent's memory only when it is already open in this process or
 * can be opened; a job without practices has no entry. Never throws.
 */
export async function readActiveJobPractices(
  cfg: BitterbotConfig,
  jobs: CronJob[],
): Promise<Map<string, Array<{ id: string; statement: string; savedAt: number }>>> {
  const out = new Map<string, Array<{ id: string; statement: string; savedAt: number }>>();
  try {
    const isolated = jobs.filter((job) => job.sessionTarget === "isolated");
    if (isolated.length === 0) {
      return out;
    }
    const { MemoryIndexManager } = await import("../memory/manager.js");
    const stores = new Map<string, Awaited<ReturnType<typeof MemoryIndexManager.get>>>();
    for (const job of isolated) {
      const scopeName = normalizeScopeName(job.jobId);
      if (!scopeName) {
        continue;
      }
      const agentId = job.agentId ?? resolveDefaultAgentId(cfg);
      if (!stores.has(agentId)) {
        stores.set(agentId, await MemoryIndexManager.get({ cfg, agentId, purpose: "status" }));
      }
      const store = stores.get(agentId)?.practices();
      const active = store?.list({ statuses: ["active"], scope: `job:${scopeName}` }) ?? [];
      if (store && active.length > 0) {
        out.set(
          job.jobId,
          active.map((p) => ({
            id: p.id,
            statement: p.statement,
            savedAt: store.savedAt(p.id) ?? p.createdAt,
          })),
        );
      }
    }
  } catch (err) {
    log.debug(`job practices unavailable for cron.list: ${formatErr(err)}`);
  }
  return out;
}

/** How a `job:` scope is shown: the job's name, or its id when the job is gone or unnamed. */
export function jobScopeLabel(
  scope: string,
  jobs: ReadonlyMap<string, JobForPractices>,
): string | undefined {
  if (!scope.startsWith("job:")) {
    return undefined;
  }
  const key = scope.slice("job:".length);
  return jobs.get(key)?.name ?? jobs.get(key)?.jobId ?? key;
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
