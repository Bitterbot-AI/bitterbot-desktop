import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ p2p: { enabled: true, topics: {}, security: {} } }),
  writeConfigFile: async () => {},
}));

const { skillsHandlers } = await import("./skills.js");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeContext(metrics: () => unknown, history: () => unknown[]) {
  return {
    skillNetworkBridge: {
      getNetworkMetrics: vi.fn(metrics),
      getAggregatedNetworkCensus: vi.fn(() => null),
      getNetworkCensusHistory: vi.fn(history),
    },
  };
}

async function call(method: string, context: unknown, params: Record<string, unknown> = {}) {
  let payload: unknown;
  await skillsHandlers[method]({
    params,
    context,
    respond: (_ok: boolean, p: unknown) => {
      payload = p;
    },
  } as never);
  return payload;
}

describe("skills.network caching", () => {
  it("serves repeated polls from cache within the TTL, recomputes after", async () => {
    const ctx = makeContext(
      () => ({ lifetime: 7 }),
      () => [],
    );
    const m = ctx.skillNetworkBridge.getNetworkMetrics;

    await call("skills.network", ctx);
    await call("skills.network", ctx);
    expect(m).toHaveBeenCalledTimes(1); // second poll hit the cache

    vi.advanceTimersByTime(5_000); // TTL elapses
    await call("skills.network", ctx);
    expect(m).toHaveBeenCalledTimes(2);
  });
});

describe("skills.networkHistory caching", () => {
  it("caches per-param and recomputes after the TTL", async () => {
    const ctx = makeContext(
      () => null,
      () => [{ snapshot: 1 }],
    );
    const h = ctx.skillNetworkBridge.getNetworkCensusHistory;

    await call("skills.networkHistory", ctx, { limit: 10 });
    await call("skills.networkHistory", ctx, { limit: 10 });
    expect(h).toHaveBeenCalledTimes(1); // same params -> cached

    await call("skills.networkHistory", ctx, { limit: 20 });
    expect(h).toHaveBeenCalledTimes(2); // different params -> distinct entry

    vi.advanceTimersByTime(10_000);
    await call("skills.networkHistory", ctx, { limit: 10 });
    expect(h).toHaveBeenCalledTimes(3);
  });
});
