// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGatewayStartHandler, parseGatewayTarget } from "./gateway-launcher";

function fakeReq(method: string, token?: string): IncomingMessage {
  return {
    method,
    headers: token === undefined ? {} : { "x-bitterbot-token": token },
  } as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { statusCode: 0, body: {} as Record<string, unknown> };
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (payload: string) => {
      state.statusCode = res.statusCode;
      state.body = JSON.parse(payload) as Record<string, unknown>;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

const baseOpts = {
  resolveToken: () => "secret",
  gatewayUrl: "ws://localhost:19001",
  repoRoot: "/repo",
  logPath: "/tmp/launch.log",
};

describe("parseGatewayTarget", () => {
  it("extracts host/port and falls back to defaults", () => {
    expect(parseGatewayTarget("ws://localhost:19001")).toEqual({ host: "localhost", port: 19001 });
    expect(parseGatewayTarget("ws://10.0.0.5:4444")).toEqual({ host: "10.0.0.5", port: 4444 });
    expect(parseGatewayTarget("not a url")).toEqual({ host: "127.0.0.1", port: 19001 });
  });
});

describe("createGatewayStartHandler", () => {
  it("rejects non-POST requests", async () => {
    const spawnGateway = vi.fn();
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway,
      probe: async () => false,
    });
    const { res, state } = fakeRes();
    await handler(fakeReq("GET", "secret"), res);
    expect(state.statusCode).toBe(405);
    expect(spawnGateway).not.toHaveBeenCalled();
  });

  it("refuses to spawn when no token is configured", async () => {
    const spawnGateway = vi.fn();
    const handler = createGatewayStartHandler({
      ...baseOpts,
      resolveToken: () => "",
      spawnGateway,
      probe: async () => false,
    });
    const { res, state } = fakeRes();
    await handler(fakeReq("POST", ""), res);
    expect(state.statusCode).toBe(503);
    expect(spawnGateway).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong token", async () => {
    const spawnGateway = vi.fn();
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway,
      probe: async () => false,
    });
    for (const token of [undefined, "wrong"]) {
      const { res, state } = fakeRes();
      await handler(fakeReq("POST", token), res);
      expect(state.statusCode).toBe(403);
    }
    expect(spawnGateway).not.toHaveBeenCalled();
  });

  it("reports running without spawning when the port answers", async () => {
    const spawnGateway = vi.fn();
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway,
      probe: async () => true,
    });
    const { res, state } = fakeRes();
    await handler(fakeReq("POST", "secret"), res);
    expect(state.statusCode).toBe(200);
    expect(state.body.state).toBe("running");
    expect(spawnGateway).not.toHaveBeenCalled();
  });

  it("spawns when the port is down, then reports starting while the child lives", async () => {
    const spawnGateway = vi.fn(() => 4242);
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway,
      probe: async () => false,
      isPidAlive: () => true,
    });

    const first = fakeRes();
    await handler(fakeReq("POST", "secret"), first.res);
    expect(first.state.body).toMatchObject({ ok: true, state: "started", pid: 4242 });

    // Second click while booting: no double-spawn.
    const second = fakeRes();
    await handler(fakeReq("POST", "secret"), second.res);
    expect(second.state.body).toMatchObject({ ok: true, state: "starting", pid: 4242 });
    expect(spawnGateway).toHaveBeenCalledTimes(1);
  });

  it("respawns when the previous child died without ever listening", async () => {
    const spawnGateway = vi.fn(() => 4242);
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway,
      probe: async () => false,
      isPidAlive: () => false,
    });
    for (const _ of [1, 2]) {
      const { res } = fakeRes();
      await handler(fakeReq("POST", "secret"), res);
    }
    expect(spawnGateway).toHaveBeenCalledTimes(2);
  });

  it("surfaces spawn failure as a 500", async () => {
    const handler = createGatewayStartHandler({
      ...baseOpts,
      spawnGateway: () => undefined,
      probe: async () => false,
    });
    const { res, state } = fakeRes();
    await handler(fakeReq("POST", "secret"), res);
    expect(state.statusCode).toBe(500);
    expect(state.body.ok).toBe(false);
  });
});
