import { describe, expect, it } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { DRIVES_BROWSER, registerBrowserRoutes } from "./index.js";
import type { BrowserRouteRegistrar } from "./types.js";

/**
 * The takeover gate matches routes by "METHOD /path". A renamed route would
 * silently fall out of the gate, and the agent could then act under a person's
 * hands. This registers the REAL route table and checks every gated entry is
 * still in it.
 */
describe("takeover gate route list", () => {
  it("names only routes that exist", () => {
    const registered = new Set<string>();
    const app: BrowserRouteRegistrar = {
      get: (path) => void registered.add(`GET ${path}`),
      post: (path) => void registered.add(`POST ${path}`),
      delete: (path) => void registered.add(`DELETE ${path}`),
    };

    registerBrowserRoutes(app, {} as BrowserRouteContext);

    const missing = [...DRIVES_BROWSER].filter((route) => !registered.has(route));
    expect(missing).toEqual([]);
  });

  it("gates every route that changes what is on the page", () => {
    // If a new page-driving route is added, it belongs in DRIVES_BROWSER. These
    // are the ones known today; reads and settings are deliberately absent.
    for (const route of [
      "POST /act",
      "POST /navigate",
      "POST /tabs/open",
      "DELETE /tabs/:targetId",
    ]) {
      expect(DRIVES_BROWSER.has(route), route).toBe(true);
    }
    for (const route of ["GET /snapshot", "POST /screenshot", "GET /tabs"]) {
      expect(DRIVES_BROWSER.has(route), route).toBe(false);
    }
  });
});
