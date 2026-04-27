import crypto from "node:crypto";
import { describeSchedule } from "./schedule.js";
import {
  type CronDelivery,
  type CronJob,
  type CronJobWire,
  type CronPayload,
  type CronSchedule,
  type CronSessionTarget,
  type CronWakeMode,
} from "./types.js";

// Convert RPC params (legacy or canonical) into a fully canonical CronJob.
// Throws on missing/invalid required fields. Caller is responsible for
// running `assertScheduleValid` afterwards if it needs to verify the schedule
// can be evaluated.
export function buildJobFromParams(params: Record<string, unknown>): CronJob {
  const now = Date.now();
  const jobId = pickId(params) ?? `cron_${shortId()}`;
  const schedule = pickSchedule(params);
  const sessionTarget = pickSessionTarget(params, schedule);
  const payload = pickPayload(params, sessionTarget);
  if (sessionTarget === "main" && payload.kind !== "systemEvent") {
    throw new Error('main session jobs require payload.kind = "systemEvent"');
  }
  if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
    throw new Error('isolated jobs require payload.kind = "agentTurn"');
  }
  const wakeMode = pickWakeMode(params);
  const enabled = params.enabled === undefined ? true : Boolean(params.enabled);
  const name = readString(params.name) ?? readString(params.label);
  const description = readString(params.description);
  const agentId = readString(params.agentId) ?? readString(params.agent);
  const delivery = pickDelivery(params, sessionTarget);
  const notify = params.notify === undefined ? undefined : Boolean(params.notify);
  const deleteAfterRun = pickDeleteAfterRun(params, schedule);

  return {
    jobId,
    name,
    description,
    enabled,
    agentId,
    schedule,
    sessionTarget,
    wakeMode,
    payload,
    delivery,
    notify,
    deleteAfterRun,
    consecutiveErrors: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyJobPatch(existing: CronJob, patch: Record<string, unknown>): CronJob {
  const out: CronJob = { ...existing };
  if ("enabled" in patch) {
    out.enabled = Boolean(patch.enabled);
  }
  if ("name" in patch || "label" in patch) {
    const next = readString(patch.name) ?? readString(patch.label);
    out.name = next ?? undefined;
  }
  if ("description" in patch) {
    out.description = readString(patch.description) ?? undefined;
  }
  if ("schedule" in patch) {
    out.schedule = pickSchedule(patch);
  }
  if ("sessionTarget" in patch) {
    out.sessionTarget = pickSessionTarget(patch, out.schedule);
  }
  if ("payload" in patch) {
    out.payload = pickPayload(patch, out.sessionTarget);
  }
  if ("wakeMode" in patch) {
    out.wakeMode = pickWakeMode(patch);
  }
  if ("delivery" in patch) {
    out.delivery = pickDelivery(patch, out.sessionTarget);
  }
  if ("notify" in patch) {
    out.notify = patch.notify === null ? undefined : Boolean(patch.notify);
  }
  if ("deleteAfterRun" in patch) {
    out.deleteAfterRun = patch.deleteAfterRun === null ? undefined : Boolean(patch.deleteAfterRun);
  }
  if ("agentId" in patch || "agent" in patch) {
    if (patch.agentId === null || patch.agent === null) {
      out.agentId = undefined;
    } else {
      const next = readString(patch.agentId) ?? readString(patch.agent);
      if (next) {
        out.agentId = next;
      }
    }
  }
  if (out.sessionTarget === "main" && out.payload.kind !== "systemEvent") {
    throw new Error('main session jobs require payload.kind = "systemEvent"');
  }
  if (out.sessionTarget === "isolated" && out.payload.kind !== "agentTurn") {
    throw new Error('isolated jobs require payload.kind = "agentTurn"');
  }
  out.updatedAt = Date.now();
  return out;
}

export function jobToWire(job: CronJob): CronJobWire {
  const text = job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message;
  return {
    id: job.jobId,
    jobId: job.jobId,
    label: job.name,
    name: job.name,
    description: job.description,
    schedule: describeSchedule(job.schedule),
    text,
    enabled: job.enabled,
    sessionKey: job.sessionTarget === "isolated" ? `cron:${job.jobId}` : undefined,
    lastRunAt: job.lastRunAt,
    nextRunAt: job.nextRunAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    agentId: job.agentId,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    delivery: job.delivery,
    notify: job.notify,
    deleteAfterRun: job.deleteAfterRun,
    consecutiveErrors: job.consecutiveErrors,
    lastRunStatus: job.lastRunStatus,
  };
}

function pickId(params: Record<string, unknown>): string | undefined {
  const next = readString(params.jobId) ?? readString(params.id);
  if (!next) {
    return undefined;
  }
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(next)) {
    throw new Error("jobId must match /^[a-zA-Z0-9._-]{1,128}$/");
  }
  return next;
}

