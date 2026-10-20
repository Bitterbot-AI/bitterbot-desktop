import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvolutionPanel, formatAgo, ladderTone } from "./EvolutionPanel";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ status: "connected", request: requestMock, subscribe: () => () => {} }),
}));

const NOW = Date.now();

const status = {
  config: {
    enabled: true,
    cadenceHours: 24,
    validationMode: "tasks",
    validationModeEffective: "records",
    validationModeSource: "no-capability-tasks",
    capabilityTasks: 0,
    pendingDrafts: 3,
    maxActiveEvolved: 5,
  },
  recentIterations: [{ at: NOW - 3 * 3_600_000, ran: false, reason: "cadence" }],
  pendingPeer: [{ name: "peer-skill", gateAttempts: 1, lastVerdict: null }],
  evolvedLive: [{ name: "curl-timeout-guard" }],
  failureSignatures: [{ key: "curl:timeout", count: 9, iterations: 4 }],
  evidence: [
    {
      name: "curl-timeout-guard",
      origin: "wiki-evolution",
      ladder: "canary",
      ladderAt: NOW - 86_400_000,
      canary: { startedAt: NOW - 86_400_000, endedAt: null, reason: "gate" },
      modelDrift: null,
      reads: {
        total: 4,
        runs: 4,
        pass: 3,
        fail: 1,
        successRate: 0.75,
        lastReadAt: NOW - 3_600_000,
      },
      gate: {
        verdict: "accepted",
        mode: "tasks",
        pValue: 0.031,
        wins: 6,
        losses: 1,
        trials: 21,
        validatedAt: NOW - 2 * 86_400_000,
      },
      models: { validatedOn: ["anthropic/claude-opus-4-8"], readBy: ["anthropic/claude-opus-4-8"] },
      publishedAt: null,
    },
    {
      name: "local-notes",
      origin: "local",
      ladder: "unmanaged",
      ladderAt: null,
      canary: null,
      modelDrift: null,
      reads: { total: 0, runs: 0, pass: 0, fail: 0, successRate: null, lastReadAt: null },
      gate: null,
      models: { validatedOn: [], readBy: [] },
      publishedAt: null,
    },
  ],
};

describe("EvolutionPanel (PLAN-45 Phase 6)", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation((method: string) =>
      method === "skills.evolution.status" ? Promise.resolve(status) : Promise.resolve({}),
    );
  });

  it("shows the loop state from skills.evolution.status and only managed evidence records", async () => {
    render(<EvolutionPanel />);
    await waitFor(() => expect(screen.getByTestId("evolution-panel")).toBeTruthy());
    expect(requestMock).toHaveBeenCalledWith("skills.evolution.status", {});
    // Effective mode differs from the configured one: say so.
    expect(screen.getByText(/records mode, 0 capability tasks \(configured tasks\)/)).toBeTruthy();
    expect(screen.getByText(/skipped: cadence/)).toBeTruthy();
    expect(
      screen.getByText(/1 managed of 5 max, 1 peer pending gate, 3 corpus drafts to review/),
    ).toBeTruthy();
    expect(screen.getByText(/curl:timeout \(9 in 4 iterations\)/)).toBeTruthy();
    expect(screen.getByTestId("evidence-curl-timeout-guard")).toBeTruthy();
    expect(screen.queryByTestId("evidence-local-notes")).toBeNull();
    expect(screen.getByText(/accepted \(tasks, p=0.031, 6W\/1L over 21 trials\)/)).toBeTruthy();
    expect(screen.getByText(/running, started 24h ago \(gate\)/)).toBeTruthy();
    expect(screen.getByText(/4 in 4 runs, 75% success/)).toBeTruthy();
  });

  it("explains an empty node and surfaces an RPC failure", async () => {
    requestMock.mockImplementation(() => Promise.resolve({ ...status, evidence: [] }));
    render(<EvolutionPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No evolved or received skill is live yet/)).toBeTruthy(),
    );
    requestMock.mockImplementation(() => Promise.reject(new Error("boom")));
    render(<EvolutionPanel />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
  });

  it("helpers: ladder tones and relative time", () => {
    expect(ladderTone("stable")).toContain("success");
    expect(ladderTone("canary")).toContain("warning");
    expect(ladderTone("rolled-back")).toContain("destructive");
    expect(formatAgo(null)).toBe("never");
    expect(formatAgo(NOW - 30 * 60_000, NOW)).toBe("30m ago");
    expect(formatAgo(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(formatAgo(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });
});
