import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

/**
 * The live view must watch without side effects: opening the pane may not
 * launch a browser, and it has to land on the tab the agent is actually using.
 */

const browser = vi.hoisted(() => ({
  config: {} as { browser?: { liveView?: { enabled?: boolean; maxFps?: number } } },
  controlEnabled: true,
  reachable: true,
  tabs: [] as Array<{ targetId: string; url: string; title: string; type?: string }>,
  lastTargetId: null as string | null,
  nodeTarget: null as { nodeId: string } | null,
  launches: 0,
  screencasts: [] as Array<{ targetId: string; cdpUrl: string; stopped: boolean }>,
  inputs: [] as Array<{ method: string; params: Record<string, unknown> }>,
  pushFrame: null as ((data: string) => void) | null,
}));

vi.mock("../../config/config.js", () => ({ loadConfig: () => browser.config }));

vi.mock("./browser.js", () => ({ resolveBrowserNodeTarget: () => browser.nodeTarget }));

vi.mock("../../browser/control-service.js", () => {
  const state = () => ({
    profiles: new Map([["bitterbot", { lastTargetId: browser.lastTargetId }]]),
  });
  return {
    startBrowserControlServiceFromConfig: async () => (browser.controlEnabled ? state() : null),
    getBrowserControlState: () => state(),
    createBrowserControlContext: () => ({
      forProfile: () => ({
        profile: { name: "bitterbot", cdpUrl: "http://127.0.0.1:18800" },
        isHttpReachable: async () => browser.reachable,
        listTabs: async () => browser.tabs,
        // Anything that would start Chrome. Watching must never call these.
        ensureBrowserAvailable: async () => {
          browser.launches++;
        },
        ensureTabAvailable: async () => {
          browser.launches++;
        },
        openTab: async () => {
          browser.launches++;
        },
      }),
    }),
  };
});

vi.mock("../../browser/pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    startScreencastViaPlaywright: async (opts: {
      targetId: string;
      cdpUrl: string;
      onFrame: (f: { data: string; deviceWidth: number; deviceHeight: number }) => void;
    }) => {
      const cast = { targetId: opts.targetId, cdpUrl: opts.cdpUrl, stopped: false };
      browser.screencasts.push(cast);
      browser.pushFrame = (data) => opts.onFrame({ data, deviceWidth: 1280, deviceHeight: 800 });
      return {
        stop: async () => {
          cast.stopped = true;
        },
        describe: async () => ({ url: "https://example.com/live", title: "Live" }),
        input: async (command: { method: string; params: Record<string, unknown> }) => {
          browser.inputs.push(command);
        },
      };
    },
  }),
}));

type Sent = { event: string; payload: unknown; connIds: string[]; opts?: { dropIfSlow?: boolean } };

async function call(
  method:
    | "browser.live.start"
    | "browser.live.stop"
    | "browser.live.control"
    | "browser.live.input",
  connId: string | null,
  params: Record<string, unknown> = {},
) {
  const { browserLiveHandlers } = await import("./browser-live.js");
  const sent: Sent[] = [];
  const respond = vi.fn();
  await browserLiveHandlers[method]({
    params,
    respond,
    client: connId ? { connId, connect: {} } : null,
    context: {
      nodeRegistry: { listConnected: () => [] },
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => sent.push({ event, payload, connIds: [...connIds], opts }),
    },
  } as unknown as GatewayRequestHandlerOptions);
  const [ok, payload, error] = respond.mock.calls[0] as [boolean, unknown, unknown];
  return { ok, payload, error, sent };
}

beforeEach(() => {
  vi.resetModules();
  browser.config = {};
  browser.controlEnabled = true;
  browser.reachable = true;
  browser.tabs = [{ targetId: "tab-1", url: "https://example.com/1", title: "One", type: "page" }];
  browser.lastTargetId = null;
  browser.nodeTarget = null;
  browser.launches = 0;
  browser.screencasts = [];
  browser.inputs = [];
  browser.pushFrame = null;
});

