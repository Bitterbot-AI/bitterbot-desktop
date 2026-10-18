import { expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { computeMeshHandlers } from "./compute-mesh.js";
it("requires local admin scope before exposing inputs or changing peer access", async () => {
  const grant = vi.fn();
  for (const method of Object.keys(computeMeshHandlers)) {
    const respond = vi.fn();
    await computeMeshHandlers[method]!({
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
      context: { computeMesh: { grant } },
      params: {},
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  }
  expect(grant).not.toHaveBeenCalled();
});
