import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../lib/gateway-client";

const gw = vi.hoisted(() => ({
  status: "connected" as "connected" | "connecting",
  request: vi.fn(),
  eventListeners: new Set<(evt: GatewayEventFrame) => void>(),
  storeListeners: new Set<(next: { status: string }, prev: { status: string }) => void>(),
}));

vi.mock("./gateway-store", () => ({
  useGatewayStore: Object.assign(() => undefined, {
    getState: () => ({
      status: gw.status,
      request: gw.request,
      subscribe: (listener: (evt: GatewayEventFrame) => void) => {
        gw.eventListeners.add(listener);
        return () => gw.eventListeners.delete(listener);
      },
    }),
    subscribe: (listener: (next: { status: string }, prev: { status: string }) => void) => {
      gw.storeListeners.add(listener);
      return () => gw.storeListeners.delete(listener);
    },
  }),
}));

const action = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "rv-00000001",
  status: "pending",
  cls: "spend",
  tool: "wallet",
  preview: "Send 5 USDC to 0xabc",
  params: {},
  sessionKey: "agent:main:main",
  agentId: "main",
  createdAt: 1000,
  expiresAt: 2000,
  decidedAt: null,
  decidedBy: null,
  decidedVia: null,
  note: null,
  resultSummary: null,
  executedAt: null,
  ...over,
});

const emit = (event: string, payload: unknown) => {
  for (const l of gw.eventListeners) l({ type: "event", event, payload });
};

async function load() {
  const mod = await import("./review-store");
  return mod.useReviewStore;
}

beforeEach(() => {
  vi.resetModules();
  gw.status = "connected";
  gw.request.mockReset();
  gw.request.mockImplementation(async (method: string, params: { status?: string }) => {
    if (method === "review.list") {
      return {
        actions:
          params.status === "pending"
            ? [action()]
            : [action(), action({ id: "rv-00000000", status: "denied" })],
      };
    }
    return null;
  });
  gw.eventListeners.clear();
  gw.storeListeners.clear();
});

describe("review store", () => {
  it("loads pending requests and history when it starts listening", async () => {
    const store = await load();

    store.getState().listen();
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true));

    expect(store.getState().pending.map((a) => a.id)).toEqual(["rv-00000001"]);
    expect(store.getState().history.map((a) => a.id)).toEqual(["rv-00000001", "rv-00000000"]);
  });

  it("adds a new request from the gateway event and removes it on resolution", async () => {
    const store = await load();
    store.getState().listen();
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true));

    emit(
      "review.requested",
      action({ id: "rv-00000002", createdAt: 3000, preview: 'Post to X: "hi"' }),
    );
    expect(store.getState().pending.map((a) => a.id)).toEqual(["rv-00000002", "rv-00000001"]);

    emit(
      "review.resolved",
      action({ id: "rv-00000002", createdAt: 3000, status: "executed", resultSummary: "posted" }),
    );
    expect(store.getState().pending.map((a) => a.id)).toEqual(["rv-00000001"]);
    expect(store.getState().history.find((a) => a.id === "rv-00000002")).toMatchObject({
      status: "executed",
    });
  });

  it("resolves through the gateway and applies the answer", async () => {
    const store = await load();
    store.getState().listen();
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true));
    gw.request.mockImplementation(async (method: string) =>
      method === "review.resolve"
        ? action({ status: "executed", resultSummary: "tx 0x1" })
        : { actions: [] },
    );

    const result = await store.getState().resolve("rv-00000001", "approve");

    expect(gw.request).toHaveBeenCalledWith("review.resolve", {
      id: "rv-00000001",
      decision: "approve",
    });
    expect(result).toMatchObject({ status: "executed" });
    expect(store.getState().pending).toEqual([]);
    expect(store.getState().busy.has("rv-00000001")).toBe(false);
  });

  it("notes an older gateway instead of failing silently", async () => {
    gw.request.mockRejectedValue(new Error("unknown method: review.list"));
    const store = await load();

    store.getState().listen();
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true));

    expect(store.getState().unsupported).toBe(true);
  });
});
