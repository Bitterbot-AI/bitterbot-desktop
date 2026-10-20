/**
 * PLAN-57: the `compute` tool.
 *
 * Phase 0: status, jobs, job, result, estimate (read-only).
 * Phase 2: submit and cancel for private and collective pools, owner turns
 * only, with PLAN-16 task linkage. Phase 4 lets an owner turn submit a
 * `paid_usdc` job when `compute.paid.enabled` is on; the job stops at
 * awaiting_payment and the quote becomes a review hold. Funding is not on
 * this surface at all (there is no action for it), and
 * funding never arrives here at all (§4.8: the agent has no path to fund an
 * escrow; the owner approves through the review rail).
 *
 * The tool exists only when `compute.enabled` is not false AND a backend
 * is registered (the Soapbox plugin registers one). Without a backend the
 * tool is absent and the prompt section with it, so a node with no pool
 * spends nothing on compute awareness. Submit and cancel exist only when the
 * backend implements them and the runtime (delivery store, watcher) is
 * registered, so a read-only backend yields a read-only tool.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  type ComputeBackend,
  type ComputeJobSummary,
  type ComputeQuote,
  type ComputeSnapshot,
  type ComputeSubmitRequest,
  type ComputeWorkloadKind,
  DEFAULT_MAX_USDC_PER_JOB,
  estimateCompute,
  getComputeBackend,
  getComputeRuntime,
  linkComputeJobToTask,
  COMPUTE_MAX_INPUTS,
} from "../../compute/awareness/index.js";
import type { BitterbotConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const READ_ACTIONS = ["status", "jobs", "job", "result", "estimate"] as const;
const WRITE_ACTIONS = ["submit", "cancel"] as const;
const WORKLOADS: readonly ComputeWorkloadKind[] = ["sha256", "embeddings"];

/** Results larger than this are written to the workspace instead of inlined. */
export const COMPUTE_RESULT_MAX_CHARS = 20_000;
/** Same bounds as the coordinator: 1..128 inputs, 256 KiB total. */
export { COMPUTE_MAX_INPUTS };
export const COMPUTE_MAX_INPUT_BYTES = 256 * 1024;

// Flattened schema (not a union): Claude on Vertex rejects nested anyOf.
function buildSchema(actions: readonly string[]) {
  return Type.Object({
    action: stringEnum(actions as readonly [string, ...string[]], {
      description: actions.join(", ") + ".",
    }),
    job_id: Type.Optional(Type.String({ description: "Job id (for job, result, cancel)." })),
    limit: Type.Optional(
      Type.Number({ description: "Max jobs to return (for jobs, default 10, max 50)." }),
    ),
    status_filter: Type.Optional(
      Type.String({ description: "Only jobs in this status (for jobs), e.g. running." }),
    ),
    workload: Type.Optional(
      Type.String({ description: "Workload kind (for estimate, submit): sha256 or embeddings." }),
    ),
    items: Type.Optional(Type.Number({ description: "Number of inputs (for estimate)." })),
    scope: Type.Optional(
      Type.String({
        description:
          "Pool id (mode private) or project id (mode collective). Restricts an estimate; required for submit.",
      }),
    ),
    mode: Type.Optional(
      Type.String({
        description:
          "private or collective (for submit); paid_usdc only where paid compute is enabled, and then the job waits for the owner to fund it.",
      }),
    ),
    max_cost_usdc: Type.Optional(
      Type.Number({
        description:
          "Ceiling in USDC for a paid_usdc submit; the coordinator quotes at or below it.",
      }),
    ),
    inputs: Type.Optional(
      Type.Array(Type.String(), {
        description: "The texts to process (for submit): 1 to 128 strings, 256 KiB in total.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Embedding model name (for submit, embeddings)." }),
    ),
    model_digest: Type.Optional(
      Type.String({ description: "Embedding model digest (for estimate and submit)." }),
    ),
    task_id: Type.Optional(
      Type.String({
        description:
          "Long-horizon task this job belongs to (for submit). The task waits on the job and resumes when it finishes.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        description: "Why this job is being submitted (for submit, recorded on the task).",
      }),
    ),
  });
}

type ComputeToolOptions = {
  config?: BitterbotConfig;
  /** Only `true` is an owner; submit and cancel are refused otherwise. */
  senderIsOwner?: boolean;
  agentSessionKey?: string;
  /** Where oversized results are written (`<workspace>/compute/<job>.json`). */
  workspaceDir?: string;
};

