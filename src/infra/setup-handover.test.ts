import { afterEach, describe, expect, it, vi } from "vitest";
import { restartGatewayProcessWithFreshPid } from "./process-respawn.js";
import {
  markSetupHandover,
  resetSetupHandoverForTest,
  scheduleSetupHandoverExit,
  setupHandoverPending,
} from "./setup-handover.js";

afterEach(() => {
  resetSetupHandoverForTest();
  vi.useRealTimers();
});

describe("setup gateway hand-over to the installed service", () => {
  it("turns a pending restart into an exit (the service manager starts the gateway)", () => {
    markSetupHandover();
    expect(restartGatewayProcessWithFreshPid()).toMatchObject({ mode: "supervised" });
  });

  it("stops this gateway with SIGTERM after the delay, once", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    scheduleSetupHandoverExit({ delayMs: 1000, kill });
    expect(setupHandoverPending()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});
