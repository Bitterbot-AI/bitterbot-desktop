import { describe, expect, it } from "vitest";

// `pnpm start:all` decides which pieces of the stack to launch from what is
// already listening + whether a service owns the gateway. The decision must be
// idempotent (never double-start something already up) and must never start a
// gateway the wizard delegated to a systemd/launchd service.
//
// planStack lives in scripts/start-all.mjs, which carries a `#!/usr/bin/env node`
// shebang; importing a shebang'd .mjs through vitest fails to parse on Windows,
// so — like run-node.test.ts — these tests dynamic-import it and skip on win32.
describe("start:all planStack", () => {
  it.runIf(process.platform !== "win32")(
    "fresh box: starts both gateway and Control UI",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: false, uiUp: false })).toEqual({
        startGateway: true,
        startUi: true,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "gateway already up (re-run): starts only the Control UI",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: true, uiUp: false })).toEqual({
        startGateway: false,
        startUi: true,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "service-managed gateway: never starts a gateway, even when its port is down",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: true, gatewayUp: false, uiUp: false })).toEqual({
        startGateway: false,
        startUi: true,
      });
    },
  );

  it.runIf(process.platform !== "win32")("everything already up: starts nothing", async () => {
    const { planStack } = await import("../../scripts/start-all.mjs");
    expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: true, uiUp: true })).toEqual({
      startGateway: false,
      startUi: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "service-managed gateway + UI already up: starts nothing",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: true, gatewayUp: false, uiUp: true })).toEqual({
        startGateway: false,
        startUi: false,
      });
    },
  );
});
