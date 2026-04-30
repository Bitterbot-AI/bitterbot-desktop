import { Type } from "@sinclair/typebox";
import {
  getActiveOrchestratorBridge,
  type OrchestratorBridge,
} from "../../infra/orchestrator-bridge.js";
import { getP2pStatus } from "../../infra/p2p-status.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

/**
 * Layer 2 of agent self-awareness: an on-demand probe into the live P2P
 * state, deeper and fresher than what the system prompt's Economic
 * Identity block can carry.
 *
 * The system prompt block (layer 1) gives the agent ambient awareness
 * — identity, peer count, tier mix, network pulse — refreshed on a 30s
 * poll. This tool is the agent's microscope: it gives real-time
 * snapshots of peers, anomalies, telemetry, and the full census so the
 * agent can answer "what exactly is going on right now" without
 * waiting for the next poll.
 *
 * All actions are read-only by design. Agents do not publish, sign, or
 * propagate from this tool — those flows go through dedicated
 * management tools so the safety surface stays small.
 */

const NETWORK_STATUS_ACTIONS = [
  "summary",
  "peers",
  "anomalies",
  "census",
  "stats",
  "identity",
] as const;

const NetworkStatusSchema = Type.Object({
  action: stringEnum(NETWORK_STATUS_ACTIONS),
  /** For `peers`: max rows. Default 50, hard cap 200. */
  limit: Type.Optional(Type.Number()),
});

const NO_BRIDGE_ERROR =
  "network_status unavailable: orchestrator daemon not connected. " +
  "Enable p2p in config (or run `bitterbot doctor` for diagnostics).";

export function createNetworkStatusTool(): AnyAgentTool {
  return {
    label: "Network status",
    name: "network_status",
    description:
      "Probe the live P2P network state. Actions: summary (peers + tier + health), " +
      "peers (full peer table with tiers, addrs, reputation), anomalies (active alerts), " +
      "census (full management census), stats (raw libp2p counters), identity (your peer ID + tier). " +
      "Read-only; agents publish via dedicated management tools.",
    parameters: NetworkStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | (typeof NETWORK_STATUS_ACTIONS)[number]
        | undefined;
      if (!action) {
        return jsonResult({ ok: false, error: "missing action" });
      }
      const bridge = getActiveOrchestratorBridge();
      if (!bridge) {
        return jsonResult({ ok: false, error: NO_BRIDGE_ERROR });
      }

      try {
        switch (action) {
          case "summary":
            return jsonResult(await buildSummary(bridge));
          case "peers": {
            const limit = clampLimit(params.limit);
            return jsonResult(await fetchPeers(bridge, limit));
          }
          case "anomalies":
            return jsonResult(await fetchAnomalies(bridge));
          case "census":
            return jsonResult(await fetchCensus(bridge));
          case "stats":
            return jsonResult(await fetchStats(bridge));
          case "identity":
            return jsonResult(await fetchIdentity(bridge));
          default: {
            const _exhaustive: never = action;
            return jsonResult({ ok: false, error: `unknown action: ${String(_exhaustive)}` });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: `network_status failed: ${message}` });
      }
    },
  };
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(200, Math.floor(raw)));
}

/**
 * Compose the most useful single-call summary: bridge cache (for fields
 * that update reactively, like peerCount and identity) + a fresh census
 * call (for tier mix, health, and skills) + a fresh anomaly count. This
 * is the action the agent should reach for first.
 */
async function buildSummary(bridge: OrchestratorBridge): Promise<Record<string, unknown>> {
  const cached = getP2pStatus();
  const [census, alerts] = await Promise.all([
    bridge.getNetworkCensus(),
    bridge.getAnomalyAlerts(),
  ]);
  return {
    ok: true,
    enabled: cached.enabled,
    connected: cached.connected,
    peerId: cached.peerId,
    nodeTier: cached.nodeTier,
    peerCount: cached.peerCount,
    peersByTier: census?.peers_by_tier ?? cached.peersByTier,
    networkHealthScore: census?.network_health_score ?? cached.networkHealthScore,
    skillsPublishedNetworkWide:
      census?.skills_published_network_wide ?? cached.skillsPublishedNetworkWide,
    telemetryCountsByType: census?.telemetry_counts_by_type ?? cached.telemetryCountsByType,
    anomalyAlertCount: alerts.length,
    lifetimeUniquePeers: census?.lifetime_unique_peer_ids,
    peakConcurrentPeers: census?.peak_concurrent_peers,
  };
}

async function fetchPeers(
  bridge: OrchestratorBridge,
  limit: number,
): Promise<Record<string, unknown>> {
  const raw = (await bridge.getPeers()) as
    | { peers?: number; peer_details?: Record<string, PeerDetailLike> }
    | undefined;
  const peerDetails = raw?.peer_details ?? {};
  const rows = Object.entries(peerDetails)
    .map(([peerId, detail]) => ({
      peerId,
      tier: detail.tier ?? "",
      tierVerified: detail.tier_verified ?? false,
      addrs: detail.addrs ?? [],
      connectedAt: detail.connected_at ?? null,
      skillsReceivedFrom: detail.skills_received_from ?? 0,
      reputationScore: detail.reputation_score ?? 0,
    }))
    .toSorted((a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0))
    .slice(0, limit);
  return {
    ok: true,
    connectedPeers: raw?.peers ?? 0,
    peers: rows,
    truncated: Object.keys(peerDetails).length > limit,
  };
}

async function fetchAnomalies(bridge: OrchestratorBridge): Promise<Record<string, unknown>> {
  const alerts = await bridge.getAnomalyAlerts();
  return {
    ok: true,
    count: alerts.length,
    alerts,
  };
}

async function fetchCensus(bridge: OrchestratorBridge): Promise<Record<string, unknown>> {
  const census = await bridge.getNetworkCensus();
  if (!census) {
    return {
      ok: true,
      hasCensus: false,
      reason:
        "no management census available — this node is edge-tier or has not yet collected census state",
    };
  }
  // Strip the orchestrator's own `ok` so the tool's `ok` is the
  // authoritative one (the orchestrator returned ok=true to get here).
  const { ok: _censusOk, ...rest } = census;
  return { ok: true, hasCensus: true, ...rest };
}

async function fetchStats(bridge: OrchestratorBridge): Promise<Record<string, unknown>> {
  const raw = (await bridge.getStats()) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "no stats from orchestrator" };
  }
  return { ok: true, ...raw };
}

async function fetchIdentity(bridge: OrchestratorBridge): Promise<Record<string, unknown>> {
  const identity = await bridge.getIdentity();
  return { ok: true, ...identity };
}

type PeerDetailLike = {
  tier?: string;
  tier_verified?: boolean;
  addrs?: string[];
  connected_at?: number;
  skills_received_from?: number;
  reputation_score?: number;
};
