import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCardEntry, resetCardEntryForTest } from "./card-entry.js";
import type { CdpInputCommand } from "./live-input.js";
import {
  createBrowserLiveView,
  LIVE_VIEW_FOLLOW_MS,
  LIVE_VIEW_LEASE_MS,
  type LiveViewDeps,
  type LiveViewFramePayload,
  type LiveViewResolution,
  type LiveViewStatus,
} from "./live-view.js";
import type { ScreencastFrame } from "./pw-screencast.js";
import { isUserInControl, resetBrowserControlForTest, TAKEOVER_IDLE_MS } from "./takeover.js";

type Emitted = { event: string; payload: unknown; connIds: string[] };

const page = (targetId: string, url = `https://example.com/${targetId}`): LiveViewResolution => ({
  kind: "target",
  target: {
    profile: "bitterbot",
    cdpUrl: "http://127.0.0.1:18800",
    targetId,
    url,
    title: targetId,
  },
});

const frame = (data: string): ScreencastFrame => ({ data, deviceWidth: 1280, deviceHeight: 800 });

/** A fake browser: records screencasts and lets the test push frames into them. */
function harness(initial: LiveViewResolution) {
  const emitted: Emitted[] = [];
  const casts: Array<{
    targetId: string;
    stopped: boolean;
    inputs: CdpInputCommand[];
    push: (f: ScreencastFrame) => void;
    close: () => void;
  }> = [];
  const state = {
    resolution: initial,
    failAttach: null as string | null,
    /** Deliver this frame from inside startScreencast, before it returns. */
    frameDuringStart: null as ScreencastFrame | null,
    settings: {} as { maxFps?: number },
  };
  const deps: LiveViewDeps = {
    resolve: async () => state.resolution,
    startScreencast: async (opts) => {
      if (state.failAttach) {
        throw new Error(state.failAttach);
      }
      const cast = {
        targetId: opts.targetId,
        stopped: false,
        inputs: [] as CdpInputCommand[],
        push: (f: ScreencastFrame) => opts.onFrame(f),
        close: () => opts.onClosed("page closed"),
      };
      casts.push(cast);
      if (state.frameDuringStart) {
        opts.onFrame(state.frameDuringStart);
      }
      return {
        stop: async () => {
          cast.stopped = true;
        },
        describe: async () => ({ url: `live:${opts.targetId}`, title: `Live ${opts.targetId}` }),
        input: async (command) => {
          cast.inputs.push(command);
        },
      };
    },
    emit: (event, payload, connIds) => emitted.push({ event, payload, connIds: [...connIds] }),
    settings: () => state.settings,
  };
  const view = createBrowserLiveView(deps);
  const frames = () =>
    emitted
      .filter((e) => e.event === "browser.frame")
      .map((e) => e.payload as LiveViewFramePayload);
  const statuses = () =>
    emitted.filter((e) => e.event === "browser.live").map((e) => e.payload as LiveViewStatus);
  return { view, state, casts, emitted, frames, statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  resetBrowserControlForTest();
});

afterEach(() => {
  resetBrowserControlForTest();
  vi.useRealTimers();
});

