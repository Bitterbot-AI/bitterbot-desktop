import { describe, expect, it } from "vitest";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { authorizeGatewayMethod } from "./server-methods.js";
import { soapboxHandlers } from "./server-methods/soapbox.js";

const read = new Set([
  "soapbox.status",
  "soapbox.wallet",
  "soapbox.jobs",
  "soapbox.job",
  "soapbox.artifact.get",
]);
function client(scopes: string[], role = "operator") {
  return { connect: { role, scopes } } as GatewayRequestOptions["client"];
}
describe("Soapbox RPC scopes", () => {
  it("requires admin for worker control and write for submission", () => {
    for (const method of Object.keys(soapboxHandlers)) {
      expect(authorizeGatewayMethod(method, client(["operator.admin"]))).toBeNull();
      expect(authorizeGatewayMethod(method, client(["operator.read"])) === null).toBe(
        read.has(method),
      );
      expect(authorizeGatewayMethod(method, client(["operator.write"])) === null).toBe(
        method !== "soapbox.worker.pause",
      );
      expect(authorizeGatewayMethod(method, client(["operator.admin"], "node"))).not.toBeNull();
    }
  });
});
