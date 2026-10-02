import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import {
  releaseBrowserControl,
  resetBrowserControlForTest,
  takeBrowserControl,
} from "../takeover.js";
import type { BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

/**
 * While a person drives the browser from the live view, the agent's actions
 * must not land on the page under their hands. The gate wraps the real route
 * table, so this test drives the real registration with stub handlers.
 */

const ran = vi.hoisted(() => [] as string[]);

// Stand-ins for the three route modules: each registers routes whose handlers
// only record that they ran.
const stub =
  (routes: Array<["get" | "post" | "delete", string]>) => (app: BrowserRouteRegistrar) => {
    for (const [method, path] of routes) {
      app[method](path, (_req, res) => {
        ran.push(`${method.toUpperCase()} ${path}`);
        res.json({ ok: true });
      });
    }
  };

vi.mock("./basic.js", () => ({
  registerBrowserBasicRoutes: stub([
    ["get", "/"],
    ["post", "/start"],
    ["post", "/stop"],
  ]),
}));
vi.mock("./tabs.js", () => ({
  registerBrowserTabRoutes: stub([
    ["get", "/tabs"],
    ["post", "/tabs/open"],
    ["delete", "/tabs/:targetId"],
  ]),
}));
vi.mock("./agent.js", () => ({
  registerBrowserAgentRoutes: stub([
    ["post", "/navigate"],
    ["post", "/act"],
    ["post", "/screenshot"],
    ["get", "/snapshot"],
  ]),
}));

const ctx = {
  forProfile: (name?: string) => {
    if (name === "missing") {
      throw new Error("unknown profile");
    }
    return { profile: { name: name ?? "bitterbot" } };
  },
} as unknown as BrowserRouteContext;

async function load() {
  const { registerBrowserRoutes, TAKEOVER_HOLD_MS, USER_IN_CONTROL_MESSAGE } =
    await import("./index.js");
  const table = new Map<string, BrowserRouteHandler>();
  const app: BrowserRouteRegistrar = {
    get: (path, handler) => void table.set(`GET ${path}`, handler),
    post: (path, handler) => void table.set(`POST ${path}`, handler),
    delete: (path, handler) => void table.set(`DELETE ${path}`, handler),
  };
  registerBrowserRoutes(app, ctx);
  const call = (route: string, body: Record<string, unknown> = {}) => {
    const result = { status: 200, body: undefined as unknown };
    const res = {
      status: (code: number) => {
        result.status = code;
        return res;
      },
      json: (payload: unknown) => {
        result.body = payload;
      },
    };
    const done = Promise.resolve(table.get(route)?.({ params: {}, query: {}, body }, res)).then(
      () => result,
    );
    return done;
  };
  return { call, TAKEOVER_HOLD_MS, USER_IN_CONTROL_MESSAGE };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  resetBrowserControlForTest();
  ran.length = 0;
});

afterEach(() => {
  resetBrowserControlForTest();
  vi.useRealTimers();
});

describe("takeover gate on browser routes", () => {
  it("lets everything through when nobody has taken control", async () => {
    const { call } = await load();

    expect((await call("POST /act")).status).toBe(200);
    expect((await call("POST /navigate")).status).toBe(200);
    expect(ran).toEqual(["POST /act", "POST /navigate"]);
  });

  it("refuses the agent's page-driving actions while a person has control", async () => {
    const { call, TAKEOVER_HOLD_MS, USER_IN_CONTROL_MESSAGE } = await load();
    takeBrowserControl("bitterbot", "conn-1");

    for (const route of [
      "POST /act",
      "POST /navigate",
      "POST /tabs/open",
      "DELETE /tabs/:targetId",
      "POST /stop",
    ]) {
      const pending = call(route);
      await vi.advanceTimersByTimeAsync(TAKEOVER_HOLD_MS);
      const res = await pending;
      expect(res.status, route).toBe(409);
      expect(res.body, route).toEqual({ error: USER_IN_CONTROL_MESSAGE });
    }
    expect(ran, "no held action reached the browser").toEqual([]);
  });

  it("still lets the agent look at the page", async () => {
    const { call } = await load();
    takeBrowserControl("bitterbot", "conn-1");

    expect((await call("GET /snapshot")).status).toBe(200);
    expect((await call("POST /screenshot")).status).toBe(200);
    expect((await call("GET /tabs")).status).toBe(200);
    expect(ran).toEqual(["GET /snapshot", "POST /screenshot", "GET /tabs"]);
  });

  it("runs a held action once control is handed back in time", async () => {
    const { call } = await load();
    takeBrowserControl("bitterbot", "conn-1");

    const pending = call("POST /act");
    await vi.advanceTimersByTimeAsync(800);
    expect(ran).toEqual([]);
    releaseBrowserControl();

    expect((await pending).status).toBe(200);
    expect(ran).toEqual(["POST /act"]);
  });

  it("does not hold actions on a profile nobody has taken", async () => {
    const { call } = await load();
    takeBrowserControl("bitterbot", "conn-1");

    expect((await call("POST /act", { profile: "work" })).status).toBe(200);
  });

  it("leaves an unknown profile for the route to report", async () => {
    const { call } = await load();
    takeBrowserControl("bitterbot", "conn-1");

    expect((await call("POST /act", { profile: "missing" })).status).toBe(200);
    expect(ran).toEqual(["POST /act"]);
  });
});
