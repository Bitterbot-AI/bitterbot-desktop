import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const state = vi.hoisted(() => ({
  controller: "owner",
  profile: "bitterbot",
  streaming: true,
  start: vi.fn(),
  list: vi.fn(async () => []),
  reconcile: vi.fn(),
  flushInput: vi.fn(),
}));
vi.mock("../../browser/teaching-service.js", () => ({ browserTeaching: state }));
vi.mock("../../browser/takeover.js", () => ({
  getBrowserControl: () => ({ controller: state.controller, profile: state.profile }),
}));
vi.mock("./browser-live.js", () => ({
  currentBrowserLiveView: () => ({
    flushInput: state.flushInput,
    status: () => ({ state: state.streaming ? "streaming" : "idle", profile: "bitterbot" }),
  }),
}));
import { browserTeachingHandlers } from "./browser-teaching.js";

const details = {
  title: "Find invoice",
  goal: "Find supplier invoice",
  outcome: "Matching invoice shown",
};
async function call(
  method: string,
  params: unknown = {},
  role = "operator",
  scopes = ["operator.admin"],
) {
  const respond = vi.fn();
  await browserTeachingHandlers[method]({
    params,
    respond,
    client: { connId: "owner", connect: { role, scopes } },
  } as unknown as GatewayRequestHandlerOptions);
  return respond.mock.calls[0];
}
beforeEach(() => {
  vi.clearAllMocks();
  state.controller = "owner";
  state.profile = "bitterbot";
  state.streaming = true;
});

describe("owner-only browser teaching RPC", () => {
  it("rejects read/write operators and nodes on every method", async () => {
    for (const method of Object.keys(browserTeachingHandlers)) {
      expect((await call(method, {}, "operator", ["operator.read", "operator.write"]))[0]).toBe(
        false,
      );
      expect((await call(method, {}, "node"))[0]).toBe(false);
    }
    expect(state.start).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    expect(browserTeachingHandlers["browser.teaching.append"]).toBeUndefined();
  });
  it("requires the current live controller and drains accepted input before starting", async () => {
    state.controller = "someone-else";
    expect((await call("browser.teaching.start", details))[0]).toBe(false);
    state.controller = "owner";
    state.streaming = false;
    expect((await call("browser.teaching.start", details))[0]).toBe(false);
    state.streaming = true;
    expect((await call("browser.teaching.start", details))[0]).toBe(true);
    expect(state.start).toHaveBeenCalledWith("owner", "bitterbot", details);
    expect(state.flushInput.mock.invocationCallOrder[2]).toBeLessThan(
      state.start.mock.invocationCallOrder[0],
    );
  });
  it("rejects uploaded actions and missing review acknowledgement", async () => {
    expect((await call("browser.teaching.start", { ...details, actions: [] }))[0]).toBe(false);
    expect(
      (
        await call("browser.teaching.activate", {
          id: "b6c36d5d-e1bb-467b-bf5b-34739c82663e",
          hash: "a".repeat(64),
        })
      )[0],
    ).toBe(false);
    expect(state.start).not.toHaveBeenCalled();
  });
});
