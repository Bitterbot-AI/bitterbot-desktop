/**
 * Gateway RPC handlers for management node operations.
 * Only functional when the node is running in management tier.
 */
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { loadConfig } from "../../config/config.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getMemorySearchManager } from "../../memory/index.js";

async function getManagementService() {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) throw new Error("memory manager unavailable");
  const service = (manager as any).managementNodeService;
  if (!service) throw new Error("management node service not available (this node is not a management node)");
  return service;
}

export const managementHandlers: GatewayRequestHandlers = {
  "management.census": async ({ respond }) => {
    try {
      const service = await getManagementService();
      const census = await service.runCensus();
      respond(true, census ?? { error: "census unavailable" });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "management.anomalies": async ({ respond }) => {
    try {
      const service = await getManagementService();
      const alerts = await service.getAnomalyAlerts();
      respond(true, { alerts });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "management.health": async ({ respond }) => {
    try {
      const service = await getManagementService();
      const census = service.getLatestCensus();
      respond(true, {
        networkHealthScore: census?.networkHealthScore ?? null,
        connectedPeers: census?.connectedPeers ?? 0,
        peersByTier: census?.peersByTier ?? {},
        lastCensusAt: census?.lastCensusAt ?? null,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "management.economics": async ({ respond }) => {
    try {
      const service = await getManagementService();
      const overview = service.getEconomicOverview();
      respond(true, overview);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "management.censusHistory": async ({ params, respond }) => {
    try {
      const service = await getManagementService();
      const limit = Math.min(Number(params?.limit) || 100, 500);
      const history = service.getCensusHistory(limit);
      respond(true, { history });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "management.propagateBan": async ({ params, respond }) => {
    try {
      const service = await getManagementService();
      const peerPubkey = String(params?.peerPubkey ?? "");
      const reason = String(params?.reason ?? "manual ban");
      if (!peerPubkey) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "peerPubkey required"));
        return;
      }
      const ok = await service.propagateBan(peerPubkey, reason);
      respond(true, { ok, peerPubkey, reason });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