describe("browser live view", () => {
  it("stays idle and attaches nothing while no browser is running", async () => {
    const h = harness({ kind: "idle", profile: "bitterbot" });

    const status = await h.view.start("conn-1");

    expect(status).toEqual({ state: "idle", profile: "bitterbot", viewer: "conn-1" });
    expect(h.casts).toHaveLength(0);
  });

  it("attaches to the agent's page and relays frames to the viewer", async () => {
    const h = harness(page("tab-a"));

    const status = await h.view.start("conn-1");
    h.casts[0].push(frame("AAAA"));

    expect(status).toEqual({
      state: "streaming",
      profile: "bitterbot",
      targetId: "tab-a",
      // Read from the page itself, which is ahead of the tab list after a navigation.
      url: "live:tab-a",
      title: "Live tab-a",
      control: "agent",
      viewer: "conn-1",
    });
    expect(h.frames()).toEqual([
      expect.objectContaining({ data: "AAAA", targetId: "tab-a", deviceWidth: 1280, seq: 1 }),
    ]);
    expect(h.emitted.at(-1)?.connIds).toEqual(["conn-1"]);
  });

  it("sends no frames while a card is being typed into the page", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    markCardEntry();
    try {
      h.casts[0].push(frame("CARD"));
      expect(h.frames()).toEqual([]);
    } finally {
      resetCardEntryForTest();
    }
  });

  it("picks the browser up when the agent starts it after the pane was opened", async () => {
    const h = harness({ kind: "idle", profile: "bitterbot" });
    await h.view.start("conn-1");

    h.state.resolution = page("tab-a");
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS);

    expect(h.casts.map((c) => c.targetId)).toEqual(["tab-a"]);
    expect(h.statuses().at(-1)).toMatchObject({ state: "streaming", targetId: "tab-a" });
  });

  it("follows the agent to another tab and releases the old one", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    h.state.resolution = page("tab-b");
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS);
    h.casts[0].push(frame("STALE"));
    h.casts[1].push(frame("FRESH"));

    expect(h.casts[0].stopped).toBe(true);
    expect(h.casts[1].targetId).toBe("tab-b");
    // A late frame from the tab we left must not be shown as the current page.
    expect(h.frames().map((f) => f.data)).toEqual(["FRESH"]);
  });

  it("does not lose the first frame when Chrome sends it before start returns", async () => {
    // On a page that never repaints, that frame is the only one there will be.
    const h = harness(page("tab-a"));
    h.state.frameDuringStart = frame("FIRST");

    await h.view.start("conn-1");

    expect(h.frames().map((f) => f.data)).toEqual(["FIRST"]);
  });

  it("shows a late joiner the current page instead of a blank pane", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    h.casts[0].push(frame("STILL"));

    await h.view.start("conn-2");

    const last = h.emitted.at(-1);
    expect(last).toMatchObject({ event: "browser.frame", connIds: ["conn-2"] });
    expect(last?.payload).toMatchObject({ data: "STILL" });
    // One screencast serves both viewers.
    expect(h.casts).toHaveLength(1);
  });

  it("rate-limits a burst but always delivers the final frame", async () => {
    const h = harness(page("tab-a"));
    h.state.settings = { maxFps: 4 }; // one frame per 250 ms
    await h.view.start("conn-1");

    h.casts[0].push(frame("f1"));
    h.casts[0].push(frame("f2"));
    h.casts[0].push(frame("f3"));
    expect(h.frames().map((f) => f.data)).toEqual(["f1"]);

    await vi.advanceTimersByTimeAsync(250);
    expect(h.frames().map((f) => f.data)).toEqual(["f1", "f3"]);
  });

  it("stops the screencast when the last viewer leaves", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.start("conn-2");

    await h.view.stop("conn-1");
    expect(h.casts[0].stopped).toBe(false);

    await h.view.stop("conn-2");
    expect(h.casts[0].stopped).toBe(true);
    expect(h.view.viewerCount()).toBe(0);
  });

  it("expires a viewer that stops renewing, and with it the screencast", async () => {
    // The gateway has no close hook for handlers: a tab that was closed without
    // calling stop must not keep Chrome encoding frames forever.
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    await vi.advanceTimersByTimeAsync(LIVE_VIEW_LEASE_MS + LIVE_VIEW_FOLLOW_MS);

    expect(h.view.viewerCount()).toBe(0);
    expect(h.casts[0].stopped).toBe(true);
    const before = h.emitted.length;
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS * 5);
    expect(h.emitted.length, "nothing is sent, and nothing polls, with no viewers").toBe(before);
  });

  it("keeps a renewing viewer past the lease window", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(LIVE_VIEW_LEASE_MS / 3);
      await h.view.start("conn-1");
    }

    expect(h.view.viewerCount()).toBe(1);
    expect(h.casts).toHaveLength(1);
    expect(h.casts[0].stopped).toBe(false);
  });

  it("goes idle when the page closes and re-attaches when one comes back", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    h.state.resolution = { kind: "idle", profile: "bitterbot" };
    h.casts[0].close();
    expect(h.statuses().at(-1)).toEqual({ state: "idle", profile: "bitterbot" });

    h.state.resolution = page("tab-c");
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS);
    expect(h.casts.at(-1)?.targetId).toBe("tab-c");
    expect(h.statuses().at(-1)).toMatchObject({ state: "streaming", targetId: "tab-c" });
  });

  it("reports why it cannot attach, backs off, then recovers", async () => {
    const h = harness(page("tab-a"));
    h.state.failAttach = "Playwright is not available";

    const status = await h.view.start("conn-1");
    expect(status).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("Playwright"),
    });

    // No hammering: the next few follow ticks do not retry.
    h.state.failAttach = null;
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS * 2);
    expect(h.casts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS * 4);
    expect(h.casts).toHaveLength(1);
    expect(h.statuses().at(-1)).toMatchObject({ state: "streaming" });
  });

  it("passes through an unavailable resolution without attaching", async () => {
    const h = harness({ kind: "unavailable", reason: "browser control is disabled" });

    expect(await h.view.start("conn-1")).toMatchObject({
      state: "unavailable",
      reason: "browser control is disabled",
    });
    expect(h.casts).toHaveLength(0);
  });

  it("releases everything on shutdown", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    await h.view.shutdown();

    expect(h.casts[0].stopped).toBe(true);
    expect(h.view.viewerCount()).toBe(0);
  });
});

