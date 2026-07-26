import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleGatewayShutdown } from "./restart.js";

// scheduleGatewayShutdown self-directs a SIGTERM. These tests use fake timers
// AND an injected kill so the real process.kill is never reached — a bug here
// must not terminate the test runner.

describe("scheduleGatewayShutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a SIGTERM plan with the default delay and this pid", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const plan = scheduleGatewayShutdown({ kill });
    expect(plan).toMatchObject({ ok: true, signal: "SIGTERM", delayMs: 1500, pid: process.pid });
    expect(kill).not.toHaveBeenCalled(); // nothing fires until the timer elapses
  });

  it("fires exactly one SIGTERM to the current process after the delay", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    scheduleGatewayShutdown({ delayMs: 1000, kill });
    vi.advanceTimersByTime(999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGTERM");
  });

  it("clamps the delay to [0, 60000] and trims the reason", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    expect(scheduleGatewayShutdown({ delayMs: 999_999, kill }).delayMs).toBe(60_000);
    expect(scheduleGatewayShutdown({ delayMs: -5, kill }).delayMs).toBe(0);
    expect(scheduleGatewayShutdown({ delayMs: Number.NaN, kill }).delayMs).toBe(1500);
    expect(scheduleGatewayShutdown({ reason: "  ui.shutdown  ", kill }).reason).toBe("ui.shutdown");
  });

  it("falls back to process.exit if the signal cannot be delivered", () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    scheduleGatewayShutdown({
      delayMs: 0,
      kill: () => {
        throw new Error("no such process");
      },
    });
    vi.advanceTimersByTime(0);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