describe("browser.live.start", () => {
  it("does not launch a browser just because the pane is open", async () => {
    browser.reachable = false;

    const res = await call("browser.live.start", "conn-1");

    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ state: "idle", profile: "bitterbot", viewer: "conn-1" });
    expect(browser.launches).toBe(0);
    expect(browser.screencasts).toHaveLength(0);
  });

  it("stays idle when the browser is up but has no page", async () => {
    browser.tabs = [
      { targetId: "sw-1", url: "chrome-extension://x/sw.js", title: "", type: "service_worker" },
    ];

    const res = await call("browser.live.start", "conn-1");

    expect(res.payload).toMatchObject({ state: "idle", profile: "bitterbot" });
    expect(browser.screencasts).toHaveLength(0);
  });

  it("streams the tab the agent is working in, not the first one listed", async () => {
    browser.tabs = [
      { targetId: "tab-1", url: "https://example.com/1", title: "One", type: "page" },
      { targetId: "tab-2", url: "https://example.com/2", title: "Two", type: "page" },
    ];
    browser.lastTargetId = "tab-2";

    const res = await call("browser.live.start", "conn-1");

    expect(res.payload).toMatchObject({ state: "streaming", targetId: "tab-2" });
    expect(browser.screencasts).toEqual([
      { targetId: "tab-2", cdpUrl: "http://127.0.0.1:18800", stopped: false },
    ]);
    expect(browser.launches).toBe(0);
  });

  it("sends frames only to the lease holder and lets a slow one drop them", async () => {
    const res = await call("browser.live.start", "conn-1");
    browser.pushFrame?.("AAAA");

    const frame = res.sent.find((s) => s.event === "browser.frame");
    expect(frame).toMatchObject({ connIds: ["conn-1"], opts: { dropIfSlow: true } });
    expect(frame?.payload).toMatchObject({ data: "AAAA", targetId: "tab-1" });
  });

  it("can be turned off in config", async () => {
    browser.config = { browser: { liveView: { enabled: false } } };

    const res = await call("browser.live.start", "conn-1");

    expect(res.payload).toMatchObject({ state: "unavailable" });
    expect(browser.screencasts).toHaveLength(0);
  });

  it("says so when browser control itself is disabled", async () => {
    browser.controlEnabled = false;

    const res = await call("browser.live.start", "conn-1");

    expect(res.payload).toMatchObject({
      state: "unavailable",
      reason: "browser control is disabled",
    });
  });

  it("does not pretend to stream a browser that lives on a paired node", async () => {
    browser.nodeTarget = { nodeId: "node-1" };

    const res = await call("browser.live.start", "conn-1");

    expect(res.payload).toMatchObject({ state: "unavailable" });
    expect(browser.screencasts).toHaveLength(0);
  });

  it("rejects a caller with no connection to send frames to", async () => {
    const res = await call("browser.live.start", null);

    expect(res.ok).toBe(false);
    expect(browser.screencasts).toHaveLength(0);
  });
});

describe("browser.live.stop", () => {
  it("releases the screencast when the only viewer leaves", async () => {
    await call("browser.live.start", "conn-1");
    expect(browser.screencasts[0].stopped).toBe(false);

    // Same module instance: stop must reach the manager start created.
    const { browserLiveHandlers } = await import("./browser-live.js");
    const respond = vi.fn();
    await browserLiveHandlers["browser.live.stop"]({
      params: {},
      respond,
      client: { connId: "conn-1", connect: {} },
      context: {},
    } as unknown as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledWith(true, { ok: true });
    expect(browser.screencasts[0].stopped).toBe(true);
  });

  it("is harmless when nothing was ever started", async () => {
    const res = await call("browser.live.stop", "conn-9");

    expect(res.ok).toBe(true);
  });
});

describe("browser.live.control and browser.live.input", () => {
  const click = { kind: "mouse", type: "down", x: 40, y: 30, button: "left" };

  it("forwards the controller's input to the page as a CDP input event", async () => {
    await call("browser.live.start", "conn-1");
    const taken = await call("browser.live.control", "conn-1", { mode: "user" });
    expect(taken.payload).toMatchObject({ control: "user", controller: "conn-1" });

    const sent = await call("browser.live.input", "conn-1", { event: click });

    expect(sent.payload).toEqual({ ok: true });
    expect(browser.inputs).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: expect.objectContaining({ type: "mousePressed", x: 40, y: 30 }),
      },
    ]);

    const back = await call("browser.live.control", "conn-1", { mode: "agent" });
    expect(back.payload).toMatchObject({ control: "agent" });
  });

  it("ignores input from a connection that has not taken control", async () => {
    await call("browser.live.start", "conn-1");

    const sent = await call("browser.live.input", "conn-1", { event: click });

    expect(sent.payload).toMatchObject({ ok: false });
    expect(browser.inputs).toEqual([]);
  });

  it("ignores input from another connection while someone else has control", async () => {
    await call("browser.live.start", "conn-1");
    await call("browser.live.start", "conn-2");
    await call("browser.live.control", "conn-1", { mode: "user" });

    const sent = await call("browser.live.input", "conn-2", { event: click });

    expect(sent.payload).toMatchObject({ ok: false });
    expect(browser.inputs).toEqual([]);
  });

  it("refuses control before the live view is open, or with a bad mode", async () => {
    const early = await call("browser.live.control", "conn-1", { mode: "user" });
    expect(early.ok).toBe(false);

    await call("browser.live.start", "conn-1");
    const bad = await call("browser.live.control", "conn-1", { mode: "root" });
    expect(bad.ok).toBe(false);
    expect(browser.inputs).toEqual([]);
  });
});
