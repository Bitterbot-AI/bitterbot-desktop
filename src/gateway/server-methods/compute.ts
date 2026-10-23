/**
 * The compute gateway methods (PLAN-57 §4.8 and Phase 5).
 *
 * Read (operator.read): `compute.status` (the secret-free snapshot the agent
 * sees, plus the owner's trust settings), `compute.jobs`, `compute.quote`.
 * Admin only: `compute.approve` (the one surface that funds a paid job; it
 * passes the connection's scopes and mode to the signer), `compute.pause`
 * (pause or resume one of this node's workers) and `compute.trust` (set a
 * pool's trust in the config). `bitterbot compute` is the CLI over them.
 */

import { renderJob, renderStatus } from "../../agents/tools/compute-tool.js";
import {
  type ComputeQuote,
  type ComputeSnapshot,
  getComputeBackend,
  getComputeRuntime,
  resolvePoolTrust,
} from "../../compute/awareness/index.js";
import {
  approveComputeFunding,
  DEFAULT_MAX_USDC_PER_DAY,
  DEFAULT_MAX_USDC_PER_JOB,
} from "../../compute/awareness/payment.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  validateConfigObject,
  writeConfigFile,
} from "../../config/config.js";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import { getReviewService } from "../../review/runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const TRUST_LEVELS = new Set(["trusted", "untrusted"]);
const POOL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
/** Keys that must never become object properties on the config object. */
const FORBIDDEN_POOL_IDS = new Set(["__proto__", "constructor", "prototype"]);

function paidView(cfg: BitterbotConfig) {
  const paid = cfg.compute?.paid;
  return {
    enabled: paid?.enabled === true,
    maxUsdcPerJob: paid?.maxUsdcPerJob ?? DEFAULT_MAX_USDC_PER_JOB,
    maxUsdcPerDay: paid?.maxUsdcPerDay ?? DEFAULT_MAX_USDC_PER_DAY,
  };
}

function readJobId(params: Record<string, unknown>): string {
  const raw = params.jobId ?? params.job_id;
  return typeof raw === "string" ? raw.trim() : "";
}

function pendingHoldsFor(jobId: string) {
  try {
    return getReviewService().pendingFor("compute", { job_id: jobId });
  } catch {
    return [];
  }
}

