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

describe("tool output RPC scope gating", () => {
  // Tool output is command output and file contents: the gate 866c6891 closed.
  // The lease that reopens it for the owner's pane must not be reachable with
  // less than operator.admin.
  const OUTPUT_METHODS = ["tools.output.subscribe", "tools.output.unsubscribe"];

  it("is registered and advertised", () => {
    for (const method of OUTPUT_METHODS) {
      expect(coreGatewayHandlers[method], `${method} has a handler`).toBeTypeOf("function");
      expect(listGatewayMethods()).toContain(method);
    }
  });

  it.each(OUTPUT_METHODS)("%s is allowed with operator.admin", (method) => {
    expect(authorizeGatewayMethod(method, operatorWith(["operator.admin"]))).toBeNull();
  });

  it.each(OUTPUT_METHODS)("%s is refused with read and write scope", (method) => {
    const denied = authorizeGatewayMethod(
      method,
      operatorWith(["operator.read", "operator.write"]),
    );
    expect(denied?.message).toContain("operator.admin");
  });
});

describe("review RPC scope gating", () => {
  // Deciding what the agent may spend or publish is an approvals power.
  const REVIEW_METHODS = ["review.list", "review.get", "review.resolve"];

  it("is registered and advertised", () => {
    for (const method of REVIEW_METHODS) {
      expect(coreGatewayHandlers[method], `${method} has a handler`).toBeTypeOf("function");
      expect(listGatewayMethods()).toContain(method);
    }
  });

  it.each(REVIEW_METHODS)("%s is allowed with operator.approvals or admin", (method) => {
    expect(authorizeGatewayMethod(method, operatorWith(["operator.approvals"]))).toBeNull();
    expect(authorizeGatewayMethod(method, operatorWith(["operator.admin"]))).toBeNull();
  });

  it.each(REVIEW_METHODS)("%s is refused with read and write scope only", (method) => {
    const denied = authorizeGatewayMethod(
      method,
      operatorWith(["operator.read", "operator.write"]),
    );
    expect(denied?.message).toContain("operator.approvals");
  });
});

describe("memory control scopes (PLAN-53 G1)", () => {
  it("lets a reader look, and only an admin change or export", () => {
    for (const method of [
      "memory.list",
      "memory.get",
      "memory.facts",
      "memory.preferences",
      "memory.audit",
    ]) {
      expect(coreGatewayHandlers[method], `${method} has a handler`).toBeTypeOf("function");
      expect(authorizeGatewayMethod(method, operatorWith(["operator.read"]))).toBeNull();
    }
    for (const method of [
      "memory.edit",
      "memory.forget",
      "memory.forgetPreference",
      "memory.retireFact",
      "memory.export",
    ]) {
      expect(coreGatewayHandlers[method], `${method} has a handler`).toBeTypeOf("function");
      expect(authorizeGatewayMethod(method, operatorWith(["operator.write"]))).not.toBeNull();
      expect(authorizeGatewayMethod(method, operatorWith(["operator.admin"]))).toBeNull();
    }
  });
});
