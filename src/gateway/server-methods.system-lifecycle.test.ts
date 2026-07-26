import { describe, expect, it } from "vitest";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { authorizeGatewayMethod } from "./server-methods.js";
import { systemHandlers } from "./server-methods/system.js";

// system.restart / system.shutdown stop or bounce the node, so they must sit
// behind operator.admin (they hold no place in the read/write sets and fall
// through to the admin catch-all). This guards that a future refactor of the
// scope tables can't silently expose them to a read/write-only operator.

type Client = GatewayRequestOptions["client"];
const operator = (scopes: string[]): Client =>
  ({ connect: { role: "operator", scopes } }) as Client;

const LIFECYCLE = ["system.restart", "system.shutdown"];

describe("gateway lifecycle method gating", () => {
  it("registers both handlers", () => {
    for (const m of LIFECYCLE) expect(Object.keys(systemHandlers)).toContain(m);
  });

  it("requires operator.admin (write/read are not enough)", () => {
    for (const m of LIFECYCLE) {
      expect(authorizeGatewayMethod(m, operator(["operator.admin"])), m).toBeNull();
      for (const insufficient of [[], ["operator.read"], ["operator.write"]]) {
        const err = authorizeGatewayMethod(m, operator(insufficient));
        expect(err?.message, `${m} with [${insufficient.join(",")}]`).toContain(
          "missing scope: operator.admin",
        );
      }
    }
  });

  it("rejects the node role outright", () => {
    for (const m of LIFECYCLE) {
      const err = authorizeGatewayMethod(m, { connect: { role: "node", scopes: [] } } as Client);
      expect(err, m).not.toBeNull();
    }
  });
});
