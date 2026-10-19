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
  it("exposes exactly the two Phase 4 methods", () => {
    const methods = Object.keys(coreGatewayHandlers).filter((m) => m.startsWith("compute."));
    expect(methods.toSorted()).toEqual(["compute.approve", "compute.quote"]);
  });

  it("lets a reader see a quote and nobody but an admin approve", () => {
    expect(authorizeGatewayMethod("compute.quote", operatorWith(["operator.read"]))).toBeNull();
    expect(authorizeGatewayMethod("compute.quote", operatorWith([]))).not.toBeNull();
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
