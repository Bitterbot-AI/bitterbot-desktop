import { describe, expect, it } from "vitest";
import { listGatewayMethods } from "./server-methods-list.js";
import { authorizeGatewayMethod, coreGatewayHandlers } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

// The live view shows whatever the agent's browser shows, logged-in pages
// included. It must be reachable with operator.write (the scope browser.request
// already needs) and must not be reachable with operator.read alone.

type Client = GatewayRequestOptions["client"];

const operatorWith = (scopes: string[]): Client =>
  ({ connect: { role: "operator", scopes } }) as Client;

const METHODS = [
  "browser.live.start",
  "browser.live.stop",
  "browser.live.control",
  "browser.live.input",
];

describe("browser live view RPC scope gating", () => {
  it("is registered and advertised", () => {
    for (const method of METHODS) {
      expect(coreGatewayHandlers[method], `${method} has a handler`).toBeTypeOf("function");
      expect(listGatewayMethods()).toContain(method);
    }
  });

  it.each(METHODS)("%s is allowed with operator.write", (method) => {
    expect(authorizeGatewayMethod(method, operatorWith(["operator.write"]))).toBeNull();
    expect(authorizeGatewayMethod(method, operatorWith(["operator.admin"]))).toBeNull();
  });

  it.each(METHODS)("%s is refused with operator.read alone", (method) => {
    const denied = authorizeGatewayMethod(method, operatorWith(["operator.read"]));
    expect(denied?.message).toContain("operator.write");
  });

  it.each(METHODS)("%s is refused for a node connection", (method) => {
    const denied = authorizeGatewayMethod(method, {
      connect: { role: "node", scopes: ["operator.write"] },
    } as Client);
    expect(denied?.message).toContain("unauthorized role");
  });
});
