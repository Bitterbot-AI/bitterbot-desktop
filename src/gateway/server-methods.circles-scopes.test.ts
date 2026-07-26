import { describe, expect, it } from "vitest";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { authorizeGatewayMethod } from "./server-methods.js";
import { circlesHandlers } from "./server-methods/circles.js";

// Every circles RPC must be reachable with operator.read/operator.write —
// none may silently fall through to the terminal operator.admin branch. The
// PLAN-36 surface (canvas, drafts, outbound approvals, reactions, pins,
// petnames, member removal) shipped without scope-set entries, which locked a
// write-scoped operator out of the entire new surface until 2026-07-25. This
// test iterates the real handler registry so the next batch of methods cannot
// drift the same way.

type Client = GatewayRequestOptions["client"];

function operatorWith(scopes: string[]): Client {
  return { connect: { role: "operator", scopes } } as Client;
}

/** Read-only circles methods: usable with operator.read alone. */
const READ_ONLY = new Set([
  "circles.status",
  "circles.list",
  "circles.messages",
  "circles.tab.balances",
  "circles.disclosure.list",
  "circles.briefing",
  "circles.inviteInfo",
  "circles.canvas.list",
  "circles.outbound.list",
  "circles.drafts.list",
]);

const ALL_CIRCLES_METHODS = Object.keys(circlesHandlers).filter((m) => m.startsWith("circles."));

describe("circles RPC scope gating", () => {
  it("registers the surface this test believes it is guarding", () => {
    // If methods are added or renamed, both this count and the READ_ONLY set
    // above deserve a fresh look.
    expect(ALL_CIRCLES_METHODS.length).toBe(39);
    for (const m of READ_ONLY) {
      expect(ALL_CIRCLES_METHODS).toContain(m);
    }
  });

  it("authorizes every circles method with read+write scopes (no admin fall-through)", () => {
    const client = operatorWith(["operator.read", "operator.write"]);
    for (const method of ALL_CIRCLES_METHODS) {
      expect(authorizeGatewayMethod(method, client), method).toBeNull();
    }
  });

  it("authorizes read-only methods with operator.read alone", () => {
    const client = operatorWith(["operator.read"]);
    for (const method of READ_ONLY) {
      expect(authorizeGatewayMethod(method, client), method).toBeNull();
    }
  });

  it("denies mutating methods to a read-only operator", () => {
    const client = operatorWith(["operator.read"]);
    for (const method of ALL_CIRCLES_METHODS) {
      if (READ_ONLY.has(method)) continue;
      const err = authorizeGatewayMethod(method, client);
      expect(err?.message, method).toContain("missing scope: operator.write");
    }
  });

  it("denies everything to an operator with no scopes", () => {
    const client = operatorWith([]);
    for (const method of ALL_CIRCLES_METHODS) {
      expect(authorizeGatewayMethod(method, client), method).not.toBeNull();
    }
  });
});
