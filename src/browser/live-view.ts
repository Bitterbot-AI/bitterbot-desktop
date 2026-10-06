/**
 * Live view of the agent's browser for the Control UI's "BitterBot's Computer"
 * pane (PLAN-53 A2).
 *
 * The pane used to show a mock browser frame: tool results are stripped before
 * they reach the UI, so no screenshot ever arrived. This streams the real page
 * instead, as its own event, so it does not depend on tool output at all.
 *
 * Design constraints, each learned from how the gateway behaves:
 *   - Watching must never launch a browser. An open pane resolves to "idle"
 *     until the agent starts one, then follows it.
 *   - It follows the tab the agent is using (the profile's sticky target), so
 *     a new tab or a tab switch moves the view without the viewer asking.
 *   - Viewers are leases, not subscriptions. The gateway has no per-connection
 *     close hook for handlers, so a viewer that stops renewing simply expires
 *     and the screencast stops when the last one is gone.
 *   - Frames are dropped, never queued: rate-limited here, and sent with
 *     drop-if-slow so a slow client cannot back up the socket.
 */

import { cardEntryActive } from "./card-entry.js";
import { toCdpInput } from "./live-input.js";
import type { ScreencastFrame, ScreencastHandle } from "./pw-screencast.js";
import {
  getBrowserControl,
  releaseBrowserControl,
  takeBrowserControl,
  touchBrowserControl,
} from "./takeover.js";

export type LiveViewTarget = {
  profile: string;
  cdpUrl: string;
  targetId: string;
  url: string;
  title: string;
};

export type LiveViewResolution =
  | { kind: "target"; target: LiveViewTarget }
  /** Nothing to watch yet: the browser is not running or has no page. */
  | { kind: "idle"; profile?: string }
  | { kind: "unavailable"; reason: string };

export type LiveViewStatus = {
  state: "idle" | "streaming" | "unavailable";
  profile?: string;
  targetId?: string;
  url?: string;
  title?: string;
  reason?: string;
  /** Who is driving the page. Present while streaming. */
  control?: "agent" | "user";
  /** Connection id of the viewer holding control, when a person has it. */
  controller?: string;
};

export type LiveViewFramePayload = {
  seq: number;
  targetId: string;
  /** Base64 JPEG. */
  data: string;
  deviceWidth: number;
  deviceHeight: number;
  ts: number;
};

export type LiveViewSettings = {
  quality: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
};

export type LiveViewDeps = {
  resolve: (profile?: string) => Promise<LiveViewResolution>;
  startScreencast: (opts: {
    cdpUrl: string;
    targetId: string;
    quality: number;
    maxWidth: number;
    maxHeight: number;
    onFrame: (frame: ScreencastFrame) => void;
    onClosed: (reason: string) => void;
  }) => Promise<ScreencastHandle>;
  emit: (
    event: "browser.frame" | "browser.live",
    payload: LiveViewFramePayload | LiveViewStatus,
    connIds: ReadonlySet<string>,
  ) => void;
  settings?: () => Partial<LiveViewSettings>;
  now?: () => number;
};

export const LIVE_VIEW_DEFAULTS: LiveViewSettings = {
  quality: 60,
  maxWidth: 1280,
  maxHeight: 960,
  maxFps: 8,
};

/** A viewer must renew within this window or it is dropped. */
export const LIVE_VIEW_LEASE_MS = 30_000;
/** How often the view re-checks which tab the agent is on. */
export const LIVE_VIEW_FOLLOW_MS = 1_000;
/** After a failed attach, wait this long before trying again. */
const ATTACH_RETRY_MS = 5_000;
/** A frame larger than this is a misconfiguration, not something to relay. */
const MAX_FRAME_BASE64_CHARS = 3_000_000;

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

