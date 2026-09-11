/**
 * Spend-grant operator RPCs (PLAN-48 Phase 0/2). The human sets, lists, and
 * revokes the signed spending budget the agent operates within, and resolves
 * escalation approvals for out-of-scope spends. Grants are signed by the node's
 * owner/device Ed25519 key and stored in the marketplace DB (the same DB the A2A
 * client reads when gating consent emission).
 *
 * These are gateway-authed operator methods (like circles.disclosure.set and
 * marketplace.listForSale): they set money-adjacent policy, so they sit behind
 * the operator surface, never on the public A2A endpoint.
 */

import type { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { loadNodeCircleSigner, verifyEd25519 } from "../../payments/ap2/ed25519.js";
import { SpendGrantStore } from "../../payments/grants/spend-grant-store.js";
import { buildSpendGrant, usdc } from "../../payments/grants/spend-grant.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

interface EconomicsView {
  getDb?(): DatabaseSync | undefined;
}
interface ManagerView {
  getMarketplaceEconomics?(): EconomicsView | null;
}

async function getGrantStore(): Promise<{ store: SpendGrantStore } | { error: string }> {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager, error } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return { error: error ?? "memory manager unavailable" };
  const db = (manager as unknown as ManagerView).getMarketplaceEconomics?.()?.getDb?.();
  if (!db) return { error: "marketplace db unavailable (payments not initialized)" };
  return { store: new SpendGrantStore(db) };
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

export const spendGrantHandlers: GatewayRequestHandlers = {
  "spendGrant.set": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    try {
      const allowanceUsd = typeof params.allowanceUsd === "number" ? params.allowanceUsd : NaN;
      if (!(allowanceUsd >= 0)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "allowanceUsd (>= 0) required"),
        );
        return;
      }
      const payees = strList(params.payees) ?? ["*"];
      const perTxUsd = typeof params.perTxUsd === "number" ? params.perTxUsd : undefined;
      const signer = await loadNodeCircleSigner();
      const grant = buildSpendGrant({
        ownerPubkey: signer.pubkey,
        scope: { allowed_payees: payees, categories: strList(params.categories) },
        allowance: usdc(allowanceUsd),
        periodSeconds: typeof params.periodSeconds === "number" ? params.periodSeconds : 86_400,
        perTxMax: perTxUsd !== undefined ? usdc(perTxUsd) : undefined,
        ttlMs: typeof params.ttlMs === "number" ? params.ttlMs : 30 * 86_400 * 1000,
        signOwner: signer.signEd25519,
      });
      r.store.setGrant(grant, verifyEd25519);
      respond(true, { grantId: grant.claims.grant_id, grant: grant.claims }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "spendGrant.list": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    const grants = r.store
      .listGrants({ includeInactive: params.includeInactive === true })
      .map((s) => ({ ...s.grant.claims, revokedAt: s.revokedAt }));
    respond(true, { grants }, undefined);
  },

  "spendGrant.revoke": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    const grantId = typeof params.grantId === "string" ? params.grantId : "";
    if (!grantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "grantId required"));
      return;
    }
    r.store.revokeGrant(grantId);
    respond(true, { grantId, revoked: true }, undefined);
  },

  "spendGrant.approvals": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    const status =
      params.status === "approved" || params.status === "denied" ? params.status : "pending";
    respond(true, { approvals: r.store.listApprovals(status) }, undefined);
  },

  "spendGrant.approve": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : "";
    if (!approvalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "approvalId required"));
      return;
    }
    try {
      const signer = await loadNodeCircleSigner();
      const grant = r.store.approve(
        approvalId,
        { ownerPubkey: signer.pubkey, signOwner: signer.signEd25519, verifyEd25519 },
        typeof params.ttlMs === "number" ? { ttlMs: params.ttlMs } : undefined,
      );
      respond(true, { approvalId, grantId: grant.claims.grant_id }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },

  "spendGrant.deny": async ({ params, respond }) => {
    const r = await getGrantStore();
    if ("error" in r) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, r.error));
      return;
    }
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : "";
    if (!approvalId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "approvalId required"));
      return;
    }
    r.store.deny(approvalId);
    respond(true, { approvalId, denied: true }, undefined);
  },
};
