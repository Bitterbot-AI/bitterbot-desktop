import type { BrowserRouteContext } from "../server-context.js";
import { waitForAgentControl } from "../takeover.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError } from "./utils.js";

/**
 * Routes that drive the page or the browser. While a person has taken control
 * in the live view (PLAN-53 A3) these are held; everything else, including
 * snapshot and screenshot, stays open so the agent can still see.
 */
export const DRIVES_BROWSER = new Set([
  "POST /navigate",
  "POST /act",
  "POST /hooks/file-chooser",
  "POST /hooks/dialog",
  "POST /tabs/open",
  "POST /tabs/focus",
  "POST /tabs/action",
  "DELETE /tabs/:targetId",
  "POST /stop",
  "POST /reset-profile",
]);

/**
 * How long a held request waits for the hand-back before it is refused. Kept
 * under the browser client's shortest request timeout (5 s), so the agent gets
 * this refusal and its explanation, not a bare "service timed out".
 */
export const TAKEOVER_HOLD_MS = 2_500;

export const USER_IN_CONTROL_MESSAGE =
  "A person has taken control of this browser in the live view, so this action was not performed. " +
  "Do not retry in a loop. Tell them you are waiting, or try again once they hand control back. " +
  "Reading the page (snapshot, screenshot, tabs) still works.";

function withTakeoverGate(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const gate =
    (method: "GET" | "POST" | "DELETE", register: BrowserRouteRegistrar["get"]) =>
    (path: string, handler: BrowserRouteHandler) => {
      if (!DRIVES_BROWSER.has(`${method} ${path}`)) {
        register(path, handler);
        return;
      }
      register(path, async (req, res) => {
        const profileCtx = getProfileContext(req, ctx);
        // An unknown profile is the route's error to report, not the gate's.
        if (!("error" in profileCtx)) {
          const stillHeld = await waitForAgentControl(profileCtx.profile.name, TAKEOVER_HOLD_MS);
          if (stillHeld) {
            jsonError(res, 409, USER_IN_CONTROL_MESSAGE);
            return;
          }
        }
        await handler(req, res);
      });
    };
  return {
    get: gate("GET", app.get.bind(app)),
    post: gate("POST", app.post.bind(app)),
    delete: gate("DELETE", app.delete.bind(app)),
  } satisfies BrowserRouteRegistrar;
}

export function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const gated = withTakeoverGate(app, ctx);
  registerBrowserBasicRoutes(gated, ctx);
  registerBrowserTabRoutes(gated, ctx);
  registerBrowserAgentRoutes(gated, ctx);
}
