import { create } from "zustand";
import type { LiveInputEvent } from "../lib/browser-live-input";
import type { GatewayEventFrame } from "../lib/gateway-client";
import { useGatewayStore } from "./gateway-store";

/**
 * Live view of the agent's browser (PLAN-53 A2).
 *
 * The gateway streams frames only to connections that hold a lease, and a lease
 * lapses unless it is renewed. So this store is reference-counted: the first
 * component that wants the view takes the lease, the last one to leave gives it
 * back, and while anyone is watching it renews on an interval.
 */

export type BrowserLiveState = "off" | "connecting" | "idle" | "streaming" | "unavailable";

export interface BrowserLiveFrame {
  /** data: URL, ready for an <img>. */
  src: string;
  seq: number;
  /** Viewport size in CSS pixels, for mapping pointer input later. */
  deviceWidth: number;
  deviceHeight: number;
}

interface BrowserLiveStatus {
  state: BrowserLiveState;
  reason?: string;
  profile?: string;
  targetId?: string;
  url?: string;
  title?: string;
  /** Who is driving the page: the agent, or a person in a live view. */
  control?: "agent" | "user";
  /** Gateway connection id of the viewer who has control, if a person does. */
  controller?: string;
}

interface BrowserLiveStore extends BrowserLiveStatus {
  frame: BrowserLiveFrame | null;
  watchers: number;
  /** This window's own connection id on the gateway, once it holds a lease. */
  viewer?: string;
  /** Start watching. Returns the function that stops. */
  acquire: () => () => void;
  /** Take the browser from the agent. Its page-driving actions are held meanwhile. */
  takeControl: () => Promise<void>;
  /** Give the browser back to the agent. */
  handBack: () => Promise<void>;
  /**
   * Someone asked to take over before the view was up (the handoff card).
   * The live view takes control as soon as it is streaming.
   */
  takeoverWanted: boolean;
  requestTakeover: () => void;
  clearTakeoverWanted: () => void;
  /** Send one pointer or key event. Dropped unless this window has control. */
  sendInput: (event: LiveInputEvent) => void;
}

/** True when this window, not another one, is the one driving the browser. */
export const hasBrowserControl = (s: Pick<BrowserLiveStore, "control" | "controller" | "viewer">) =>
  s.control === "user" && s.controller !== undefined && s.controller === s.viewer;

/** How long a "take over" asked for before the view is up stays wanted. */
export const TAKEOVER_WISH_MS = 20_000;

/** The gateway drops a viewer after 30 s without a renewal. */
export const BROWSER_LIVE_RENEW_MS = 10_000;

/**
 * Keep the lease this long after the last watcher leaves. Browser tool calls
 * come in runs, each one watching only while it is running; without this the
 * gateway would attach and detach the screencast between every two calls.
 */
export const BROWSER_LIVE_LINGER_MS = 3_000;

const OFF: BrowserLiveStatus & { frame: null; viewer: undefined } = {
  state: "off",
  reason: undefined,
  profile: undefined,
  targetId: undefined,
  url: undefined,
  title: undefined,
  control: undefined,
  controller: undefined,
  frame: null,
  viewer: undefined,
};

