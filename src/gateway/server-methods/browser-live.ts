/**
 * browser.live.*: the Control UI's lease on the live view of the agent's
 * browser (PLAN-53 A2), and the take-over that lets a person drive it (A3).
 * Frames go out as targeted `browser.frame` events; state changes, including
 * who has control, as `browser.live`.
 *
 * `start` doubles as the lease renewal: the pane calls it on an interval and a
 * viewer that stops calling expires. See src/browser/live-view.ts.
 */

import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import {
  type BrowserLiveView,
  createBrowserLiveView,
  type LiveViewResolution,
} from "../../browser/live-view.js";
import { getPwAiModule } from "../../browser/pw-ai-module.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayBroadcastToConnIdsFn } from "../server-broadcast.js";
import { resolveBrowserNodeTarget } from "./browser.js";
import type { GatewayRequestHandlers } from "./types.js";

/** How long to wait for the profile's CDP endpoint before calling it "not running". */
const REACHABLE_TIMEOUT_MS = 300;

async function resolveLiveTarget(profileName?: string): Promise<LiveViewResolution> {
  if (loadConfig().browser?.liveView?.enabled === false) {
    return { kind: "unavailable", reason: "live view is turned off (browser.liveView.enabled)" };
  }
  // Initialises the control state only. It never launches a browser.
  const state = await startBrowserControlServiceFromConfig();
  if (!state) {
    return { kind: "unavailable", reason: "browser control is disabled" };
  }
  const profileCtx = createBrowserControlContext().forProfile(profileName);
  const profile = profileCtx.profile;
  if (!(await profileCtx.isHttpReachable(REACHABLE_TIMEOUT_MS))) {
    return { kind: "idle", profile: profile.name };
  }
  const pages = (await profileCtx.listTabs()).filter((tab) => (tab.type ?? "page") === "page");
  if (pages.length === 0) {
    return { kind: "idle", profile: profile.name };
  }
  // Follow the tab the agent is working in, not whichever is listed first.
  const sticky = getBrowserControlState()?.profiles.get(profile.name)?.lastTargetId;
  const tab = pages.find((candidate) => candidate.targetId === sticky) ?? pages[0];
  return {
    kind: "target",
    target: {
      profile: profile.name,
      cdpUrl: profile.cdpUrl,
      targetId: tab.targetId,
      url: tab.url,
      title: tab.title,
    },
  };
}

let liveView: BrowserLiveView | null = null;
let emitToConnIds: GatewayBroadcastToConnIdsFn | null = null;

function getLiveView(broadcastToConnIds: GatewayBroadcastToConnIdsFn): BrowserLiveView {
  emitToConnIds = broadcastToConnIds;
  liveView ??= createBrowserLiveView({
    resolve: resolveLiveTarget,
    startScreencast: async (opts) => {
      const pw = await getPwAiModule({ mode: "soft" });
      if (!pw) {
        throw new Error("Playwright is not available in this gateway build");
      }
      return await pw.startScreencastViaPlaywright(opts);
    },
    // A frame nobody can keep up with is worthless a moment later: drop it.
    emit: (event, payload, connIds) =>
      emitToConnIds?.(event, payload, connIds, { dropIfSlow: true }),
    settings: () => {
      const cfg = loadConfig().browser?.liveView;
      return { maxFps: cfg?.maxFps, quality: cfg?.quality };
    },
  });
  return liveView;
}

/** Stop the screencast and drop every viewer. Called on gateway shutdown. */
export async function shutdownBrowserLiveView(): Promise<void> {
  await liveView?.shutdown().catch(() => {});
}

export const browserLiveHandlers: GatewayRequestHandlers = {
  "browser.live.start": async ({ params, respond, client, context }) => {
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "live view needs a connection to send frames to"),
      );
      return;
    }
    const profile = typeof params.profile === "string" ? params.profile : undefined;
    try {
      // When browser calls are routed to a paired node, the page is not in this
      // process and there is nothing here to screencast.
      const node = resolveBrowserNodeTarget({
        cfg: loadConfig(),
        nodes: context.nodeRegistry.listConnected(),
      });
      if (node) {
        respond(true, {
          state: "unavailable",
          reason: "the browser runs on a paired node; live view is not supported there yet",
        });
        return;
      }
      respond(true, await getLiveView(context.broadcastToConnIds).start(connId, { profile }));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "browser.live.stop": async ({ respond, client }) => {
    const connId = client?.connId;
    if (connId) {
      await liveView?.stop(connId).catch(() => {});
    }
    respond(true, { ok: true });
  },

  /** Take the browser from the agent ("user") or hand it back ("agent"). */
  "browser.live.control": async ({ params, respond, client }) => {
    const connId = client?.connId;
    const mode = params.mode;
    if (!connId || (mode !== "user" && mode !== "agent")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, 'mode must be "user" or "agent"'),
      );
      return;
    }
    if (!liveView) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "open the live view before taking control"),
      );
      return;
    }
    try {
      respond(true, await liveView.control(connId, mode));
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  /**
   * One pointer or key event from the viewer who holds control. Keystrokes pass
   * through here, passwords included: nothing in this handler logs `params`.
   */
  "browser.live.input": async ({ params, respond, client }) => {
    const connId = client?.connId;
    if (!connId || !liveView) {
      respond(true, { ok: false, reason: "take control of the browser first" });
      return;
    }
    try {
      respond(true, await liveView.input(connId, params.event));
    } catch {
      // The page may have navigated or closed under the event. Not worth an
      // error toast per keystroke; the next status event tells the pane.
      respond(true, { ok: false, reason: "the page did not accept the input" });
    }
  },
};
