import { describe, expect, it, vi } from "vitest";

// Keep probes inert: the consent logic is what's under test, and quickstart
// must not TCP-probe at all (PLAN-41 Phase 1 gates it to advanced).
const probeTcpReachable = vi.hoisted(() => vi.fn(async () => ({ reachable: true, rttMs: 1 })));
const probeOrchestratorBinary = vi.hoisted(() =>
  vi.fn(() => ({ found: true, source: "prebuilt", path: "/tmp/orchestrator" })),
);
vi.mock("../infra/orchestrator-binary.js", () => ({
  probeTcpReachable,
  probeOrchestratorBinary,
  parseMultiaddr: () => null,
}));
vi.mock("../infra/dns-bootstrap.js", () => ({
  resolveBootstrapDns: vi.fn(async () => []),
}));

import { setupP2pForOnboarding } from "./onboarding.p2p.js";

function makePrompter(joinAnswer: boolean) {
  return {
    confirm: vi.fn(async () => joinAnswer),
    note: vi.fn(async () => {}),
  } as never;
}

const baseParams = (flow: "quickstart" | "advanced", join: boolean, config = {}) => ({
  config,
  flow,
  prompter: makePrompter(join),
  runtime: {} as never,
});

describe("setupP2pForOnboarding — network consent (PLAN-41 Phase 1, p0-10)", () => {
  it("quickstart ASKS for consent (no longer advanced-only)", async () => {
    const params = baseParams("quickstart", true);
    await setupP2pForOnboarding(params as never);
    expect((params.prompter as { confirm: ReturnType<typeof vi.fn> }).confirm).toHaveBeenCalled();
  });

  it("declining applies the Local-only preset: five surfaces explicitly off", async () => {
    const params = baseParams("quickstart", false, {
      p2p: { bootstrapDns: "x.example" },
      models: { mode: "merge" as const },
    });
    const out = await setupP2pForOnboarding(params as never);
    expect(out.p2p?.enabled).toBe(false);
    expect(out.circles?.enabled).toBe(false);
    expect(out.a2a?.enabled).toBe(false);
    expect(out.update?.checkOnStart).toBe(false);
    expect(out.models?.liveDiscovery?.enabled).toBe(false);
    // Existing keys survive the preset spread.
    expect(out.p2p?.bootstrapDns).toBe("x.example");
    expect(out.models?.mode).toBe("merge");
  });

  it("declining skips every probe (nothing dials on an opt-out)", async () => {
    probeTcpReachable.mockClear();
    probeOrchestratorBinary.mockClear();
    await setupP2pForOnboarding(baseParams("advanced", false) as never);
    expect(probeOrchestratorBinary).not.toHaveBeenCalled();
    expect(probeTcpReachable).not.toHaveBeenCalled();
  });

  it("accepting leaves the config untouched", async () => {
    const config = { p2p: { enabled: true } };
    const out = await setupP2pForOnboarding(baseParams("quickstart", true, config) as never);
    expect(out).toBe(config);
  });

  it("quickstart never TCP-probes even on accept (advanced-only probe)", async () => {
    probeTcpReachable.mockClear();
    await setupP2pForOnboarding(
      baseParams("quickstart", true, {
        p2p: { bootstrapPeers: ["/ip4/1.2.3.4/tcp/4001/p2p/x"] },
      }) as never,
    );
    expect(probeTcpReachable).not.toHaveBeenCalled();
  });
});
