import type { CronEngineStatus, CronJob, CronRun, CronRunStatus } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyBackoff } from "./backoff.js";
import { runIsolatedJob } from "./isolated-agent.js";
import { runMainSessionJob } from "./main-session.js";
import { computeNextRunAt } from "./schedule.js";
import {
  appendRun,
  loadJobsFile,
  resolveCronPaths,
  saveJobsFile,
  type CronStorePaths,
} from "./store.js";
import { postFinishedRunWebhook, type CronWebhookConfig } from "./webhook.js";

const log = createSubsystemLogger("gateway/cron");
const DEFAULT_TICK_MS = 5_000;
const STARTUP_GRACE_MS = 1_500;

export type CronEngineOptions = {
  storePath?: string;
  enabled?: boolean;
  maxConcurrentRuns?: number;
  webhook?: string;
  webhookToken?: string;
  tickMs?: number;
  // Fired after every job run terminates (success or failure). Tests rely on
  // this hook to avoid sleep-polling.
  onRunFinished?: (run: CronRun) => void;
  // Allow tests to override the runners.
  runners?: {
    main?: typeof runMainSessionJob;
    isolated?: typeof runIsolatedJob;
  };
  nowMs?: () => number;
};

type RunOutcome = {
  status: CronRunStatus;
  durationMs: number;
  error?: string;
};

export class CronEngine {
  private readonly opts: CronEngineOptions;
  private readonly paths: CronStorePaths;
  private jobs: CronJob[] = [];
  private inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private flushQueued = false;
  private flushing = false;
  private dirty = false;
  private nowMs: () => number;

