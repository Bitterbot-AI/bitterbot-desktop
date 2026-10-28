/**
 * PLAN-59 Phase 0: `curiosity.status` carries the evidence telemetry counts and
 * `curiosity.dismiss` reaches the manager, which labels the surfacing row.
 * Thin pass-through handlers; the manager singleton is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager } from "../../memory/index.js";
import { curiosityHandlers } from "./curiosity.js";

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../../agents/agent-scope.js", () => ({ resolveDefaultAgentId: () => "default" }));

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

beforeEach(() => {
  vi.mocked(getMemorySearchManager).mockReset();
});

describe("curiosity handlers (PLAN-59 Phase 0 evidence)", () => {
  it("curiosity.status passes the manager's payload through, evidence included", async () => {
    const evidence = {
      mode: "observe",
      available: true,
      retrievalHits: 12,
      surfacingEvents: 3,
      decisionTraces: 0,
      oldestAt: 1700000000000,
    };
    const curiosityStatus = vi.fn(async () => ({ paused: false, disabledBy: null, evidence }));
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: { curiosityStatus } as never,
      error: undefined,
    } as never);
    const { calls, respond } = capture();
    await curiosityHandlers["curiosity.status"]!({
      params: {},
      respond,
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(true);
    expect((calls[0]!.payload as { evidence: unknown }).evidence).toEqual(evidence);
  });

  it("curiosity.dismiss forwards the id and returns the manager's verdict", async () => {
    const curiosityDismiss = vi.fn(async (id: string) => id === "t-1");
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: { curiosityDismiss } as never,
      error: undefined,
    } as never);
    const { calls, respond } = capture();
    await curiosityHandlers["curiosity.dismiss"]!({
      params: { id: " t-1 " },
      respond,
    } as never);
    expect(curiosityDismiss).toHaveBeenCalledWith("t-1");
    expect(calls[0]).toMatchObject({ ok: true, payload: { dismissed: true } });
  });

  it("curiosity.status maps a missing manager to an error", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: null,
      error: "memory is off",
    } as never);
    const { calls, respond } = capture();
    await curiosityHandlers["curiosity.status"]!({ params: {}, respond } as never);
    expect(calls[0]!.ok).toBe(false);
  });
});
