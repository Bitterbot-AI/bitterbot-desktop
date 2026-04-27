import type { CronJob } from "../../cron/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { CronEngine } from "../../cron/engine.js";
import { applyJobPatch, buildJobFromParams, jobToWire } from "../../cron/normalize.js";
import { getCronEngine, startCronEngine } from "../../cron/runtime.js";
import { assertScheduleValid } from "../../cron/schedule.js";
import { readRuns } from "../../cron/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

async function ensureEngine(): Promise<CronEngine> {
  const existing = getCronEngine();
  if (existing) {
    return existing;
  }
  // Lazy-start so the first cron RPC after a fresh boot still works (the
  // background `startCronEngine` in server-startup is async and may not have
  // resolved yet).
  const cfg = loadConfig();
  const next = await startCronEngine(cfg);
  if (!next) {
    throw new Error("cron engine is not enabled");
  }
  return next;
}

function readJobId(params: Record<string, unknown>): string {
  const raw = params.jobId ?? params.id;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("jobId is required");
  }
  return raw.trim();
}

function unavailable(msg: string) {
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

function badRequest(msg: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, msg);
}

export const cronHandlers: GatewayRequestHandlers = {
  "cron.list": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const includeDisabled = params.includeDisabled !== false;
      const jobs = engine
        .listJobs()
        .filter((job) => (includeDisabled ? true : job.enabled))
        .map(jobToWire);
      respond(true, { jobs });
    } catch (err) {
      respond(false, undefined, unavailable(formatErr(err)));
    }
  },

  "cron.status": async ({ respond }) => {
    try {
      const engine = await ensureEngine();
      respond(true, engine.status());
    } catch (err) {
      respond(false, undefined, unavailable(formatErr(err)));
    }
  },

  "cron.add": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const job = buildJobFromParams(params);
      assertScheduleValid(job.schedule);
      const stored = await engine.upsertJob(job);
      respond(true, jobToWire(stored));
    } catch (err) {
      respond(false, undefined, badRequest(formatErr(err)));
    }
  },

  "cron.update": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const jobId = readJobId(params);
      const existing = engine.getJob(jobId);
      if (!existing) {
        respond(false, undefined, badRequest(`cron job not found: ${jobId}`));
        return;
      }
      const patch = readPatch(params);
      const next = applyJobPatch(existing, patch);
      assertScheduleValid(next.schedule);
      const saved = await engine.upsertJob(preserveDerived(existing, next));
      respond(true, jobToWire(saved));
    } catch (err) {
      respond(false, undefined, badRequest(formatErr(err)));
    }
  },

  "cron.remove": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const jobId = readJobId(params);
      const ok = await engine.removeJob(jobId);
      respond(true, { ok });
    } catch (err) {
      respond(false, undefined, badRequest(formatErr(err)));
    }
  },

  "cron.run": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const jobId = readJobId(params);
      const mode = params.mode === "due" ? "due" : "force";
      const run = await engine.runJob(jobId, mode);
      respond(true, run);
    } catch (err) {
      respond(false, undefined, badRequest(formatErr(err)));
    }
  },

  "cron.runs": async ({ params, respond }) => {
    try {
      const engine = await ensureEngine();
      const jobId = readJobId(params);
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(Math.floor(params.limit), 1000))
          : 50;
      const runs = await readRuns(engine.paths_().runsDir, jobId, limit);
      respond(true, { runs, count: runs.length });
    } catch (err) {
      respond(false, undefined, badRequest(formatErr(err)));
    }
  },
};

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  const raw = params.patch;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function preserveDerived(prev: CronJob, next: CronJob): CronJob {
  // The engine recomputes nextRunAt/consecutiveErrors at upsert time; carry
  // through the prior createdAt + run-state so updates feel additive.
  return {
    ...next,
    consecutiveErrors: prev.consecutiveErrors ?? 0,
    lastRunAt: prev.lastRunAt,
    lastRunStatus: prev.lastRunStatus,
    createdAt: prev.createdAt,
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
