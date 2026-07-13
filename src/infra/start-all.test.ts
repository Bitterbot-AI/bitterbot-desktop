import { describe, expect, it } from "vitest";
import { planStack } from "../../scripts/start-all.mjs";

// `pnpm start:all` decides which pieces of the stack to launch from what is
// already listening + whether a service owns the gateway. The decision must be
// idempotent (never double-start something already up) and must never start a
// gateway the wizard delegated to a systemd/launchd service.
describe("start:all planStack", () => {
  it("fresh box: starts both gateway and Control UI", () => {
    expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: false, uiUp: false })).toEqual({
      startGateway: true,
      startUi: true,
    });
  });

  it("gateway already up (re-run): starts only the Control UI", () => {
    expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: true, uiUp: false })).toEqual({
      startGateway: false,
      startUi: true,
    });
  });

  it("service-managed gateway: never starts a gateway, even when its port is down", () => {
    expect(planStack({ gatewayManagedElsewhere: true, gatewayUp: false, uiUp: false })).toEqual({
      startGateway: false,
      startUi: true,
    });
  });

  it("everything already up: starts nothing", () => {
    expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: true, uiUp: true })).toEqual({
      startGateway: false,
      startUi: false,
    });
  });

  it("service-managed gateway + UI already up: starts nothing", () => {
    expect(planStack({ gatewayManagedElsewhere: true, gatewayUp: false, uiUp: true })).toEqual({
      startGateway: false,
      startUi: false,
    });
  });
});
