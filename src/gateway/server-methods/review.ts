/**
 * review.list / review.get / review.resolve: the owner's view of actions the
 * agent wanted to take and had to wait for (PLAN-53 Track B). All three need
 * operator.approvals, like the exec approvals they sit beside.
 */

import { getReviewService } from "../../review/runtime.js";
import { publicView } from "../../review/service.js";
import type { ReviewStatus } from "../../review/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const STATUSES = new Set<string>([
  "pending",
  "approved",
  "denied",
  "expired",
  "executed",
  "failed",
  "all",
]);

/** Chat replies and internal (backend-mode) connections are not owner surfaces for money. */
function ownerSurfaceForFunding(via: string, mode: string | null | undefined): boolean {
  return via.trim().toLowerCase() !== "chat" && (mode ?? "").toLowerCase() !== "backend";
}

export const reviewHandlers: GatewayRequestHandlers = {
  "review.list": ({ params, respond }) => {
    const status =
      typeof params.status === "string" && STATUSES.has(params.status) ? params.status : "pending";
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const service = getReviewService();
    respond(true, {
      actions: service.list({ status: status as ReviewStatus | "all", limit }).map(publicView),
      pending: service.pendingCount(),
    });
  },

  /** Every outbound payment the spend gate allowed or refused (PLAN-53 C0). */
  "review.spends": ({ params, respond }) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    respond(true, { decisions: getReviewService().listSpendDecisions(limit) });
  },

  "review.get": ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const action = id ? getReviewService().get(id) : null;
    if (!action) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown review id"));
      return;
    }
    respond(true, publicView(action));
  },

  "review.resolve": async ({ params, respond, client }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const decision = params.decision;
    if (!id || (decision !== "approve" && decision !== "deny")) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          'id and decision ("approve" or "deny") are required',
        ),
      );
      return;
    }
    const decidedBy =
      (typeof params.decidedBy === "string" && params.decidedBy.trim()) ||
      client?.connect?.client?.displayName ||
      client?.connect?.client?.id ||
      "operator";
    const decidedVia = typeof params.via === "string" ? params.via.slice(0, 40) : "control-ui";
    const connectionMode = client?.connect?.client?.mode ?? null;
    // PLAN-57 §4.8: a compute funding hold is approved only from an owner
    // surface. A chat reply or the node's own internal connection would be
    // refused by the signer anyway; refusing here leaves the row pending for
    // the owner instead of marking it failed.
    if (decision === "approve" && !ownerSurfaceForFunding(decidedVia, connectionMode)) {
      const pending = getReviewService().get(id);
      if (pending?.tool === "compute" && pending.status === "pending") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "compute funding cannot be approved from here; approve it in the Control UI or with `bitterbot compute approve <job>`",
          ),
        );
        return;
      }
    }
    const action = await getReviewService().resolve(id, decision, {
      decidedBy: String(decidedBy).slice(0, 120),
      decidedVia,
      note: typeof params.note === "string" ? params.note.slice(0, 500) : undefined,
      // For a shell command: allow it from now on, not only this once.
      ...(params.always === true ? { always: true } : {}),
      // PLAN-57 §4.8: executors that move money bind to the deciding connection.
      scopes: client?.connect?.scopes ?? [],
      connectionMode,
    });
    if (!action) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown or already decided"),
      );
      return;
    }
    respond(true, publicView(action));
  },
};