type ServerStatus = {
  state?: unknown;
  reason?: unknown;
  profile?: unknown;
  targetId?: unknown;
  url?: unknown;
  title?: unknown;
  control?: unknown;
  controller?: unknown;
  viewer?: unknown;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function toStatus(payload: unknown): BrowserLiveStatus | null {
  const p = (payload ?? {}) as ServerStatus;
  if (p.state !== "idle" && p.state !== "streaming" && p.state !== "unavailable") {
    return null;
  }
  return {
    state: p.state,
    reason: text(p.reason),
    profile: text(p.profile),
    targetId: text(p.targetId),
    url: text(p.url),
    title: text(p.title),
    control: p.control === "user" || p.control === "agent" ? p.control : undefined,
    controller: text(p.controller),
  };
}

let renewTimer: ReturnType<typeof setInterval> | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeEvents: (() => void) | null = null;
let unsubscribeConnection: (() => void) | null = null;

export const useBrowserLiveStore = create<BrowserLiveStore>((set, get) => {
  /** Someone is watching, or just was and the lease is still held. */
  const holding = () => get().watchers > 0 || lingerTimer !== null;

  const applyStatus = (status: BrowserLiveStatus) => {
    if (!holding()) {
      return;
    }
    // A frame of a page that is gone is worse than no frame.
    set(status.state === "streaming" ? status : { ...status, frame: null });
  };

  const requestLease = async () => {
    const gateway = useGatewayStore.getState();
    if (gateway.status !== "connected") {
      // Renewing into a dead socket only raises error toasts; the connection
      // watcher below asks again as soon as the gateway is back.
      return;
    }
    try {
      const response = await gateway.request("browser.live.start", {});
      const status = toStatus(response);
      if (status) {
        applyStatus(status);
        const viewer = text((response as ServerStatus | null)?.viewer);
        if (viewer && holding()) {
          set({ viewer });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      applyStatus({
        state: "unavailable",
        reason: message.includes("unknown method")
          ? "This gateway build does not have the live view yet. Update the gateway to use it."
          : message,
      });
    }
  };

  const onEvent = (evt: GatewayEventFrame) => {
    if (evt.event === "browser.frame") {
      const p = (evt.payload ?? {}) as {
        data?: unknown;
        seq?: unknown;
        deviceWidth?: unknown;
        deviceHeight?: unknown;
      };
      if (typeof p.data !== "string" || p.data.length === 0 || !holding()) {
        return;
      }
      set({
        state: "streaming",
        reason: undefined,
        frame: {
          src: `data:image/jpeg;base64,${p.data}`,
          seq: typeof p.seq === "number" ? p.seq : 0,
          deviceWidth: typeof p.deviceWidth === "number" ? p.deviceWidth : 0,
          deviceHeight: typeof p.deviceHeight === "number" ? p.deviceHeight : 0,
        },
      });
      return;
    }
    if (evt.event === "browser.live") {
      const status = toStatus(evt.payload);
      if (status) {
        applyStatus(status);
      }
    }
  };

  const begin = () => {
    set({ ...OFF, state: "connecting" });
    unsubscribeEvents = useGatewayStore.getState().subscribe(onEvent);
    // A reconnect is a new connection id on the gateway: the old lease is gone.
    unsubscribeConnection = useGatewayStore.subscribe((next, prev) => {
      if (next.status === "connected" && prev.status !== "connected") {
        void requestLease();
      }
    });
    renewTimer = setInterval(() => void requestLease(), BROWSER_LIVE_RENEW_MS);
    void requestLease();
  };

  const end = () => {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    const gateway = useGatewayStore.getState();
    if (gateway.status === "connected") {
      // Best effort: the lease expires by itself if this never arrives.
      void gateway.request("browser.live.stop", {}).catch(() => {});
    }
    set({ ...OFF });
  };

  const requestControl = async (mode: "user" | "agent") => {
    const gateway = useGatewayStore.getState();
    if (gateway.status !== "connected") {
      return;
    }
    try {
      const status = toStatus(await gateway.request("browser.live.control", { mode }));
      if (status) {
        applyStatus(status);
      }
    } catch {
      // The gateway store has already raised the error toast.
    }
  };

  return {
    ...OFF,
    watchers: 0,
    takeControl: () => requestControl("user"),
    handBack: () => requestControl("agent"),
    takeoverWanted: false,
    requestTakeover: () => {
      set({ takeoverWanted: true });
      // A wish nobody could grant must not fire minutes later.
      setTimeout(() => set({ takeoverWanted: false }), TAKEOVER_WISH_MS);
    },
    clearTakeoverWanted: () => set({ takeoverWanted: false }),
    sendInput: (event) => {
      const gateway = useGatewayStore.getState();
      if (gateway.status !== "connected" || !hasBrowserControl(get())) {
        return;
      }
      // Fire and forget: input is a stream, and a late reply to one event has
      // nothing useful to say about the next.
      void gateway.request("browser.live.input", { event }).catch(() => {});
    },
    acquire: () => {
      const watchers = get().watchers + 1;
      set({ watchers });
      if (watchers === 1) {
        if (lingerTimer) {
          // Still holding the lease from a moment ago: carry on with it.
          clearTimeout(lingerTimer);
          lingerTimer = null;
        } else {
          begin();
        }
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = Math.max(0, get().watchers - 1);
        set({ watchers: remaining });
        if (remaining === 0) {
          lingerTimer = setTimeout(() => {
            lingerTimer = null;
            end();
          }, BROWSER_LIVE_LINGER_MS);
        }
      };
    },
  };
});
