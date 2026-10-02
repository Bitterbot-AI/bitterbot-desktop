import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_OUTPUT_LEASE_MS, toolOutputLeases } from "../tool-output-leases.js";
import { toolOutputHandlers } from "./tool-output.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const call = (method: keyof typeof toolOutputHandlers, connId: string | null) => {
  const respond = vi.fn();
  void toolOutputHandlers[method]({
    params: {},
    respond,
    client: connId ? { connId, connect: {} } : null,
    context: {},
  } as unknown as GatewayRequestHandlerOptions);
  return respond.mock.calls[0] as [boolean, unknown];
};

afterEach(() => {
  toolOutputLeases.revoke("conn-1");
});

describe("tools.output.subscribe", () => {
  it("grants the calling connection a lease and says how long it lasts", () => {
    const [ok, payload] = call("tools.output.subscribe", "conn-1");

    expect(ok).toBe(true);
    expect(payload).toEqual({ ok: true, leaseMs: TOOL_OUTPUT_LEASE_MS });
    expect(toolOutputLeases.has("conn-1")).toBe(true);
    expect(toolOutputLeases.has("conn-2")).toBe(false);
  });

  it("refuses a caller with no connection", () => {
    const [ok] = call("tools.output.subscribe", null);

    expect(ok).toBe(false);
  });
});

describe("tools.output.unsubscribe", () => {
  it("ends the lease", () => {
    call("tools.output.subscribe", "conn-1");

    const [ok] = call("tools.output.unsubscribe", "conn-1");

    expect(ok).toBe(true);
    expect(toolOutputLeases.has("conn-1")).toBe(false);
  });
});