export function createComputeTool(opts?: ComputeToolOptions): AnyAgentTool | undefined {
  if (opts?.config?.compute?.enabled === false) {
    return undefined;
  }
  const backend = getComputeBackend();
  if (!backend) {
    return undefined;
  }
  const runtime = getComputeRuntime();
  const canWrite = typeof backend.submit === "function" && runtime !== null;
  const actions = canWrite ? [...READ_ACTIONS, ...WRITE_ACTIONS] : [...READ_ACTIONS];
  const isOwner = opts?.senderIsOwner === true;
  const paidEnabled = opts?.config?.compute?.paid?.enabled === true;
  const maxUsdcPerJob = opts?.config?.compute?.paid?.maxUsdcPerJob ?? DEFAULT_MAX_USDC_PER_JOB;

  const paidDoc = paidEnabled
    ? ` Or mode paid_usdc with max_cost_usdc (no scope): the job then waits at awaiting_payment with its quote until the owner approves it; you cannot fund it.`
    : ` Paid modes are not available here.`;
  const writeDoc = canWrite
    ? `
- submit: run a batch on a pool. Requires: mode (private|collective), scope (pool or project id), workload, inputs. For embeddings also model and model_digest. Optional: task_id (the task waits and resumes when the job finishes), reason. Owner turns only.${paidDoc}
- cancel: cancel a job you started. Requires: job_id. Owner turns only.`
    : "";

  return {
    label: "Compute",
    name: "compute",
    description: `Compute pools: your own machine and any pools this node has joined can run batches of work (sha256 batches, text embeddings on a pinned model). Actions:
- status: pools, workers (online, GPU, paused), credits, jobs in flight. Read this before quoting what compute is available.
- jobs: recent jobs. Optional: limit, status_filter.
- job: one job's state. Requires: job_id.
- result: a finished job's result and receipt (large results are written to the workspace and the path returned). Requires: job_id.
- estimate: where a batch would run, how long, what it would cost, with the local alternative. Requires: workload, items. Optional: scope, model_digest.${writeDoc}
Each job carries a verification level (recomputed, shape_only_trusted_worker, redundant); state it when you report a result. You cannot fund paid jobs: a paid job stops at awaiting_payment until the owner approves it.`,
    parameters: buildSchema(actions),
    execute: async (toolCallId, args) => {
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
          const oversized = serialised.length > COMPUTE_RESULT_MAX_CHARS;
          let resultPath: string | undefined;
          if (oversized && opts?.workspaceDir) {
            resultPath = writeResultFile(opts.workspaceDir, res.id, serialised);
          }
          return jsonResult({
            found: true,
            job_id: res.id,
            status: res.status,
            verification: res.verification ?? "unknown",
            error: res.error ?? null,
            receipt: res.receipt ?? null,
            result: oversized ? null : res.result,
            result_path: resultPath,
            result_summary: oversized
              ? resultPath
                ? `Result is ${serialised.length} characters; written to ${resultPath}.`
                : `Result is ${serialised.length} characters; too large to inline. It stays on the coordinator under this job id.`
              : undefined,
          });
        }
        case "estimate": {
          const workload = readWorkload(params);
          const items = readNumberParam(params, "items", { required: true, integer: true });
          if (items < 1) {
            throw new ToolInputError("items must be at least 1");
          }
          const snapshot = await backend.snapshot();
          const estimate = estimateCompute({
            snapshot,
            workload,
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
        case "submit": {
          if (!canWrite || !backend.submit || !runtime) {
            throw new ToolInputError("submit is not available on this node's compute backend");
          }
          if (!isOwner) {
            return jsonResult({
              ok: false,
              error: "Not available in this conversation: only the owner can start compute jobs.",
            });
          }
          const req = readSubmitRequest(params, toolCallId, { paidEnabled, maxUsdcPerJob });
          if (req.mode.kind === "paid_usdc") {
            const snapshot = await backend.snapshot();
            if (snapshot.paid?.available !== true) {
              return jsonResult({
                ok: false,
                error:
                  "The coordinator does not offer paid work to this node" +
                  (snapshot.paid?.reason ? ` (${snapshot.paid.reason})` : "") +
                  ". Use a private or collective pool, or the local alternative.",
              });
            }
          }
          const submitted = await backend.submit(req);
          runtime.store.recordOrigin(submitted.id, "agent", opts?.agentSessionKey ?? null);
          runtime.watcher?.kick();
          if (req.mode.kind === "paid_usdc") {
            return jsonResult({
              ok: true,
              job_id: submitted.id,
              status: submitted.status,
              mode: "paid_usdc",
              workload: req.workload,
              items: req.inputs.length,
              awaiting_payment: await holdPaidJob({
                backend,
                jobId: submitted.id,
                workload: req.workload,
                items: req.inputs.length,
                sessionKey: opts?.agentSessionKey,
              }),
              note: "Tell the user the cost and that it is waiting for their approval. You cannot fund it, and asking again does not help; you will be told when it finishes.",
            });
          }
          const taskId = readStringParam(params, "task_id");
          let task: Record<string, unknown> | undefined;
          if (taskId) {
            const link = await linkComputeJobToTask({
              taskId,
              jobId: submitted.id,
              workload: req.workload,
              items: req.inputs.length,
              reason: readStringParam(params, "reason"),
            });
            if ("error" in link) {
              task = { task_id: taskId, linked: false, error: link.error };
            } else {
              runtime.store.recordOrigin(submitted.id, "agent", opts?.agentSessionKey ?? null, {
                taskId: link.taskId,
                wakeupJobId: link.wakeupJobId,
              });
              task = {
                task_id: link.taskId,
                linked: true,
                status: "waiting_external",
                fallback_wakeup: link.wakeupJobId,
              };
            }
          }
          return jsonResult({
            ok: true,
            job_id: submitted.id,
            status: submitted.status,
            mode: req.mode.kind,
            scope:
              req.mode.kind === "private"
                ? req.mode.poolId
                : req.mode.kind === "collective"
                  ? req.mode.projectId
                  : null,
            workload: req.workload,
            items: req.inputs.length,
            task,
            note: "You will be told when it finishes. Do not poll `job` in a loop; check on demand only.",
          });
        }
        case "cancel": {
          if (!canWrite || !backend.cancel || !runtime) {
            throw new ToolInputError("cancel is not available on this node's compute backend");
          }
          if (!isOwner) {
            return jsonResult({
              ok: false,
              error: "Not available in this conversation: only the owner can cancel compute jobs.",
            });
          }
          const id = readStringParam(params, "job_id", { required: true });
          const origin = runtime.store.originOf(id);
          if (!origin || origin.origin !== "agent") {
            return jsonResult({
              ok: false,
              job_id: id,
              error: "Only jobs this agent started can be cancelled from here.",
            });
          }
          const res = await backend.cancel(id);
          runtime.watcher?.kick();
          return jsonResult({
            ok: res.ok,
            job_id: id,
            status: res.status ?? null,
            error: res.error ?? null,
          });
        }
        default:
          throw new ToolInputError(`Unknown action: ${action}`);
      }
    },
  };
}

function readWorkload(params: Record<string, unknown>): ComputeWorkloadKind {
  const workload = readStringParam(params, "workload", { required: true });
  if (!WORKLOADS.includes(workload as ComputeWorkloadKind)) {
    throw new ToolInputError(`workload must be one of: ${WORKLOADS.join(", ")}`);
  }
  return workload as ComputeWorkloadKind;
}

/**
 * PLAN-57 §4.8: a paid job the agent submitted becomes a review hold at its
 * quote. The hold is what the owner approves; approving it runs the funding
 * path with the approving connection's authority, never the agent's.
 */
async function holdPaidJob(input: {
  backend: ComputeBackend;
  jobId: string;
  workload: ComputeWorkloadKind;
  items: number;
  sessionKey?: string;
}): Promise<Record<string, unknown>> {
  const how =
    "The owner approves it in the Control UI (Activity) or with `bitterbot compute approve <job>`.";
  let quote: ComputeQuote | null = null;
  try {
    quote = (await input.backend.quote?.(input.jobId)) ?? null;
  } catch {
    quote = null;
  }
  if (!quote) {
    return { quoted: false, how };
  }
  let reviewId: string | null = null;
  try {
    const { getReviewService } = await import("../../review/runtime.js");
    const service = getReviewService();
    service.holdSpend({
      toolName: "compute",
      params: {
        action: "fund",
        job_id: input.jobId,
        quote_hash: quote.quoteHash,
        amount_usdc: quote.amountUsdc,
        payee: quote.payee,
      },
      preview: `Fund compute job ${input.jobId}: ${quote.amountUsdc} USDC to ${quote.payee} (${input.items} ${input.workload} items)`,
      ctx: { sessionKey: input.sessionKey },
    });
    reviewId = service.pendingFor("compute", { job_id: input.jobId })[0]?.id ?? null;
  } catch {
    reviewId = null;
  }
  try {
    const { recordConsideration } = await import("../../infra/heartbeat-considerations.js");
    recordConsideration({
      category: "compute-payment",
      subject: `compute job ${input.jobId}`,
      decision: "deferred",
      reason: "paid job quoted; waiting for the owner's approval",
      sessionKey: input.sessionKey,
      payload: { amountUsdc: quote.amountUsdc, payee: quote.payee, reviewId },
    });
  } catch {
    // Never fail a submit over the considerations log.
  }
  return {
    quoted: true,
    amount_usdc: quote.amountUsdc,
    payee: quote.payee,
    quote_hash: quote.quoteHash,
    review_id: reviewId,
    how,
  };
}

/** Gateway-side validation; the coordinator's own limits are the second line. */
export function readSubmitRequest(
  params: Record<string, unknown>,
  toolCallId: string,
  paid: { paidEnabled: boolean; maxUsdcPerJob: number } = {
    paidEnabled: false,
    maxUsdcPerJob: DEFAULT_MAX_USDC_PER_JOB,
  },
): ComputeSubmitRequest {
  const modeRaw = readStringParam(params, "mode", { required: true });
  if (modeRaw === "paid") {
    throw new ToolInputError(
      "Credit-paid jobs cannot be started from the agent. Quote the cost with estimate; the owner submits and funds paid work.",
    );
  }
  if (modeRaw === "paid_usdc" && !paid.paidEnabled) {
    throw new ToolInputError(
      "Paid compute is off on this node (compute.paid.enabled). Quote the cost with estimate; the owner can turn paid compute on.",
    );
  }
  if (modeRaw !== "private" && modeRaw !== "collective" && modeRaw !== "paid_usdc") {
    throw new ToolInputError("mode must be private, collective or paid_usdc");
  }
  const scope = readStringParam(params, "scope", { required: modeRaw !== "paid_usdc" });
  let maxCostUsdc = 0;
  if (modeRaw === "paid_usdc") {
    maxCostUsdc = readNumberParam(params, "max_cost_usdc", { required: true });
    if (!Number.isFinite(maxCostUsdc) || maxCostUsdc <= 0) {
      throw new ToolInputError("max_cost_usdc must be a positive number of USDC");
    }
    if (maxCostUsdc > paid.maxUsdcPerJob) {
      throw new ToolInputError(
        `max_cost_usdc ${maxCostUsdc} is above the owner's per-job cap of ${paid.maxUsdcPerJob} USDC (compute.paid.maxUsdcPerJob)`,
      );
    }
  }
  const workload = readWorkload(params);
  const inputs = readStringArrayParam(params, "inputs", { required: true });
  if (inputs.length < 1 || inputs.length > COMPUTE_MAX_INPUTS) {
    throw new ToolInputError(`inputs must hold 1 to ${COMPUTE_MAX_INPUTS} strings`);
  }
  let bytes = 0;
  for (const text of inputs) {
    if (typeof text !== "string" || text.length === 0) {
      throw new ToolInputError("every input must be a non-empty string");
    }
    bytes += Buffer.byteLength(text, "utf8");
  }
  if (bytes > COMPUTE_MAX_INPUT_BYTES) {
    throw new ToolInputError(`inputs exceed ${COMPUTE_MAX_INPUT_BYTES} bytes in total`);
  }
  const model = readStringParam(params, "model");
  const modelDigest = readStringParam(params, "model_digest");
  if (workload === "embeddings" && (!model || !modelDigest)) {
    throw new ToolInputError(
      "embeddings need model and model_digest (see compute status for the worker's pinned model)",
    );
  }
  return {
    mode:
      modeRaw === "paid_usdc"
        ? { kind: "paid_usdc", maxCostUsdc }
        : modeRaw === "private"
          ? { kind: "private", poolId: scope ?? "" }
          : { kind: "collective", projectId: scope ?? "" },
    workload,
    inputs,
    model,
    modelDigest,
    idempotencyKey: `agent:${toolCallId || randomUUID()}`,
  };
}

function writeResultFile(workspaceDir: string, jobId: string, serialised: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "job";
  const dir = path.join(workspaceDir, "compute");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe}.json`);
  fs.writeFileSync(file, serialised, { encoding: "utf8", mode: 0o600 });
  return file;
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

export function renderJob(j: ComputeJobSummary) {
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
