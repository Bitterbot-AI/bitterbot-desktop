import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { buildSetupHello } from "./server/ws-connection/setup-connect.js";

vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn(async () => ({
    heartbeat: { defaultAgentId: "main", agents: [] },
    channelSummary: [],
    queuedSystemEvents: [],
    sessions: {
      paths: [],
      count: 0,
      defaults: { model: null, contextTokens: null },
      recent: [],
      byAgent: [],
    },
  })),
}));

const { validateGatewayRuntime, validateSnapshot } = await (async () => {
  const AjvPkg = (await import("ajv")).default as unknown as new (opts: object) => {
    compile: (schema: object) => ((data: unknown) => boolean) & { errors?: unknown };
  };
  const { GatewayRuntimeSchema, SnapshotSchema } = await import("./protocol/index.js");
  const ajv = new AjvPkg({ allErrors: true, strict: false, removeAdditional: false });
  return {
    validateGatewayRuntime: ajv.compile(GatewayRuntimeSchema),
    validateSnapshot: ajv.compile(SnapshotSchema),
  };
})();

const { buildGatewayRuntimeInfo, resolveGatewayVersion } = await import("./runtime-info.js");
const { healthHandlers } = await import("./server-methods/health.js");

describe("gateway runtime info", () => {
  it("reports the real package version, not npm_package_version", () => {
    expect(resolveGatewayVersion({})).toBe(VERSION);
    expect(resolveGatewayVersion({ npm_package_version: "9.9.9" })).toBe(VERSION);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("honours an explicit BITTERBOT_VERSION override", () => {
    expect(resolveGatewayVersion({ BITTERBOT_VERSION: "2.0.0" })).toBe("2.0.0");
    expect(resolveGatewayVersion({ BITTERBOT_VERSION: "  " })).toBe(VERSION);
  });

  it("builds version, uptime, platform, arch and install kind that satisfy the schema", () => {
    const info = buildGatewayRuntimeInfo({
      env: {},
      uptimeSeconds: 12.3456,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "22.12.0",
      installKind: "tarball",
    });
    expect(info).toEqual({
      version: VERSION,
      uptimeMs: 12346,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "22.12.0",
      installKind: "tarball",
    });
    expect(validateGatewayRuntime(info)).toBe(true);
  });

  it("defaults to this process and detects an install kind", () => {
    const info = buildGatewayRuntimeInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.uptimeMs).toBeGreaterThan(0);
    expect(["git", "package", "container", "tarball", "unknown"]).toContain(info.installKind);
    expect(validateGatewayRuntime(info)).toBe(true);
  });

  it("the setup hello carries the package version", () => {
    const hello = buildSetupHello({ connId: "c1", protocol: 3 });
    expect(hello.server.version).toBe(resolveGatewayVersion());
  });

  it("the hello snapshot schema accepts runtime and rejects unknown runtime keys", () => {
    const base = {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 5,
    };
    expect(validateSnapshot({ ...base, runtime: buildGatewayRuntimeInfo() })).toBe(true);
    expect(validateSnapshot({ ...base, runtime: { ...buildGatewayRuntimeInfo(), extra: 1 } })).toBe(
      false,
    );
  });

  it("the status RPC includes runtime alongside the summary", async () => {
    const respond = vi.fn();
    await healthHandlers.status({
      respond,
      client: { connect: { scopes: ["operator.read"] } },
    } as unknown as Parameters<typeof healthHandlers.status>[0]);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0] as [boolean, Record<string, unknown>];
    expect(ok).toBe(true);
    expect(payload.channelSummary).toEqual([]);
    const runtime = payload.runtime as Record<string, unknown>;
    expect(runtime.version).toBe(resolveGatewayVersion());
    expect(typeof runtime.uptimeMs).toBe("number");
    expect(runtime.platform).toBe(process.platform);
    expect(runtime.arch).toBe(process.arch);
    expect(validateGatewayRuntime(runtime)).toBe(true);
  });
});
