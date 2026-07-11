import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager } from "../../memory/index.js";
import { dreamHandlers } from "./dream.js";

// PLAN-28 B4: the memory.retrievalHealth handler is a thin pass-through over the
// manager's retrievalHealth(); mock the manager singleton so we test the wiring
// (payload shape, available flag, error mapping) without booting a real manager.
vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../../agents/agent-scope.js", () => ({ resolveDefaultAgentId: () => "default" }));

const handler = dreamHandlers["memory.retrievalHealth"]!;

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

beforeEach(() => {
  vi.mocked(getMemorySearchManager).mockReset();
});

describe("memory.retrievalHealth handler (PLAN-28 B4)", () => {
  it("returns the manager's retrieval health with available=true", async () => {
    const health = {
      layers: { total: 42, sinceContribution: { vector: 0, keyword: 0, graph: 7 } },
      deadWires: [],
      graph: { entityCount: 113, relationshipCount: 121 },
      // PLAN-34 Phase 6 §8: detail surfaces ride the same pass-through.
      canonical: {
        activeFacts: 1,
        lastInjection: { at: 1000, count: 1 },
        facts: [
          {
            key: "project.repo",
            value: "github.com/x/y",
            statement: "project.repo: github.com/x/y",
            category: "project",
            source: "agent_pin",
            confidence: 0.95,
            corroborationCount: 2,
            lastConfirmedAt: 999,
          },
        ],
      },
      cognition: {
        directiveFunnel: { created: 2 },
        insightPromotion: { promoted: 1, rejectedByLeg: {} },
        research: { outcomes: {}, egressToday: 0, egressCapPerDay: 10 },
        recentFindings: [
          {
            id: "f1",
            targetId: null,
            finding: "x",
            sourceUrl: null,
            relevance: null,
            createdAt: 1,
            surfacedAt: null,
          },
        ],
        egress: {
          totalsBySeam: { "search-query": 3 },
          recent: [
            {
              seam: "search-query",
              destination: "duckduckgo.com",
              payloadHash: "h",
              payloadLen: 12,
              createdAt: 1,
            },
          ],
        },
      },
    };
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: { retrievalHealth: () => health },
    } as never);

    const { calls, respond } = capture();
    await handler({ respond, params: {} } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(true);
    expect(calls[0]!.payload).toMatchObject({ available: true, ...health });
  });

  it("reports available=false when the manager lacks the method", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({ manager: {} } as never);
    const { calls, respond } = capture();
    await handler({ respond, params: {} } as never);
    expect(calls[0]!.ok).toBe(true);
    expect(calls[0]!.payload).toEqual({ available: false });
  });

  it("maps a missing manager to an error response", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: null,
      error: "memory manager unavailable",
    } as never);
    const { calls, respond } = capture();
    await handler({ respond, params: {} } as never);
    expect(calls[0]!.ok).toBe(false);
    expect(calls[0]!.error).toBeDefined();
  });
});
