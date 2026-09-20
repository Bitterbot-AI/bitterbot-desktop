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

  it("offline state — stable capability sentence, no error text (network_status has it)", () => {
    patchP2pStatus({ enabled: true, connected: false, lastError: "ENOENT" });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("P2P offline");
    expect(text).not.toContain("ENOENT");
    expect(text).toMatch(/use `network_status`/i);
  });

  it("connected state includes a nudge to reach for network_status when fresh data is needed", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 4,
      peersByTier: { edge: 4 },
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toMatch(/use `network_status`/);
  });

  it("connected state carries the Forage DNA — economy exists, forage tool, forge mishearing, no posting", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 4,
      peersByTier: { edge: 4 },
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("Forage bounty economy");
    expect(text).toMatch(/call the `forage` tool/);
    // Progressive disclosure (W6): the long form lives in the bundled skill.
    expect(text).toContain("skill `forage-economy`");
    expect(text).toContain("'forge'");
    expect(text).toContain("Night Shift");
    expect(text).toContain("You cannot post bounties yourself");
    // Never answer bounty questions from stale sources.
    expect(text).toMatch(/Never answer from memory or web search/);
  });

  it("disabled/offline states do NOT advertise the forage tool", () => {
    // disabled (default snapshot)
    expect(buildEconomicIdentitySection().join("\n")).not.toContain("Forage");
    patchP2pStatus({ enabled: true, connected: false, lastError: "ENOENT" });
    expect(buildEconomicIdentitySection().join("\n")).not.toContain("Forage");
  });

  it("connected state — identity bits render, live counters never do (cache prefix stability)", () => {
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
      anomalyAlertCount: 2,
    });
    const text = buildEconomicIdentitySection().join("\n");

    // Identity line: truncated peer id + tier (stable per process)
    expect(text).toContain(
      "You are connected to the P2P skills marketplace (you are 12D3KooWQM…HJVM, edge tier)",
    );

    // Token-efficiency W4: no peer count, health %, pulse or anomaly count in
    // the prompt; the agent is pointed at network_status instead.
    expect(text).not.toContain("Currently connected");
    expect(text).not.toContain("Network health");
    expect(text).not.toContain("skills published network-wide");
    expect(text).not.toContain("Recent network pulse");
    expect(text).not.toContain("Active anomaly alerts");
    expect(text).not.toMatch(/\b(6|82|14|38|7|2)\b/);
    expect(text).toMatch(/use `network_status`/);
  });

  it("connected state is byte-identical across peer-count / health / pulse changes", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 1,
      peerId: "12D3KooWQMptNZvAvA39NUAJur8NZN82AQBZ6bVoZ5y5H7WrHJVM",
      nodeTier: "edge",
      peersByTier: { edge: 1 },
      networkHealthScore: 0.1,
      telemetryCountsByType: { a: 1 },
      anomalyAlertCount: 0,
    });
    const a = buildEconomicIdentitySection().join("\n");
    patchP2pStatus({
      peerCount: 40,
      peersByTier: { edge: 30, management: 10 },
      networkHealthScore: 0.95,
      telemetryCountsByType: { a: 500, b: 12 },
      anomalyAlertCount: 3,
    });
    const b = buildEconomicIdentitySection().join("\n");
    expect(a).toBe(b);
  });

  it("partial state — missing identity bits are omitted gracefully", () => {
    patchP2pStatus({
      enabled: true,
      connected: true,
      peerCount: 1,
      peersByTier: {},
      networkHealthScore: null,
    });
    const text = buildEconomicIdentitySection().join("\n");
    expect(text).toContain("You are connected to the P2P skills marketplace and earn USDC");
    expect(text).not.toContain("Network health");
    expect(text).not.toContain("Recent network pulse");
  });
});
