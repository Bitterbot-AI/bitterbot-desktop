import { describe, expect, it } from "vitest";

// Since PLAN-39 Phase 4 the gateway serves the Control UI itself, so
// `pnpm start:all` is a thin idempotent alias of `pnpm start gateway`. The
// only decision left is whether to start a gateway at all: never double-start
// one that is already listening, and never start one the wizard delegated to a
// systemd/launchd service. The UI child, its respawn window, and
// decideChildExitAction were deleted with the cutover — the machinery existed
// only because a separate Vite process could not pick up an applied update.
//
// planStack lives in scripts/start-all.mjs, which carries a `#!/usr/bin/env node`
// shebang; importing a shebang'd .mjs through vitest fails to parse on Windows,
// so — like run-node.test.ts — these tests dynamic-import it and skip on win32.
describe("start:all planStack", () => {
  it.runIf(process.platform !== "win32")("fresh box: starts the gateway", async () => {
    const { planStack } = await import("../../scripts/start-all.mjs");
    expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: false })).toEqual({
      startGateway: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "gateway already up (re-run): starts nothing",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: false, gatewayUp: true })).toEqual({
        startGateway: false,
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "service-managed gateway: never starts one, even when its port is down",
    async () => {
      const { planStack } = await import("../../scripts/start-all.mjs");
      expect(planStack({ gatewayManagedElsewhere: true, gatewayUp: false })).toEqual({
        startGateway: false,
      });
    },
  );
});