export const computeHandlers: GatewayRequestHandlers = {
  "compute.quote": async ({ params, respond }) => {
    const jobId = readJobId(params);
    if (!jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId is required"));
      return;
    }
    const backend = getComputeBackend();
    if (!backend || typeof backend.quote !== "function") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "this node's compute backend does not quote paid jobs"),
      );
      return;
    }
    let quote: ComputeQuote | null;
    try {
      quote = await backend.quote(jobId);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    let fundedTx: string | null = null;
    try {
      fundedTx = getComputeRuntime()?.store.ledger().fundedTxFor(jobId) ?? null;
    } catch {
      fundedTx = null;
    }
    respond(true, {
      jobId,
      quote: quote
        ? {
            amountUsdc: quote.amountUsdc,
            payee: quote.payee,
            network: quote.network ?? null,
            expiresAt: quote.expiresAt ?? null,
            quoteHash: quote.quoteHash,
          }
        : null,
      pendingReview: pendingHoldsFor(jobId)[0]?.id ?? null,
      fundedTx,
      paid: paidView(loadConfig()),
    });
  },

  /** The owner's view: what the agent sees in `compute status`, plus the trust settings. */
  "compute.status": async ({ respond }) => {
    const backend = getComputeBackend();
    if (!backend) {
      respond(true, {
        backend: false,
        reachable: false,
        pools: [],
        workers: [],
        jobs_in_flight: [],
      });
      return;
    }
    let snapshot: ComputeSnapshot;
    try {
      snapshot = await backend.snapshot();
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const cfg = loadConfig();
    const view = renderStatus(snapshot);
    respond(true, {
      backend: true,
      ...view,
      pools: view.pools.map((p) => ({ ...p, configured_trust: resolvePoolTrust(cfg, p.id) })),
      paid: { ...paidView(cfg), available: snapshot.paid?.available === true },
      runtime: getComputeRuntime() !== null,
    });
  },

  "compute.jobs": async ({ params, respond }) => {
    const backend = getComputeBackend();
    if (!backend) {
      respond(true, { jobs: [] });
      return;
    }
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(200, Math.floor(params.limit)))
        : 20;
    const status = typeof params.status === "string" ? params.status.trim() : "";
    try {
      const jobs = await backend.jobs({ limit, ...(status ? { status } : {}) });
      respond(true, { jobs: jobs.map(renderJob) });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  /** Pause or resume one of this node's workers. Admin only. */
  "compute.pause": async ({ params, respond }) => {
    const workerId = typeof params.workerId === "string" ? params.workerId.trim() : "";
    if (!workerId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workerId is required"));
      return;
    }
    const paused = params.paused !== false;
    const backend = getComputeBackend();
    if (!backend || typeof backend.pauseWorker !== "function") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "this node's compute backend cannot pause workers"),
      );
      return;
    }
    try {
      const res = await backend.pauseWorker(workerId, paused);
      if (!res.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, res.error ?? "the backend refused"),
        );
        return;
      }
      getComputeRuntime()?.watcher?.kick();
      respond(true, { workerId, paused: res.paused ?? paused });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  /**
   * Set a pool's trust (`compute.pools.<id>.trust`). Admin only. The egress
   * policy reads it when the memory manager is built, so it applies on the
   * next gateway restart; the response says so.
   */
  "compute.trust": async ({ params, respond }) => {
    const poolId = typeof params.poolId === "string" ? params.poolId.trim() : "";
    const trust = typeof params.trust === "string" ? params.trust.trim() : "";
    const invalid = (message: string) => {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    };
    if (!POOL_ID_RE.test(poolId) || FORBIDDEN_POOL_IDS.has(poolId)) {
      invalid("poolId must be 1 to 64 characters of letters, digits, '.', '_', ':' or '-'");
      return;
    }
    if (!TRUST_LEVELS.has(trust)) {
      invalid("trust must be trusted or untrusted");
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    // A config that does not parse is never overwritten from here: the owner
    // would lose the file to a one-key replacement (config-cli guards the same).
    if (!snapshot.exists || !snapshot.valid) {
      invalid(
        snapshot.exists
          ? `the config file is invalid and was left untouched: ${snapshot.issues
              .map((i) => `${i.path || "<root>"}: ${i.message}`)
              .join("; ")}`
          : "no config file exists yet; run `bitterbot onboard` first",
      );
      return;
    }
    // Edit the resolved file contents, not the runtime-merged config, so no
    // defaults leak into the written file.
    const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
    const compute =
      next.compute && typeof next.compute === "object"
        ? (next.compute as Record<string, unknown>)
        : {};
    const pools =
      compute.pools && typeof compute.pools === "object"
        ? (compute.pools as Record<string, unknown>)
        : {};
    const entry =
      pools[poolId] && typeof pools[poolId] === "object"
        ? (pools[poolId] as Record<string, unknown>)
        : {};
    pools[poolId] = { ...entry, trust };
    compute.pools = pools;
    next.compute = compute;
    const validated = validateConfigObject(next);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `config would be invalid: ${validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        ),
      );
      return;
    }
    await writeConfigFile(next as BitterbotConfig, writeOptions);
    respond(true, {
      poolId,
      trust,
      note: "Applies to new memory embedding batches after the next gateway restart.",
    });
  },

  "compute.approve": async ({ params, respond, client }) => {
    const jobId = readJobId(params);
    if (!jobId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "jobId is required"));
      return;
    }
    const decidedBy = String(
      (typeof params.decidedBy === "string" && params.decidedBy.trim()) ||
        client?.connect?.client?.displayName ||
        client?.connect?.client?.id ||
        "operator",
    ).slice(0, 120);
    const via = typeof params.via === "string" ? params.via.slice(0, 40) : "gateway";
    const holds = pendingHoldsFor(jobId);
    const heldHash = (holds[0]?.params as { quote_hash?: unknown } | undefined)?.quote_hash;
    // The approval is for an exact quote: the one the caller looked at, or the
    // one the agent's hold was created with. Never "whatever it costs now".
    const expectedQuoteHash =
      typeof params.quoteHash === "string" && params.quoteHash.trim()
        ? params.quoteHash.trim()
        : typeof heldHash === "string"
          ? heldHash
          : null;
    if (!expectedQuoteHash) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "quoteHash is required: call compute.quote first and approve the quote you saw",
        ),
      );
      return;
    }
    const result = await approveComputeFunding({
      jobId,
      expectedQuoteHash,
      authority: {
        origin: "owner",
        scopes: client?.connect?.scopes ?? [],
        via,
        connectionMode: client?.connect?.client?.mode ?? null,
        decidedBy,
        reviewId: holds[0]?.id ?? null,
      },
    });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `${result.reason}: ${result.message}`),
      );
      return;
    }
    // The agent's hold for this job, if any, is settled by this funding.
    for (const hold of holds) {
      try {
        getReviewService().settleExternally(
          hold.id,
          { decidedBy, decidedVia: via, scopes: client?.connect?.scopes ?? [] },
          {
            ok: true,
            summary: `Funded compute job ${result.jobId}: ${result.amountUsdc} USDC to ${result.payee}. Transaction ${result.txHash} (${result.status}).`,
          },
        );
      } catch {
        // The funding stands; the hold expires on its own if it cannot be settled.
      }
    }
    respond(true, { ...result, settledReviews: holds.map((h) => h.id) });
  },
};
