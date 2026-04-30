import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveOrchestratorBridge,
  type OrchestratorBridge,
} from "../../infra/orchestrator-bridge.js";
import { patchP2pStatus, resetP2pStatus } from "../../infra/p2p-status.js";
import { createNetworkStatusTool } from "./network-status-tool.js";

type Spies = {
  getNetworkCensus: ReturnType<typeof vi.fn>;
  getAnomalyAlerts: ReturnType<typeof vi.fn>;
  getPeers: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  getIdentity: ReturnType<typeof vi.fn>;
};

function makeFakeBridge(): { spies: Spies; bridge: OrchestratorBridge } {
  const spies: Spies = {
    getNetworkCensus: vi.fn().mockResolvedValue({
      ok: true,
      peers_by_tier: { edge: 3, management: 3 },
      network_health_score: 0.82,
      skills_published_network_wide: 14,
      telemetry_counts_by_type: { novelty: 38, experience: 7 },
      lifetime_unique_peer_ids: 12,
      peak_concurrent_peers: 8,
    }),
    getAnomalyAlerts: vi.fn().mockResolvedValue([
      { kind: "low_peer_count", severity: "warn" },
      { kind: "no_management", severity: "info" },
    ]),
    getPeers: vi.fn().mockResolvedValue({
      peers: 6,
      peer_details: {
        "12D3KooWAAA1": {
          tier: "edge",
          tier_verified: true,
          addrs: ["/ip4/1.2.3.4/tcp/9100"],
          connected_at: 100,
          skills_received_from: 0,
          reputation_score: 0.5,
        },
        "12D3KooWBBB2": {
          tier: "management",
          tier_verified: true,
          addrs: ["/ip4/5.6.7.8/tcp/9100"],
          connected_at: 200,
          skills_received_from: 2,
          reputation_score: 0.9,
        },
      },
    }),
    getStats: vi.fn().mockResolvedValue({
      peer_id: "12D3KooWLOCAL",
      connected_peers: 6,
      uptime_secs: 1234,
    }),
    getIdentity: vi.fn().mockResolvedValue({
      pubkey: "abc123==",
      peerId: "12D3KooWLOCAL",
      nodeTier: "edge",
    }),
  };
  return { spies, bridge: spies as unknown as OrchestratorBridge };
}

describe("network_status tool", () => {
  let spies: Spies;

  beforeEach(() => {
    const made = makeFakeBridge();
    spies = made.spies;
    setActiveOrchestratorBridge(made.bridge);
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 6,
      peerId: "12D3KooWLOCAL",
      nodeTier: "edge",
      peersByTier: { edge: 3, management: 3 },
      networkHealthScore: 0.5, // older than census; summary should prefer fresh
    });
  });

  afterEach(() => {
    setActiveOrchestratorBridge(null);
    resetP2pStatus();
  });

  it("summary returns identity + tier mix + fresh health from census", async () => {
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-1", { action: "summary" });
    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(true);
    expect(details.peerId).toBe("12D3KooWLOCAL");
    expect(details.nodeTier).toBe("edge");
    expect(details.peersByTier).toEqual({ edge: 3, management: 3 });
    // Fresh census wins over the cached snapshot's stale 0.5
    expect(details.networkHealthScore).toBeCloseTo(0.82);
    expect(details.anomalyAlertCount).toBe(2);
    expect(spies.getNetworkCensus).toHaveBeenCalled();
    expect(spies.getAnomalyAlerts).toHaveBeenCalled();
  });

  it("peers returns sorted-by-recency rows with tier + addrs", async () => {
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-2", { action: "peers" });
    const details = result.details as { peers: Array<{ peerId: string; tier: string }> };
    expect(details.peers).toHaveLength(2);
    // Most recently connected first (connected_at 200 > 100)
    expect(details.peers[0].peerId).toBe("12D3KooWBBB2");
    expect(details.peers[0].tier).toBe("management");
    expect(details.peers[1].tier).toBe("edge");
  });

  it("peers respects limit and reports truncated", async () => {
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-3", { action: "peers", limit: 1 });
    const details = result.details as { peers: unknown[]; truncated: boolean };
    expect(details.peers).toHaveLength(1);
    expect(details.truncated).toBe(true);
  });

  it("anomalies returns the full alert array", async () => {
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-4", { action: "anomalies" });
    const details = result.details as { count: number; alerts: unknown[] };
    expect(details.count).toBe(2);
    expect(details.alerts).toHaveLength(2);
  });

  it("census returns hasCensus=false on edge nodes (null census)", async () => {
    spies.getNetworkCensus.mockResolvedValueOnce(null);
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-5", { action: "census" });
    const details = result.details as { ok: boolean; hasCensus: boolean; reason?: string };
    expect(details.ok).toBe(true);
    expect(details.hasCensus).toBe(false);
    expect(details.reason).toMatch(/edge-tier|no management census/i);
  });

  it("stats and identity round-trip through the bridge", async () => {
    const tool = createNetworkStatusTool();
    const stats = (await tool.execute("call-6", { action: "stats" })).details as Record<
      string,
      unknown
    >;
    expect(stats.uptime_secs).toBe(1234);

    const identity = (await tool.execute("call-7", { action: "identity" })).details as Record<
      string,
      unknown
    >;
    expect(identity.peerId).toBe("12D3KooWLOCAL");
    expect(identity.nodeTier).toBe("edge");
  });

  it("returns a clear error when no bridge is registered", async () => {
    setActiveOrchestratorBridge(null);
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-8", { action: "summary" });
    expect(result.details).toMatchObject({
      ok: false,
      error: expect.stringContaining("orchestrator daemon not connected"),
    });
  });

  it("rejects an unknown action gracefully", async () => {
    const tool = createNetworkStatusTool();
    const result = await tool.execute("call-9", { action: "wibble" });
    expect((result.details as { ok: boolean }).ok).toBe(false);
  });
});
