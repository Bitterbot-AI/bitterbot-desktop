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

// The child-exit policy: the gateway stays all-or-nothing (it is the
// substrate), but the Control UI is respawned — that is how the post-update
// ui-restarter delivers new code when start:all owns the UI child — unless it
// is genuinely crash-looping (sliding window).
describe("start:all decideChildExitAction", () => {
  it.runIf(process.platform !== "win32")("gateway death still shuts everything down", async () => {
    const { decideChildExitAction } = await import("../../scripts/start-all.mjs");
    expect(decideChildExitAction({ name: "gateway", recentRespawns: [], now: 0 })).toEqual({
      action: "shutdown",
    });
  });

  it.runIf(process.platform !== "win32")("a dead UI child is respawned, not fatal", async () => {
    const { decideChildExitAction } = await import("../../scripts/start-all.mjs");
    const d = decideChildExitAction({ name: "ui", recentRespawns: [], now: 1000 });
    expect(d.action).toBe("respawn-ui");
  });

  it.runIf(process.platform !== "win32")(
    "a flapping UI shuts down; old respawns age out of the window",
    async () => {
      const { decideChildExitAction, UI_RESPAWN_MAX_IN_WINDOW, UI_RESPAWN_WINDOW_MS } =
        await import("../../scripts/start-all.mjs");
      const now = 10 * 60_000;
      const recent = Array.from({ length: UI_RESPAWN_MAX_IN_WINDOW }, (_, i) => now - 1000 - i);
      expect(decideChildExitAction({ name: "ui", recentRespawns: recent, now })).toMatchObject({
        action: "shutdown",
        reason: "ui-flapping",
      });
      // The same respawns, older than the window: fine again — a long session
      // with periodic deliberate update-bounces must never accumulate to death.
      const aged = recent.map((t) => t - UI_RESPAWN_WINDOW_MS);
      expect(decideChildExitAction({ name: "ui", recentRespawns: aged, now }).action).toBe(
        "respawn-ui",
      );
    },
  );
});
