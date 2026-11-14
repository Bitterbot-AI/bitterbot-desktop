import { describe, expect, it } from "vitest";
import { authorizeGatewayMethod } from "./server-methods.js";
import {
  PACKAGE_APPROVAL_METHODS,
  PACKAGE_READ_METHODS,
  PACKAGE_WRITE_METHODS,
} from "./server-methods/skill-packages.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
const operator = (scopes: string[]) =>
  ({ connect: { role: "operator", scopes } }) as GatewayRequestOptions["client"];
describe("package authority", () => {
  it("requires operator approval authority for grants, exceptional approvals and disclosure", () => {
    for (const method of [...PACKAGE_APPROVAL_METHODS, "circles.outbound.approve"]) {
      expect(
        authorizeGatewayMethod(method, operator(["operator.read", "operator.write"]))?.message,
      ).toContain("operator.approvals");
      expect(authorizeGatewayMethod(method, operator(["operator.approvals"]))).toBeNull();
      expect(
        authorizeGatewayMethod(method, {
          connect: { role: "node", scopes: ["operator.approvals"] },
        } as GatewayRequestOptions["client"]),
      ).not.toBeNull();
    }
  });
  it("keeps read and job-request capabilities distinct", () => {
    for (const method of PACKAGE_READ_METHODS)
      expect(authorizeGatewayMethod(method, operator(["operator.read"]))).toBeNull();
    for (const method of PACKAGE_WRITE_METHODS) {
      expect(authorizeGatewayMethod(method, operator(["operator.read"]))).not.toBeNull();
      expect(authorizeGatewayMethod(method, operator(["operator.write"]))).toBeNull();
    }
  });
});
