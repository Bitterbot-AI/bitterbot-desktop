import { describe, expect, it } from "vitest";
import {
  type EventLoopSample,
  formatEventLoopWarning,
  resolveEventLoopMonitorConfig,
  shouldWarn,
  startEventLoopMonitor,
} from "./event-loop-monitor.js";

describe("resolveEventLoopMonitorConfig", () => {
  it("defaults to enabled with 30s window and 250ms threshold when env is empty", () => {
    expect(resolveEventLoopMonitorConfig({})).toEqual({
      enabled: true,
      sampleIntervalMs: 30_000,
      warnThresholdMs: 250,
    });
  });

  it("reads sample interval and threshold from env", () => {
    const cfg = resolveEventLoopMonitorConfig({
      BITTERBOT_EVENT_LOOP_SAMPLE_MS: "5000",
      BITTERBOT_EVENT_LOOP_WARN_MS: "100",
    });
    expect(cfg.sampleIntervalMs).toBe(5000);
    expect(cfg.warnThresholdMs).toBe(100);
  });

  it.each(["0", "false", "off", "no", "OFF"])(
    "treats BITTERBOT_EVENT_LOOP_MONITOR=%s as disabled",
    (val) => {
      expect(resolveEventLoopMonitorConfig({ BITTERBOT_EVENT_LOOP_MONITOR: val }).enabled).toBe(
        false,
      );
    },
  );

  it("ignores non-positive / non-numeric env values and keeps the defaults", () => {
    const cfg = resolveEventLoopMonitorConfig({
      BITTERBOT_EVENT_LOOP_SAMPLE_MS: "-5",
      BITTERBOT_EVENT_LOOP_WARN_MS: "abc",
    });
    expect(cfg.sampleIntervalMs).toBe(30_000);
    expect(cfg.warnThresholdMs).toBe(250);
  });

  it("lets explicit overrides win over env", () => {
    const cfg = resolveEventLoopMonitorConfig(
      { BITTERBOT_EVENT_LOOP_WARN_MS: "100" },
      { warnThresholdMs: 999, enabled: false },
    );
    expect(cfg.warnThresholdMs).toBe(999);
    expect(cfg.enabled).toBe(false);
  });
});

describe("shouldWarn", () => {
  const sample = (maxMs: number): EventLoopSample => ({ maxMs, meanMs: 1, p99Ms: 1 });

  it("warns when the window max is at or above the threshold", () => {
    expect(shouldWarn(sample(250), 250)).toBe(true);
    expect(shouldWarn(sample(1000), 250)).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(shouldWarn(sample(249), 250)).toBe(false);
  });

  it("stays quiet for a non-finite max (e.g. an empty histogram window)", () => {
    // A real libuv histogram always yields a finite max; guard against NaN /
    // Infinity so a degenerate window can never spuriously fire a warning.
    expect(shouldWarn(sample(Number.NaN), 250)).toBe(false);
    expect(shouldWarn(sample(Number.POSITIVE_INFINITY), 250)).toBe(false);
  });
});

describe("formatEventLoopWarning", () => {
  it("renders rounded max/p99/mean and the window in seconds", () => {
    expect(formatEventLoopWarning({ maxMs: 812.6, meanMs: 4.27, p99Ms: 300.4 }, 30_000)).toBe(
      "event loop stalled: max=813ms p99=300ms mean=4.3ms window=30s",
    );
  });
});

describe("startEventLoopMonitor", () => {
  it("returns a no-op handle when disabled and stop() is safe to call", () => {
    const handle = startEventLoopMonitor({ enabled: false });
    expect(() => handle.stop()).not.toThrow();
  });

  it("starts a real monitor and stop() tears it down cleanly (idempotent)", () => {
    const handle = startEventLoopMonitor({ enabled: true, sampleIntervalMs: 60_000 });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});