export function createBrowserLiveView(deps: LiveViewDeps) {
  const now = deps.now ?? Date.now;
  const viewers = new Map<string, number>();
  let requestedProfile: string | undefined;
  let attached: { target: LiveViewTarget; handle: ScreencastHandle } | null = null;
  let status: LiveViewStatus = { state: "idle" };
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let retryNotBefore = 0;
  let queue: Promise<void> = Promise.resolve();

  let seq = 0;
  let lastFrame: LiveViewFramePayload | null = null;
  let lastSentAt = 0;
  let pendingFrame: LiveViewFramePayload | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  const readSettings = (): LiveViewSettings => {
    const s = deps.settings?.() ?? {};
    return {
      quality: clamp(s.quality, 10, 95, LIVE_VIEW_DEFAULTS.quality),
      maxWidth: clamp(s.maxWidth, 320, 2560, LIVE_VIEW_DEFAULTS.maxWidth),
      maxHeight: clamp(s.maxHeight, 240, 2560, LIVE_VIEW_DEFAULTS.maxHeight),
      maxFps: clamp(s.maxFps, 1, 30, LIVE_VIEW_DEFAULTS.maxFps),
    };
  };

  let active = readSettings();

  const viewerIds = (): ReadonlySet<string> => new Set(viewers.keys());

  const setStatus = (next: LiveViewStatus) => {
    if (JSON.stringify(next) === JSON.stringify(status)) {
      return;
    }
    status = next;
    if (viewers.size > 0) {
      deps.emit("browser.live", status, viewerIds());
    }
  };

  const sendFrame = (frame: LiveViewFramePayload) => {
    lastSentAt = now();
    pendingFrame = null;
    if (viewers.size > 0) {
      deps.emit("browser.frame", frame, viewerIds());
    }
  };

  const clearTrailing = () => {
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    pendingFrame = null;
  };

  const onFrame = (targetId: string, frame: ScreencastFrame) => {
    // Nobody sees a card being typed, not even the owner's own pane.
    if (cardEntryActive()) {
      return;
    }
    if (!attached || attached.target.targetId !== targetId) {
      return;
    }
    if (frame.data.length > MAX_FRAME_BASE64_CHARS) {
      return;
    }
    const payload: LiveViewFramePayload = {
      seq: ++seq,
      targetId,
      data: frame.data,
      deviceWidth: frame.deviceWidth,
      deviceHeight: frame.deviceHeight,
      ts: now(),
    };
    lastFrame = payload;
    const minInterval = 1000 / active.maxFps;
    const wait = lastSentAt + minInterval - now();
    if (wait <= 0) {
      sendFrame(payload);
      return;
    }
    // Inside the rate limit: keep only the newest frame and send it when the
    // slot opens, so the view always ends on the page's final state.
    pendingFrame = payload;
    if (!trailingTimer) {
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        if (pendingFrame) {
          sendFrame(pendingFrame);
        }
      }, wait);
    }
  };

  const detach = async () => {
    const current = attached;
    attached = null;
    lastFrame = null;
    clearTrailing();
    if (current) {
      await current.handle.stop().catch(() => {});
    }
  };

  const attach = async (target: LiveViewTarget) => {
    const s = active;
    // Chrome can deliver the first frame before startScreencast returns. On a
    // still page that frame is the only one there will be, so hold it.
    const held: { ready: boolean; early: ScreencastFrame | null } = { ready: false, early: null };
    const handle = await deps.startScreencast({
      cdpUrl: target.cdpUrl,
      targetId: target.targetId,
      quality: s.quality,
      maxWidth: s.maxWidth,
      maxHeight: s.maxHeight,
      onFrame: (frame) => {
        if (!held.ready) {
          held.early = frame;
          return;
        }
        onFrame(target.targetId, frame);
      },
      onClosed: () => {
        if (attached?.target.targetId === target.targetId) {
          attached = null;
          lastFrame = null;
          clearTrailing();
          setStatus({ state: "idle", profile: target.profile });
        }
      },
    });
    attached = { target, handle };
    held.ready = true;
    if (held.early) {
      onFrame(target.targetId, held.early);
    }
  };

  /**
   * Control only makes sense while its holder is watching the page they took.
   * A closed pane, an expired lease or a closed browser gives it back.
   */
  const reconcileControl = () => {
    const control = getBrowserControl(now());
    if (!control) {
      return;
    }
    if (!viewers.has(control.controller) || attached?.target.profile !== control.profile) {
      releaseBrowserControl();
    }
  };

  const controlFields = (profile: string): Pick<LiveViewStatus, "control" | "controller"> => {
    const control = getBrowserControl(now());
    return control?.profile === profile
      ? { control: "user", controller: control.controller }
      : { control: "agent" };
  };

  const pruneViewers = () => {
    const t = now();
    for (const [connId, expiresAt] of viewers) {
      if (expiresAt <= t) {
        viewers.delete(connId);
      }
    }
  };

  const stopFollowing = () => {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
  };

  const tick = async () => {
    // Once per tick, not once per frame: settings come from the config file.
    active = readSettings();
    pruneViewers();
    if (viewers.size === 0) {
      stopFollowing();
      await detach();
      reconcileControl();
      status = { state: "idle" };
      return;
    }

    let resolution: LiveViewResolution;
    try {
      resolution = await deps.resolve(requestedProfile);
    } catch (err) {
      resolution = { kind: "unavailable", reason: String(err) };
    }

    if (resolution.kind !== "target") {
      await detach();
      reconcileControl();
      setStatus(
        resolution.kind === "idle"
          ? { state: "idle", profile: resolution.profile }
          : { state: "unavailable", reason: resolution.reason },
      );
      return;
    }

    const { target } = resolution;
    const sameTarget =
      attached?.target.targetId === target.targetId && attached.target.cdpUrl === target.cdpUrl;
    if (!sameTarget) {
      if (now() < retryNotBefore) {
        return;
      }
      await detach();
      try {
        await attach(target);
      } catch (err) {
        retryNotBefore = now() + ATTACH_RETRY_MS;
        reconcileControl();
        setStatus({ state: "unavailable", profile: target.profile, reason: String(err) });
        return;
      }
      retryNotBefore = 0;
    }

    // The tab list can lag a navigation; the page itself is authoritative.
    const live = await attached?.handle.describe().catch(() => null);
    reconcileControl();
    setStatus({
      state: "streaming",
      profile: target.profile,
      targetId: target.targetId,
      url: live?.url || target.url,
      title: live?.title || target.title,
      ...controlFields(target.profile),
    });
  };

  /** Serialise ticks: attach and detach must never interleave. */
  const runTick = (): Promise<void> => {
    queue = queue.then(tick, tick);
    return queue;
  };

  return {
    /**
     * Register or renew a viewer. Safe to call repeatedly: the Control UI calls
     * it on an interval as its lease renewal.
     */
    async start(
      connId: string,
      opts?: { profile?: string },
    ): Promise<LiveViewStatus & { viewer: string }> {
      const isNew = !viewers.has(connId);
      viewers.set(connId, now() + LIVE_VIEW_LEASE_MS);
      const profile = opts?.profile?.trim() || undefined;
      if (profile !== requestedProfile) {
        requestedProfile = profile;
        retryNotBefore = 0;
      }
      if (!followTimer) {
        followTimer = setInterval(() => void runTick(), LIVE_VIEW_FOLLOW_MS);
        followTimer.unref?.();
      }
      const seqBefore = seq;
      await runTick();
      // A screencast only emits when the page repaints. Someone opening the
      // pane on a still page would otherwise stare at nothing, so replay the
      // last frame, unless it was produced after they joined and reached them
      // with everyone else.
      if (isNew && attached && lastFrame && lastFrame.seq <= seqBefore) {
        deps.emit("browser.frame", lastFrame, new Set([connId]));
      }
      // `viewer` lets the pane tell "I have control" from "another window does".
      return { ...status, viewer: connId };
    },

    async stop(connId: string): Promise<void> {
      viewers.delete(connId);
      // Also when others are still watching: the one who left may have held control.
      await runTick();
    },

    /** Take the browser from the agent, or hand it back. */
    async control(connId: string, mode: "user" | "agent"): Promise<LiveViewStatus> {
      if (!viewers.has(connId)) {
        throw new Error("open the live view before taking control");
      }
      if (mode === "user") {
        if (!attached) {
          throw new Error("there is no page to take control of");
        }
        takeBrowserControl(attached.target.profile, connId, now());
      } else {
        releaseBrowserControl();
      }
      await runTick();
      return status;
    },

    /** Deliver pointer or keyboard input from the viewer who holds control. */
    async input(connId: string, raw: unknown): Promise<{ ok: boolean; reason?: string }> {
      const control = getBrowserControl(now());
      if (
        !attached ||
        control?.controller !== connId ||
        control.profile !== attached.target.profile
      ) {
        return { ok: false, reason: "take control of the browser first" };
      }
      const command = toCdpInput(raw, {
        width: lastFrame?.deviceWidth ?? 0,
        height: lastFrame?.deviceHeight ?? 0,
      });
      if (!command) {
        return { ok: false, reason: "unrecognised input" };
      }
      touchBrowserControl(now());
      await attached.handle.input(command);
      return { ok: true };
    },

    async shutdown(): Promise<void> {
      viewers.clear();
      await runTick();
    },

    status: (): LiveViewStatus => status,
    viewerCount: (): number => viewers.size,
  };
}

export type BrowserLiveView = ReturnType<typeof createBrowserLiveView>;
