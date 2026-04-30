import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchP2pStatus, resetP2pStatus } from "../infra/p2p-status.js";
import { buildEconomicIdentitySection } from "./system-prompt.js";

/**
 * Layer 1 of agent self-awareness (PLAN-14 follow-up): the system prompt
 * Economic Identity section. These tests verify that whatever the live
 * P2pStatusSnapshot exposes — peer ID, tier, peer-tier mix, network
 * health, telemetry pulse, anomaly count — actually shows up in the
 * prompt the agent reads on every turn.
 *
 * The function is otherwise tested via the broader system-prompt
 * integration tests; here we focus on the live-state rendering.
 */
describe("buildEconomicIdentitySection — live network awareness", () => {
  beforeEach(() => {
    resetP2pStatus();
  });
  afterEach(() => {
    resetP2pStatus();
  });

  it("disabled state — no live block, just the disabled notice", () => {
    // initial snapshot has enabled=false
    const lines = buildEconomicIdentitySection();
    expect(lines.join("\n")).toContain("P2P disabled");
    expect(lines.join("\n")).not.toContain("Currently connected");
  });

  it("offline state — surfaces the bridge error", () => {
    patchP2pStatus({ enabled: true, connected: false, lastError: "ENOENT" });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("P2P offline");
    expect(text).toContain("ENOENT");
  });

  it("connected with full census — peer id, tier, tier mix, health, pulse render", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 6,
      peerId: "12D3KooWQMptNZvAvA39NUAJur8NZN82AQBZ6bVoZ5y5H7WrHJVM",
      nodeTier: "edge",
      peersByTier: { edge: 3, management: 3 },
      networkHealthScore: 0.82,
      skillsPublishedNetworkWide: 14,
      telemetryCountsByType: { novelty: 38, experience: 7 },
      anomalyAlertCount: 0,
    });
    const text = buildEconomicIdentitySection().join("\n");

    // Identity line: truncated peer id + tier
    expect(text).toMatch(/you are 12D3KooWQM…HJVM, edge tier/);

    // Peer count + tier mix (management before edge by spec)
    expect(text).toContain("Currently connected to 6 peers (3 management, 3 edge)");

    // Health + skills count
    expect(text).toContain("Network health: 82%");
    expect(text).toContain("14 skills published network-wide");

    // Telemetry pulse, ordered by count desc
    expect(text).toContain("Recent network pulse: 38 novelty, 7 experience");

    // No anomaly line when count is zero
    expect(text).not.toContain("Active anomaly alerts");
  });

  it("anomaly alerts surface only when non-zero", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 4,
      peersByTier: { edge: 4 },
      anomalyAlertCount: 2,
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("Active anomaly alerts: 2");
  });

  it("partial state — missing fields are omitted gracefully", () => {
    // peerId / tier / health unset (e.g. before first census poll)
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 1,
      peersByTier: {},
      networkHealthScore: null,
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("Currently connected to 1 peer");
    expect(text).not.toContain("Network health");
    expect(text).not.toContain("Recent network pulse");
  });

  it("tier mix omits zero buckets and sorts management-first", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 5,
      peersByTier: { edge: 4, management: 1, unknown: 0 },
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("(1 management, 4 edge)");
    expect(text).not.toContain("unknown");
  });

  it("telemetry pulse caps at top-3 signal types by count", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 2,
      peersByTier: { edge: 2 },
      telemetryCountsByType: { a: 1, b: 50, c: 12, d: 30, e: 7 },
    });
    const text = buildEconomicIdentitySection().join("\n");
    // Top 3 by count: b=50, d=30, c=12
    expect(text).toContain("Recent network pulse: 50 b, 30 d, 12 c");
    // Lowest-count signals (a=1, e=7) excluded from the pulse line.
    expect(text).not.toMatch(/pulse:.*7 e/);
    expect(text).not.toMatch(/pulse:.*1 a/);
  });
});
