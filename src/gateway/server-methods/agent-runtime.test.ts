import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeHandlers } from "./agent-runtime.js";

vi.mock("../../agents/pi-embedded-runner/compaction-circuit-breaker.js", () => ({
  getCompactionBreakerSnapshot: vi.fn(),
  listCompactionBreakers: vi.fn(),
}));

vi.mock("../../agents/prompt-cache-monitor.js", () => ({
  getCacheMetrics: vi.fn(),
  listCacheMetrics: vi.fn(),
}));

import {
  getCompactionBreakerSnapshot,
  listCompactionBreakers,
} from "../../agents/pi-embedded-runner/compaction-circuit-breaker.js";
import { getCacheMetrics, listCacheMetrics } from "../../agents/prompt-cache-monitor.js";

type RespondFn = (ok: boolean, payload?: unknown, error?: unknown, meta?: unknown) => void;

function callHandler(params: unknown): {
  ok: boolean;
  payload: unknown;
  error: unknown;
} {
  let captured: { ok: boolean; payload: unknown; error: unknown } = {
    ok: false,
    payload: undefined,
    error: undefined,
  };
  const respond: RespondFn = (ok, payload, error) => {
    captured = { ok, payload, error };
  };
  const handler = agentRuntimeHandlers["agent.runtime.health"]!;
  // Cast to the real signature is heavy; this handler only consumes
  // params + respond, so a minimal stub suffices for the unit test.
  // The handler is sync (no async work) but the type signature allows
  // a promise return, so swallow the void result explicitly.
  void handler({
    params: params as Record<string, unknown>,
    respond,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any);
  return captured;
}

afterEach(() => {
  vi.mocked(getCompactionBreakerSnapshot).mockReset();
  vi.mocked(listCompactionBreakers).mockReset();
  vi.mocked(getCacheMetrics).mockReset();
  vi.mocked(listCacheMetrics).mockReset();
});

describe("agent.runtime.health — list mode (no sessionKey)", () => {
  it("returns empty arrays when there's no traffic", () => {
    vi.mocked(listCacheMetrics).mockReturnValue([]);
    vi.mocked(listCompactionBreakers).mockReturnValue([]);

    const r = callHandler({});
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({
      cache: [],
      breakers: [],
      truncated: { cache: false, breakers: false },
    });
  });

  it("forwards lists from the in-memory monitors", () => {
    vi.mocked(listCacheMetrics).mockReturnValue([
      {
        sessionKey: "agent-a:main",
        turns: 5,
        busts: 0,
        hitRatio: 0.92,
        recentHitRatio: 0.95,
        cacheRead: 1800,
        cacheWrite: 200,
        input: 100,
        output: 50,
      },
    ]);
    vi.mocked(listCompactionBreakers).mockReturnValue([
      {
        sessionKey: "agent-a:main",
        state: "closed",
        consecutiveFailures: 0,
        lastReason: undefined,
        cooldownUntil: 0,
      },
    ]);

    const r = callHandler({});
    expect(r.ok).toBe(true);
    const p = r.payload as {
      cache: Array<{ sessionKey: string }>;
      breakers: Array<{ sessionKey: string; state: string }>;
      truncated: { cache: boolean; breakers: boolean };
    };
    expect(p.cache).toHaveLength(1);
    expect(p.cache[0]!.sessionKey).toBe("agent-a:main");
    expect(p.breakers).toHaveLength(1);
    expect(p.breakers[0]!.state).toBe("closed");
    expect(p.truncated).toEqual({ cache: false, breakers: false });
  });

  it("respects the limit parameter and reports truncation", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      sessionKey: `s${i}`,
      turns: i,
      busts: 0,
      hitRatio: 0,
      recentHitRatio: 0,
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    }));
    vi.mocked(listCacheMetrics).mockReturnValue(big);
    vi.mocked(listCompactionBreakers).mockReturnValue([]);

    const r = callHandler({ limit: 10 });
    expect(r.ok).toBe(true);
    const p = r.payload as {
      cache: Array<unknown>;
      truncated: { cache: boolean };
    };
    expect(p.cache).toHaveLength(10);
    expect(p.truncated.cache).toBe(true);
  });

  it("clamps limit to the [1, 200] range", () => {
    vi.mocked(listCacheMetrics).mockReturnValue([]);
    vi.mocked(listCompactionBreakers).mockReturnValue([]);

    // Above max
    const r1 = callHandler({ limit: 9999 });
    expect(r1.ok).toBe(true);

    // Below min — also accepted (clamped to 1)
    const r2 = callHandler({ limit: 0 });
    expect(r2.ok).toBe(true);

    // Non-numeric — falls back to default
    const r3 = callHandler({ limit: "not a number" });
    expect(r3.ok).toBe(true);
  });
});

describe("agent.runtime.health — single-session mode", () => {
  it("returns per-session snapshot when sessionKey provided", () => {
    vi.mocked(getCacheMetrics).mockReturnValue({
      sessionKey: "agent-a:main",
      turns: 3,
      busts: 1,
      hitRatio: 0.5,
      recentHitRatio: 0.6,
      cacheRead: 100,
      cacheWrite: 50,
      input: 50,
      output: 25,
    });
    vi.mocked(getCompactionBreakerSnapshot).mockReturnValue({
      state: "open",
      consecutiveFailures: 3,
      lastReason: "summary_failed",
      cooldownUntil: 1_000_000,
      cooldownMs: 600_000,
      trials: 0,
    });

    const r = callHandler({ sessionKey: "agent-a:main" });
    expect(r.ok).toBe(true);
    const p = r.payload as { cache: { busts: number }; breaker: { state: string } };
    expect(p.cache.busts).toBe(1);
    expect(p.breaker.state).toBe("open");

    // List functions should NOT be called in single-session mode.
    expect(listCacheMetrics).not.toHaveBeenCalled();
    expect(listCompactionBreakers).not.toHaveBeenCalled();
  });

  it("returns null fields when the session has no recorded data", () => {
    vi.mocked(getCacheMetrics).mockReturnValue(null);
    vi.mocked(getCompactionBreakerSnapshot).mockReturnValue(null);

    const r = callHandler({ sessionKey: "never-touched" });
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ cache: null, breaker: null });
  });

  it("trims whitespace on the sessionKey input", () => {
    vi.mocked(getCacheMetrics).mockReturnValue(null);
    vi.mocked(getCompactionBreakerSnapshot).mockReturnValue(null);

    callHandler({ sessionKey: "  agent-a:main  " });
    expect(getCacheMetrics).toHaveBeenCalledWith("agent-a:main");
    expect(getCompactionBreakerSnapshot).toHaveBeenCalledWith("agent-a:main");
  });
});

describe("agent.runtime.health — error handling", () => {
  it("responds with UNAVAILABLE when an underlying call throws", () => {
    vi.mocked(listCacheMetrics).mockImplementation(() => {
      throw new Error("kaboom");
    });
    vi.mocked(listCompactionBreakers).mockReturnValue([]);

    const r = callHandler({});
    expect(r.ok).toBe(false);
    const err = r.error as { code: string; message: string };
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toContain("kaboom");
  });
});
