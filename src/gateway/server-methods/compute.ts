/**
 * compute.quote / compute.approve (PLAN-57 §4.8): the owner's view of a paid
 * compute job waiting for money, and the one gateway surface that funds it.
 * `compute.quote` needs operator.read. `compute.approve` is admin-only and
 * passes the connection's scopes to the signer, which binds the approval to
 * them; the Control UI's Compute tab and `bitterbot compute approve` call it.
 */

import {
  type ComputeQuote,
  getComputeBackend,
  getComputeRuntime,
} from "../../compute/awareness/index.js";
import {
  approveComputeFunding,
  DEFAULT_MAX_USDC_PER_DAY,
  DEFAULT_MAX_USDC_PER_JOB,
} from "../../compute/awareness/payment.js";
import { loadConfig } from "../../config/config.js";
import { getReviewService } from "../../review/runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

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
    const paid = loadConfig().compute?.paid;
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
      paid: {
        enabled: paid?.enabled === true,
        maxUsdcPerJob: paid?.maxUsdcPerJob ?? DEFAULT_MAX_USDC_PER_JOB,
        maxUsdcPerDay: paid?.maxUsdcPerDay ?? DEFAULT_MAX_USDC_PER_DAY,
      },
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