describe("browser live view: taking control", () => {
  const click = { kind: "mouse", type: "down", x: 100, y: 50, button: "left", clickCount: 1 };

  it("delivers nothing from a viewer who has not taken control", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    expect(await h.view.input("conn-1", click)).toMatchObject({ ok: false });
    expect(h.casts[0].inputs).toEqual([]);
  });

  it("hands the browser to the viewer and tells every viewer who has it", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.start("conn-2");

    const status = await h.view.control("conn-1", "user");

    expect(status).toMatchObject({ state: "streaming", control: "user", controller: "conn-1" });
    expect(isUserInControl("bitterbot")).toBe(true);
    const announced = h.emitted.filter((e) => e.event === "browser.live").at(-1);
    expect(announced?.connIds.toSorted()).toEqual(["conn-1", "conn-2"]);
  });

  it("sends the controller's input to the page and nobody else's", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.start("conn-2");
    h.casts[0].push(frame("AAAA"));
    await h.view.control("conn-1", "user");

    expect(await h.view.input("conn-1", click)).toEqual({ ok: true });
    expect(await h.view.input("conn-2", click)).toMatchObject({ ok: false });

    expect(h.casts[0].inputs).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: expect.objectContaining({ type: "mousePressed", x: 100, y: 50, button: "left" }),
      },
    ]);
  });

  it("drops input it does not recognise instead of forwarding it", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.control("conn-1", "user");

    expect(await h.view.input("conn-1", { kind: "eval", code: "alert(1)" })).toMatchObject({
      ok: false,
    });
    expect(h.casts[0].inputs).toEqual([]);
  });

  it("gives the browser back on hand-back", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.control("conn-1", "user");

    const status = await h.view.control("conn-1", "agent");

    expect(status).toMatchObject({ control: "agent" });
    expect(status.controller).toBeUndefined();
    expect(isUserInControl("bitterbot")).toBe(false);
  });

  it("gives the browser back when the controller closes the pane", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.start("conn-2");
    await h.view.control("conn-1", "user");

    await h.view.stop("conn-1");

    expect(isUserInControl("bitterbot")).toBe(false);
    expect(h.statuses().at(-1)).toMatchObject({ control: "agent" });
  });

  it("gives the browser back when the controller's lease lapses", async () => {
    // A closed laptop lid must not leave the agent locked out.
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.control("conn-1", "user");

    await vi.advanceTimersByTimeAsync(LIVE_VIEW_LEASE_MS + LIVE_VIEW_FOLLOW_MS);

    expect(isUserInControl("bitterbot")).toBe(false);
  });

  it("gives the browser back after the controller goes quiet, and says so", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.control("conn-1", "user");

    // Still watching (the lease keeps renewing) but not touching anything.
    for (let elapsed = 0; elapsed < TAKEOVER_IDLE_MS; elapsed += LIVE_VIEW_LEASE_MS / 2) {
      await vi.advanceTimersByTimeAsync(LIVE_VIEW_LEASE_MS / 2);
      await h.view.start("conn-1");
    }
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS);

    expect(isUserInControl("bitterbot")).toBe(false);
    expect(h.statuses().at(-1)).toMatchObject({ state: "streaming", control: "agent" });
  });

  it("gives the browser back when the page goes away", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");
    await h.view.control("conn-1", "user");

    h.state.resolution = { kind: "idle", profile: "bitterbot" };
    await vi.advanceTimersByTimeAsync(LIVE_VIEW_FOLLOW_MS);

    expect(isUserInControl("bitterbot")).toBe(false);
  });

  it("refuses control to someone who is not watching", async () => {
    const h = harness(page("tab-a"));
    await h.view.start("conn-1");

    await expect(h.view.control("conn-9", "user")).rejects.toThrow(/open the live view/);
    expect(isUserInControl("bitterbot")).toBe(false);
  });

  it("refuses control when there is no page to control", async () => {
    const h = harness({ kind: "idle", profile: "bitterbot" });
    await h.view.start("conn-1");

    await expect(h.view.control("conn-1", "user")).rejects.toThrow(/no page/);
  });
});
