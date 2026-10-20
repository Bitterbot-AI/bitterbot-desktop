import { describe, expect, it } from "vitest";
import { authorizeGatewayMethod, coreGatewayHandlers } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

type Client = GatewayRequestOptions["client"];

function operatorWith(scopes: string[]): Client {
  return { connect: { role: "operator", scopes } } as Client;
}

// PLAN-57 §4.8: the only gateway method that funds compute is admin-only,
// so a connection with every other operator scope cannot reach the signer.
describe("compute RPC scope gating", () => {
  it("exposes exactly the six compute methods", () => {
    const methods = Object.keys(coreGatewayHandlers).filter((m) => m.startsWith("compute."));
    expect(methods.toSorted()).toEqual([
      "compute.approve",
      "compute.jobs",
      "compute.pause",
      "compute.quote",
      "compute.status",
      "compute.trust",
    ]);
  });

  it("lets a reader see state and quotes, and nobody but an admin approve, pause or set trust", () => {
    for (const m of ["compute.status", "compute.jobs", "compute.quote"]) {
      expect(authorizeGatewayMethod(m, operatorWith(["operator.read"]))).toBeNull();
      expect(authorizeGatewayMethod(m, operatorWith([]))).not.toBeNull();
    }
    for (const m of ["compute.pause", "compute.trust"]) {
      expect(
        authorizeGatewayMethod(m, operatorWith(["operator.write", "operator.approvals"])),
      ).toMatchObject({ message: expect.stringContaining("operator.admin") });
      expect(authorizeGatewayMethod(m, operatorWith(["operator.admin"]))).toBeNull();
    }
    expect(
      authorizeGatewayMethod(
        "compute.approve",
        operatorWith(["operator.read", "operator.write", "operator.approvals", "operator.pairing"]),
      ),
    ).toMatchObject({ message: expect.stringContaining("operator.admin") });
    expect(authorizeGatewayMethod("compute.approve", operatorWith(["operator.admin"]))).toBeNull();
    expect(
      authorizeGatewayMethod("compute.approve", {
        connect: { role: "node", scopes: [] },
      } as Client),
    ).not.toBeNull();
  });
});