  constructor(opts: CronEngineOptions = {}) {
    this.opts = opts;
    this.paths = resolveCronPaths({ storePath: opts.storePath });
    this.nowMs = opts.nowMs ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.opts.enabled === false) {
      log.info(`cron engine disabled (storePath=${this.paths.jobsFile})`);
      return;
    }
    const file = await loadJobsFile(this.paths.jobsFile);
    this.jobs = file.jobs.map(this.refreshDerived.bind(this));
    this.running = true;
    log.info(`cron engine started — ${this.jobs.length} job(s) loaded from ${this.paths.jobsFile}`);
    // Light startup grace before the first tick so booting services are ready.
    setTimeout(() => this.scheduleTick(), STARTUP_GRACE_MS).unref?.();
    if (this.dirty) {
      await this.flush();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty || this.flushQueued) {
      await this.flush();
    }
  }

  status(): CronEngineStatus {
    let nextWakeAtMs: number | null = null;
    for (const job of this.jobs) {
      if (!job.enabled || typeof job.nextRunAt !== "number") {
        continue;
      }
      if (nextWakeAtMs === null || job.nextRunAt < nextWakeAtMs) {
        nextWakeAtMs = job.nextRunAt;
      }
    }
    return {
      enabled: this.opts.enabled !== false,
      running: this.running,
      storePath: this.paths.jobsFile,
      jobs: this.jobs.length,
      enabledJobs: this.jobs.filter((job) => job.enabled).length,
      inFlight: this.inFlight.size,
      maxConcurrentRuns: this.opts.maxConcurrentRuns ?? 1,
      webhookConfigured: Boolean(this.opts.webhook),
      nextWakeAtMs,
    };
  }

  listJobs(): CronJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  getJob(jobId: string): CronJob | undefined {
    const found = this.jobs.find((job) => job.jobId === jobId);
    return found ? { ...found } : undefined;
  }

  paths_(): CronStorePaths {
    return this.paths;
  }

  async upsertJob(job: CronJob): Promise<CronJob> {
    const existingIndex = this.jobs.findIndex((entry) => entry.jobId === job.jobId);
    const next = this.refreshDerived(job);
    if (existingIndex >= 0) {
      this.jobs[existingIndex] = next;
    } else {
      this.jobs.push(next);
    }
    await this.flush();
    this.scheduleTick();
    return { ...next };
  }

  async removeJob(jobId: string): Promise<boolean> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.jobId !== jobId);
    if (this.jobs.length === before) {
      return false;
    }
    await this.flush();
    return true;
  }

  // Manually trigger a single job. `mode === "due"` only runs when the job is
  // currently due; `force` (default) runs unconditionally.
  async runJob(jobId: string, mode: "force" | "due" = "force"): Promise<CronRun> {
    const job = this.jobs.find((entry) => entry.jobId === jobId);
    if (!job) {
      throw new Error(`cron job not found: ${jobId}`);
    }
    if (mode === "due") {
      const due = (job.nextRunAt ?? 0) <= this.nowMs();
      if (!due) {
        return this.recordSkip(jobId, "not-due", "manual-due");
      }
    }
    if (this.inFlight.has(jobId)) {
      return this.recordSkip(jobId, "already-running", "manual");
    }
    return this.runOne(job, mode === "due" ? "manual-due" : "manual");
  }

  private scheduleTick(): void {
    if (!this.running || this.timer) {
      return;
    }
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.fireDueJobs();
    } catch (err) {
      log.error(`tick failed: ${formatErr(err)}`);
    } finally {
      this.scheduleTick();
    }
  }

  private async fireDueJobs(): Promise<void> {
    const now = this.nowMs();
    const due = this.jobs.filter((job) => {
      if (!job.enabled) {
        return false;
      }
      if (this.inFlight.has(job.jobId)) {
        return false;
      }
      const next = job.nextRunAt ?? 0;
      return next > 0 && next <= now;
    });
    if (due.length === 0) {
      return;
    }
    const cap = Math.max(1, this.opts.maxConcurrentRuns ?? 1);
    const slots = Math.max(0, cap - this.inFlight.size);
    const batch = due.slice(0, slots);
    await Promise.all(batch.map((job) => this.runOne(job, "schedule")));
  }

  private async runOne(job: CronJob, trigger: CronRun["trigger"]): Promise<CronRun> {
    this.inFlight.add(job.jobId);
    const startedAt = this.nowMs();
    let outcome: RunOutcome;
    try {
      outcome = await this.dispatch(job);
    } catch (err) {
      outcome = {
        status: "error",
        durationMs: this.nowMs() - startedAt,
        error: formatErr(err),
      };
    }
    if (typeof outcome.durationMs !== "number" || !Number.isFinite(outcome.durationMs)) {
      outcome.durationMs = this.nowMs() - startedAt;
    }
    const run: CronRun = {
      ts: startedAt,
      jobId: job.jobId,
      status: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error,
      trigger,
    };
    await this.bookkeeping(job, run);
    this.inFlight.delete(job.jobId);
    return run;
  }

  private async dispatch(job: CronJob): Promise<RunOutcome> {
    const started = this.nowMs();
    try {
      if (job.sessionTarget === "main") {
        const fn = this.opts.runners?.main ?? runMainSessionJob;
        await fn(job);
      } else {
        const fn = this.opts.runners?.isolated ?? runIsolatedJob;
        await fn(job);
      }
      return { status: "ok", durationMs: this.nowMs() - started };
    } catch (err) {
      return {
        status: "error",
        durationMs: this.nowMs() - started,
        error: formatErr(err),
      };
    }
  }

  private async bookkeeping(job: CronJob, run: CronRun): Promise<void> {
    job.lastRunAt = run.ts;
    job.lastRunStatus = run.status;

    const isOneShot = job.schedule.kind === "at";
    const isTerminal = run.status === "ok" || run.status === "error" || run.status === "skipped";

    if (isOneShot && isTerminal) {
      const shouldDelete = job.deleteAfterRun !== false && run.status === "ok";
      if (shouldDelete) {
        this.jobs = this.jobs.filter((entry) => entry.jobId !== job.jobId);
      } else {
        job.enabled = false;
        job.nextRunAt = undefined;
        job.consecutiveErrors = 0;
        this.replaceJob(job);
      }
    } else {
      if (run.status === "error") {
        job.consecutiveErrors = (job.consecutiveErrors ?? 0) + 1;
      } else if (run.status === "ok") {
        job.consecutiveErrors = 0;
      }
      const next = computeNextRunAt(job.schedule, this.nowMs() + 1);
      job.nextRunAt =
        next === null ? undefined : applyBackoff(next, job.consecutiveErrors, this.nowMs());
      job.updatedAt = this.nowMs();
      this.replaceJob(job);
    }

    try {
      await appendRun(this.paths.runsDir, run);
    } catch (err) {
      log.warn(`could not persist run history for ${job.jobId}: ${formatErr(err)}`);
    }
    await this.flush();
    this.opts.onRunFinished?.(run);
    if (job.notify && this.opts.webhook) {
      const cfg: CronWebhookConfig = {
        webhook: this.opts.webhook,
        webhookToken: this.opts.webhookToken,
      };
      void postFinishedRunWebhook(cfg, {
        jobId: run.jobId,
        status: run.status,
        durationMs: run.durationMs,
        error: run.error,
        ts: run.ts,
        trigger: run.trigger,
      });
    }
  }

  private replaceJob(job: CronJob): void {
    const idx = this.jobs.findIndex((entry) => entry.jobId === job.jobId);
    if (idx >= 0) {
      this.jobs[idx] = { ...job };
    }
  }

  private async recordSkip(
    jobId: string,
    error: string,
    trigger: CronRun["trigger"],
  ): Promise<CronRun> {
    const run: CronRun = {
      ts: this.nowMs(),
      jobId,
      status: "skipped",
      error,
      trigger,
    };
    try {
      await appendRun(this.paths.runsDir, run);
    } catch (err) {
      log.warn(`could not persist skip for ${jobId}: ${formatErr(err)}`);
    }
    this.opts.onRunFinished?.(run);
    return run;
  }

  private refreshDerived(job: CronJob): CronJob {
    const next = { ...job };
    if (typeof next.consecutiveErrors !== "number") {
      next.consecutiveErrors = 0;
    }
    if (next.enabled) {
      try {
        const computed = computeNextRunAt(next.schedule, this.nowMs());
        next.nextRunAt =
          computed === null
            ? undefined
            : applyBackoff(computed, next.consecutiveErrors ?? 0, this.nowMs());
      } catch (err) {
        log.warn(`could not compute next run for job ${next.jobId}: ${formatErr(err)}`);
        next.nextRunAt = undefined;
      }
    } else {
      next.nextRunAt = undefined;
    }
    this.dirty = true;
    return next;
  }

  private async flush(): Promise<void> {
    this.flushQueued = true;
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.flushQueued) {
        this.flushQueued = false;
        await saveJobsFile(this.paths.jobsFile, { version: 1, jobs: this.jobs });
      }
      this.dirty = false;
    } finally {
      this.flushing = false;
    }
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
