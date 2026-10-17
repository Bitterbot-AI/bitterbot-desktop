/**
 * PLAN-57 Phase 0: the `compute` tool. Read-only in this phase: status,
 * jobs, job, result, estimate. Submit and cancel arrive in Phase 2, and
 * funding never arrives here at all (§4.8: the agent has no path to fund an
 * escrow; the owner approves through the review rail).
 *
 * The tool exists only when `compute.enabled` is not false AND a backend
 * is registered (the Soapbox plugin registers one). Without a backend the
 * tool is absent and the prompt section with it, so a node with no pool
 * spends nothing on compute awareness.
 */

import { Type } from "@sinclair/typebox";
import {
  type ComputeJobSummary,
  type ComputeSnapshot,
  type ComputeWorkloadKind,
  estimateCompute,
  getComputeBackend,
} from "../../compute/awareness/index.js";
import type { BitterbotConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

const COMPUTE_ACTIONS = ["status", "jobs", "job", "result", "estimate"] as const;
const WORKLOADS: readonly ComputeWorkloadKind[] = ["sha256", "embeddings"];

/** Results larger than this are summarised; the agent asks for the file in Phase 2. */
export const COMPUTE_RESULT_MAX_CHARS = 20_000;

// Flattened schema (not a union): Claude on Vertex rejects nested anyOf.
const ComputeToolSchema = Type.Object({
  action: stringEnum(COMPUTE_ACTIONS, {
    description: "status, jobs, job, result, or estimate.",
  }),
  job_id: Type.Optional(Type.String({ description: "Job id (for job, result)." })),
  limit: Type.Optional(
    Type.Number({ description: "Max jobs to return (for jobs, default 10, max 50)." }),
  ),
  status_filter: Type.Optional(
    Type.String({ description: "Only jobs in this status (for jobs), e.g. running." }),
  ),
  workload: Type.Optional(
    Type.String({ description: "Workload kind for estimate: sha256 or embeddings." }),
  ),
  items: Type.Optional(Type.Number({ description: "Number of inputs (for estimate)." })),
  scope: Type.Optional(
    Type.String({ description: "Restrict an estimate to one pool or project id." }),
  ),
  model_digest: Type.Optional(
    Type.String({ description: "Embedding model digest the job needs (for estimate)." }),
  ),
});

type ComputeToolOptions = {
  config?: BitterbotConfig;
};

export function createComputeTool(opts?: ComputeToolOptions): AnyAgentTool | undefined {
  if (opts?.config?.compute?.enabled === false) {
    return undefined;
  }
  const backend = getComputeBackend();
  if (!backend) {
    return undefined;
  }

  return {
    label: "Compute",
    name: "compute",
    description: `Compute pools: your own machine and any pools this node has joined can run batches of work (sha256 batches, text embeddings on a pinned model). Actions:
- status: pools, workers (online, GPU, paused), credits, jobs in flight. Read this before quoting what compute is available.
- jobs: recent jobs. Optional: limit, status_filter.
- job: one job's state. Requires: job_id.
- result: a finished job's result and receipt (large results are summarised). Requires: job_id.
- estimate: where a batch would run, how long, what it would cost, with the local alternative. Requires: workload, items. Optional: scope, model_digest.
Each job carries a verification level (recomputed, shape_only_trusted_worker, redundant); state it when you report a result. You cannot fund paid jobs: a paid job stops at awaiting_payment until the owner approves it.`,
    parameters: ComputeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "status": {
          const snapshot = await backend.snapshot();
          return jsonResult(renderStatus(snapshot));
        }
        case "jobs": {
          const limitRaw = readNumberParam(params, "limit", { integer: true });
          const limit = Math.min(50, Math.max(1, limitRaw ?? 10));
          const status = readStringParam(params, "status_filter");
          const jobs = await backend.jobs({ limit, status });
          return jsonResult({ count: jobs.length, jobs: jobs.map(renderJob) });
        }
        case "job": {
          const id = readStringParam(params, "job_id", { required: true });
          const job = await backend.job(id);
          if (!job) {
            return jsonResult({ found: false, job_id: id });
          }
          return jsonResult({ found: true, job: renderJob(job) });
        }
        case "result": {
          const id = readStringParam(params, "job_id", { required: true });
          const res = await backend.result(id);
          if (!res) {
            return jsonResult({ found: false, job_id: id });
          }
          const serialised = JSON.stringify(res.result ?? null);
          const truncated = serialised.length > COMPUTE_RESULT_MAX_CHARS;
          return jsonResult({
            found: true,
            job_id: res.id,
            status: res.status,
            verification: res.verification ?? "unknown",
            error: res.error ?? null,
            receipt: res.receipt ?? null,
            result: truncated ? null : res.result,
            result_summary: truncated
              ? `Result is ${serialised.length} characters; too large to inline. It stays on the coordinator under this job id.`
              : undefined,
          });
        }
        case "estimate": {
          const workload = readStringParam(params, "workload", { required: true });
          if (!WORKLOADS.includes(workload as ComputeWorkloadKind)) {
            throw new ToolInputError(`workload must be one of: ${WORKLOADS.join(", ")}`);
          }
          const items = readNumberParam(params, "items", { required: true, integer: true });
          if (items < 1) {
            throw new ToolInputError("items must be at least 1");
          }
          const snapshot = await backend.snapshot();
          const estimate = estimateCompute({
            snapshot,
            workload: workload as ComputeWorkloadKind,
            items,
            scope: readStringParam(params, "scope"),
            modelDigest: readStringParam(params, "model_digest"),
          });
          return jsonResult({
            ...estimate,
            local_alternative:
              "Local processing on this machine is always available and free; use it when no option is eligible or the estimate is not worth the handoff.",
          });
        }
        default:
          throw new ToolInputError(`Unknown action: ${action}`);
      }
    },
  };
}

/** The status view the agent sees. Field names are the vocabulary of the prompt section. */
export function renderStatus(s: ComputeSnapshot) {
  return {
    as_of: new Date(s.asOf).toISOString(),
    version: s.version,
    reachable: s.reachable,
    settlement: s.settlement ?? null,
    credits: s.credits ?? null,
    pools: s.pools.map((p) => ({
      id: p.id,
      kind: p.kind,
      trust: p.trust,
      workers_online: p.workersOnline,
      workers_total: p.workersTotal,
      gpu_workers_online: p.gpuWorkersOnline,
    })),
    workers: s.workers.map((w) => ({
      id: w.id,
      online: w.online,
      paused: w.paused,
      gpu: w.gpu,
      cpu_threads: w.cpuThreads,
      memory_mib: w.memoryMib,
      modes: w.modes,
      model: w.model ?? null,
      model_digest: w.modelDigest ?? null,
      isolation: w.isolation ?? null,
      gpu_unavailable_reason: w.gpuUnavailableReason ?? null,
    })),
    jobs_in_flight: s.jobs.filter((j) => isInFlight(j.status)).map(renderJob),
    jobs_needing_owner: s.jobs.filter((j) => j.status === "awaiting_payment").map(renderJob),
  };
}

export function isInFlight(status: string): boolean {
  return status === "queued" || status === "running" || status === "settlement_pending";
}

function renderJob(j: ComputeJobSummary) {
  return {
    id: j.id,
    status: j.status,
    mode: j.mode,
    scope: j.scope ?? null,
    workload: j.workload,
    items: j.items,
    attempts: j.attempts,
    worker: j.worker ?? null,
    verification: j.verification ?? null,
    error: j.error ?? null,
    awaiting_usdc: j.awaitingUsdc ?? null,
  };
}
