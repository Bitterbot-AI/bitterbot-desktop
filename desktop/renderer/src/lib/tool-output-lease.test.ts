import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gw = vi.hoisted(() => ({
  status: "connected" as "connected" | "connecting" | "disconnected",
  request: vi.fn(),
  storeListeners: new Set<(next: { status: string }, prev: { status: string }) => void>(),
}));

vi.mock("../stores/gateway-store", () => ({
  useGatewayStore: Object.assign(() => undefined, {
    getState: () => ({ status: gw.status, request: gw.request }),
    subscribe: (listener: (next: { status: string }, prev: { status: string }) => void) => {
      gw.storeListeners.add(listener);
      return () => gw.storeListeners.delete(listener);
    },
  }),
}));

const calls = (method: string) => gw.request.mock.calls.filter(([m]) => m === method).length;

const setConnection = (status: typeof gw.status) => {
  const prev = { status: gw.status };
  gw.status = status;
  for (const listener of gw.storeListeners) listener({ status }, prev);
};

async function load() {
  return await import("./tool-output-lease");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  gw.status = "connected";
  gw.request.mockReset();
  gw.request.mockResolvedValue({ ok: true });
  gw.storeListeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tool output lease", () => {
  it("subscribes once for any number of holders, and renews", async () => {
    const { acquireToolOutput, TOOL_OUTPUT_RENEW_MS } = await load();

    acquireToolOutput();
    acquireToolOutput();
    expect(calls("tools.output.subscribe")).toBe(1);

    await vi.advanceTimersByTimeAsync(TOOL_OUTPUT_RENEW_MS * 2);
    expect(calls("tools.output.subscribe")).toBe(3);
  });

  it("unsubscribes when the last holder leaves, and stops renewing", async () => {
    const { acquireToolOutput, TOOL_OUTPUT_RENEW_MS } = await load();
    const a = acquireToolOutput();
    const b = acquireToolOutput();

    a();
    expect(calls("tools.output.unsubscribe")).toBe(0);
    b();
    b(); // a second release of the same holder is ignored
    expect(calls("tools.output.unsubscribe")).toBe(1);

    const before = calls("tools.output.subscribe");
    await vi.advanceTimersByTimeAsync(TOOL_OUTPUT_RENEW_MS * 3);
    expect(calls("tools.output.subscribe")).toBe(before);
    expect(gw.storeListeners.size).toBe(0);
  });

  it("re-subscribes after a reconnect and stays quiet while disconnected", async () => {
    const { acquireToolOutput, TOOL_OUTPUT_RENEW_MS } = await load();
    acquireToolOutput();
    expect(calls("tools.output.subscribe")).toBe(1);

    setConnection("connecting");
    await vi.advanceTimersByTimeAsync(TOOL_OUTPUT_RENEW_MS * 2);
    expect(calls("tools.output.subscribe")).toBe(1);

    setConnection("connected");
    expect(calls("tools.output.subscribe")).toBe(2);
  });

  it("survives a gateway that does not have the method", async () => {
    gw.request.mockRejectedValue(new Error("unknown method: tools.output.subscribe"));
    const { acquireToolOutput } = await load();

    const release = acquireToolOutput();
    await vi.advanceTimersByTimeAsync(0);

    expect(() => release()).not.toThrow();
  });
});