function pickSchedule(params: Record<string, unknown>): CronSchedule {
  const raw = params.schedule;

  // Object form (canonical).
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const kind = readString(obj.kind);
    if (kind === "at") {
      const at = readString(obj.at);
      if (!at) {
        throw new Error("schedule.at is required");
      }
      return { kind: "at", at };
    }
    if (kind === "every") {
      const everyMs =
        typeof obj.everyMs === "number" ? obj.everyMs : Number(obj.everyMs ?? Number.NaN);
      if (!Number.isFinite(everyMs)) {
        throw new Error("schedule.everyMs is required for every-schedules");
      }
      return { kind: "every", everyMs };
    }
    if (kind === "cron") {
      const expr = readString(obj.expr);
      if (!expr) {
        throw new Error("schedule.expr is required for cron-schedules");
      }
      const tz = readString(obj.tz);
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }
    throw new Error(`unsupported schedule.kind: ${kind ?? "<missing>"}`);
  }

  // Convenience: a bare string under `schedule` is treated as a cron expression.
  const exprFromShortcut = readString(raw);
  if (exprFromShortcut) {
    const tz = readString(params.tz);
    return tz
      ? { kind: "cron", expr: exprFromShortcut, tz }
      : { kind: "cron", expr: exprFromShortcut };
  }

  // Convenience: top-level `at` / `everyMs` / `cron` keys.
  const at = readString(params.at);
  if (at) {
    return { kind: "at", at };
  }
  if (typeof params.everyMs === "number") {
    return { kind: "every", everyMs: params.everyMs };
  }
  const cronExpr = readString(params.cron);
  if (cronExpr) {
    const tz = readString(params.tz);
    return tz ? { kind: "cron", expr: cronExpr, tz } : { kind: "cron", expr: cronExpr };
  }

  throw new Error("schedule is required (object form or { at | everyMs | cron })");
}

function pickSessionTarget(
  params: Record<string, unknown>,
  schedule: CronSchedule,
): CronSessionTarget {
  const raw = readString(params.sessionTarget) ?? readString(params.session);
  if (raw === "main" || raw === "isolated") {
    return raw;
  }
  // Defaults: cron/every → isolated, at → main (matches the docs' usage examples).
  if (raw) {
    throw new Error(`sessionTarget must be "main" or "isolated", got "${raw}"`);
  }
  return schedule.kind === "at" ? "main" : "isolated";
}

function pickPayload(
  params: Record<string, unknown>,
  sessionTarget: CronSessionTarget,
): CronPayload {
  const raw = params.payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const kind = readString(obj.kind);
    if (kind === "systemEvent") {
      const text = readString(obj.text) ?? readString(obj.message);
      if (!text) {
        throw new Error("payload.text is required for systemEvent payloads");
      }
      return { kind: "systemEvent", text };
    }
    if (kind === "agentTurn") {
      const message = readString(obj.message) ?? readString(obj.text);
      if (!message) {
        throw new Error("payload.message is required for agentTurn payloads");
      }
      const out: CronPayload = { kind: "agentTurn", message };
      const model = readString(obj.model);
      if (model) {
        (out as { model?: string }).model = model;
      }
      const thinking = readString(obj.thinking);
      if (thinking) {
        (out as { thinking?: string }).thinking = thinking;
      }
      const timeout = obj.timeoutSeconds;
      if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
        (out as { timeoutSeconds?: number }).timeoutSeconds = Math.floor(timeout);
      }
      return out;
    }
    throw new Error(`unsupported payload.kind: ${kind ?? "<missing>"}`);
  }

  // Convenience form (matches the cron-store wire shape and CLI flags).
  const systemEvent = readString(params.systemEvent);
  if (systemEvent) {
    return { kind: "systemEvent", text: systemEvent };
  }
  const message = readString(params.message);
  if (message) {
    return { kind: "agentTurn", message };
  }
  const text = readString(params.text);
  if (text) {
    return sessionTarget === "main"
      ? { kind: "systemEvent", text }
      : { kind: "agentTurn", message: text };
  }
  throw new Error("payload is required (object form, or { systemEvent | message | text })");
}

function pickWakeMode(params: Record<string, unknown>): CronWakeMode {
  const raw = readString(params.wakeMode) ?? readString(params.wake);
  if (raw === "now" || raw === "next-heartbeat") {
    return raw;
  }
  if (raw) {
    throw new Error(`wakeMode must be "now" or "next-heartbeat", got "${raw}"`);
  }
  return "now";
}

function pickDelivery(
  params: Record<string, unknown>,
  sessionTarget: CronSessionTarget,
): CronDelivery | undefined {
  const raw = params.delivery;
  if (raw === null) {
    return undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (sessionTarget !== "isolated") {
      throw new Error("delivery is only valid for isolated jobs");
    }
    const obj = raw as Record<string, unknown>;
    const mode = readString(obj.mode);
    if (mode !== "announce" && mode !== "none") {
      throw new Error(`delivery.mode must be "announce" or "none", got "${mode ?? "<missing>"}"`);
    }
    const out: CronDelivery = { mode };
    const channel = readString(obj.channel);
    if (channel) {
      out.channel = channel;
    }
    const to = readString(obj.to);
    if (to) {
      out.to = to;
    }
    if (obj.bestEffort !== undefined) {
      out.bestEffort = Boolean(obj.bestEffort);
    }
    return out;
  }
  // Convenience flags.
  if (params.announce === true || readString(params.deliver) === "announce") {
    if (sessionTarget !== "isolated") {
      throw new Error("--announce is only valid for isolated jobs");
    }
    const out: CronDelivery = { mode: "announce" };
    const channel = readString(params.channel);
    if (channel) {
      out.channel = channel;
    }
    const to = readString(params.to);
    if (to) {
      out.to = to;
    }
    return out;
  }
  if (params.noDeliver === true || readString(params.deliver) === "none") {
    if (sessionTarget !== "isolated") {
      throw new Error("--no-deliver is only valid for isolated jobs");
    }
    return { mode: "none" };
  }
  return undefined;
}

function pickDeleteAfterRun(
  params: Record<string, unknown>,
  schedule: CronSchedule,
): boolean | undefined {
  if ("deleteAfterRun" in params) {
    const v = params.deleteAfterRun;
    if (v === null || v === undefined) {
      return undefined;
    }
    return Boolean(v);
  }
  if (params.keepAfterRun === true) {
    return false;
  }
  // One-shot jobs default to delete-after-success.
  if (schedule.kind === "at") {
    return true;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shortId(): string {
  return crypto.randomBytes(6).toString("hex");
}
