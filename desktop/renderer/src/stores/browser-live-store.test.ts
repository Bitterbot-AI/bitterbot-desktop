import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../lib/gateway-client";

/**
 * The live view is a lease. These tests pin the lifecycle that keeps the
 * gateway from encoding frames nobody is looking at, and from showing a stale
 * page as if it were live.
 */

const gw = vi.hoisted(() => ({
  status: "connected" as "connected" | "connecting" | "disconnected",
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

const emit = (event: string, payload: unknown) => {
  for (const listener of gw.eventListeners) listener({ type: "event", event, payload });
};

const setConnection = (status: typeof gw.status) => {
  const prev = { status: gw.status };
  gw.status = status;
  for (const listener of gw.storeListeners) listener({ status }, prev);
};

const calls = (method: string) => gw.request.mock.calls.filter(([m]) => m === method).length;

async function load() {
  const mod = await import("./browser-live-store");
  return {
    store: mod.useBrowserLiveStore,
    renewMs: mod.BROWSER_LIVE_RENEW_MS,
    lingerMs: mod.BROWSER_LIVE_LINGER_MS,
    hasControl: mod.hasBrowserControl,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  gw.status = "connected";
  gw.request.mockReset();
  gw.request.mockResolvedValue({ state: "idle", profile: "bitterbot" });
  gw.eventListeners.clear();
  gw.storeListeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("browser live store", () => {
  it("takes one lease no matter how many components are watching", async () => {
    const { store } = await load();

    store.getState().acquire();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls("browser.live.start")).toBe(1);
    expect(store.getState()).toMatchObject({ state: "idle", profile: "bitterbot", watchers: 2 });
  });

  it("turns a frame event into an image and marks the view live", async () => {
    const { store } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    emit("browser.frame", { data: "QUJD", seq: 7, deviceWidth: 1280, deviceHeight: 800 });

    expect(store.getState().state).toBe("streaming");
    expect(store.getState().frame).toEqual({
      src: "data:image/jpeg;base64,QUJD",
      seq: 7,
      deviceWidth: 1280,
      deviceHeight: 800,
    });
  });

  it("renews the lease while someone is watching", async () => {
    const { store, renewMs } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(renewMs * 3);

    expect(calls("browser.live.start")).toBe(4);
  });

  it("gives the lease back when the last watcher leaves", async () => {
    const { store, renewMs, lingerMs } = await load();
    const releaseA = store.getState().acquire();
    const releaseB = store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    emit("browser.frame", { data: "QUJD", seq: 1 });

    releaseA();
    expect(calls("browser.live.stop")).toBe(0);
    expect(store.getState().frame).not.toBeNull();

    releaseB();
    await vi.advanceTimersByTimeAsync(lingerMs);
    expect(calls("browser.live.stop")).toBe(1);
    expect(store.getState()).toMatchObject({ state: "off", frame: null, watchers: 0 });

    const startsBefore = calls("browser.live.start");
    await vi.advanceTimersByTimeAsync(renewMs * 3);
    expect(calls("browser.live.start"), "no renewals after leaving").toBe(startsBefore);
    expect(gw.eventListeners.size).toBe(0);
    expect(gw.storeListeners.size).toBe(0);
  });

  it("keeps one lease across a run of back-to-back browser calls", async () => {
    // Each browser tool call watches only while it runs. Without the linger
    // the gateway would tear the screencast down and set it up between calls.
    const { store, lingerMs } = await load();

    const releaseFirst = store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(lingerMs / 2);
    const releaseSecond = store.getState().acquire();
    await vi.advanceTimersByTimeAsync(lingerMs * 2);

    expect(calls("browser.live.stop"), "the lease was never given up").toBe(0);
    expect(calls("browser.live.start"), "and never taken a second time").toBe(1);

    // The page kept updating through the gap between the two calls.
    emit("browser.frame", { data: "QUJD", seq: 9 });
    expect(store.getState().frame?.seq).toBe(9);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(lingerMs);
    expect(calls("browser.live.stop")).toBe(1);
  });

  it("ignores a second release of the same watcher", async () => {
    const { store } = await load();
    const releaseA = store.getState().acquire();
    store.getState().acquire();

    releaseA();
    releaseA();

    expect(store.getState().watchers).toBe(1);
    expect(calls("browser.live.stop")).toBe(0);
  });

  it("drops the last frame when the browser goes away", async () => {
    // A picture of a closed page presented as "the browser" would be a lie.
    const { store } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    emit("browser.frame", { data: "QUJD", seq: 1 });

    emit("browser.live", { state: "idle", profile: "bitterbot" });

    expect(store.getState()).toMatchObject({ state: "idle", frame: null });
  });

  it("follows status events for the address bar", async () => {
    const { store } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    emit("browser.live", {
      state: "streaming",
      targetId: "tab-2",
      url: "https://example.com/checkout",
      title: "Checkout",
    });

    expect(store.getState()).toMatchObject({
      state: "streaming",
      url: "https://example.com/checkout",
      title: "Checkout",
    });
  });

  it("explains an older gateway instead of failing silently", async () => {
    gw.request.mockRejectedValue(new Error("unknown method: browser.live.start"));
    const { store } = await load();

    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().state).toBe("unavailable");
    expect(store.getState().reason).toContain("Update the gateway");
  });

  it("does not renew into a dead connection, and re-leases on reconnect", async () => {
    const { store, renewMs } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("browser.live.start")).toBe(1);

    setConnection("connecting");
    await vi.advanceTimersByTimeAsync(renewMs * 2);
    expect(calls("browser.live.start"), "no requests while disconnected").toBe(1);

    // A reconnect is a new connection on the gateway: the old lease is gone.
    setConnection("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("browser.live.start")).toBe(2);
  });

  it("ignores frames once nobody is watching", async () => {
    const { store, lingerMs } = await load();
    const release = store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    const listener = [...gw.eventListeners][0];

    release();
    await vi.advanceTimersByTimeAsync(lingerMs);
    listener({ type: "event", event: "browser.frame", payload: { data: "QUJD", seq: 2 } });

    expect(store.getState()).toMatchObject({ state: "off", frame: null });
  });
});

describe("browser live store: taking control", () => {
  const click = {
    kind: "mouse",
    type: "down",
    x: 10,
    y: 10,
    button: "left",
    buttons: 1,
    modifiers: 0,
  } as const;

  const streamingAs = (viewer: string) => ({
    state: "streaming",
    targetId: "tab-1",
    control: "agent",
    viewer,
  });

  it("knows its own connection from the lease, and so who has control", async () => {
    gw.request.mockResolvedValue(streamingAs("conn-me"));
    const { store, hasControl } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasControl(store.getState())).toBe(false);

    emit("browser.live", { state: "streaming", control: "user", controller: "conn-me" });
    expect(hasControl(store.getState())).toBe(true);

    // Same event, different holder: this window is a spectator.
    emit("browser.live", { state: "streaming", control: "user", controller: "conn-other" });
    expect(hasControl(store.getState())).toBe(false);
  });

  it("asks the gateway for control and applies the answer", async () => {
    gw.request.mockResolvedValue(streamingAs("conn-me"));
    const { store, hasControl } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    gw.request.mockResolvedValue({ state: "streaming", control: "user", controller: "conn-me" });
    await store.getState().takeControl();

    expect(gw.request).toHaveBeenCalledWith("browser.live.control", { mode: "user" });
    expect(hasControl(store.getState())).toBe(true);

    gw.request.mockResolvedValue({ state: "streaming", control: "agent" });
    await store.getState().handBack();

    expect(gw.request).toHaveBeenCalledWith("browser.live.control", { mode: "agent" });
    expect(hasControl(store.getState())).toBe(false);
  });

  it("sends input only while this window has control", async () => {
    gw.request.mockResolvedValue(streamingAs("conn-me"));
    const { store } = await load();
    store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);

    store.getState().sendInput(click);
    expect(calls("browser.live.input")).toBe(0);

    emit("browser.live", { state: "streaming", control: "user", controller: "conn-me" });
    store.getState().sendInput(click);
    expect(gw.request).toHaveBeenLastCalledWith("browser.live.input", { event: click });

    emit("browser.live", { state: "streaming", control: "agent" });
    store.getState().sendInput(click);
    expect(calls("browser.live.input")).toBe(1);
  });

  it("forgets control when the view is closed", async () => {
    gw.request.mockResolvedValue(streamingAs("conn-me"));
    const { store, hasControl, lingerMs } = await load();
    const release = store.getState().acquire();
    await vi.advanceTimersByTimeAsync(0);
    emit("browser.live", { state: "streaming", control: "user", controller: "conn-me" });

    release();
    await vi.advanceTimersByTimeAsync(lingerMs);

    expect(hasControl(store.getState())).toBe(false);
    expect(store.getState().viewer).toBeUndefined();
  });
});
