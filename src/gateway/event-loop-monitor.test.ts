import { describe, expect, it, vi } from "vitest";
import {
  type CpuProfileLike,
  type EventLoopSample,
  formatEventLoopWarning,
  formatStallAttribution,
  resolveEventLoopMonitorConfig,
  shouldWarn,
  StallProfilerPolicy,
  startEventLoopMonitor,
  summarizeProfile,
} from "./event-loop-monitor.js";

describe("resolveEventLoopMonitorConfig", () => {
  it("defaults to enabled with 30s window and 250ms threshold when env is empty", () => {
    expect(resolveEventLoopMonitorConfig({})).toEqual({
      enabled: true,
      sampleIntervalMs: 30_000,
      warnThresholdMs: 250,
      profileEnabled: true,
      profileThresholdMs: 1_000,
    });
  });

  it("reads the stall-profiler switches from env", () => {
    const cfg = resolveEventLoopMonitorConfig({
      BITTERBOT_EVENT_LOOP_PROFILE: "0",
      BITTERBOT_EVENT_LOOP_PROFILE_MS: "2500",
    });
    expect(cfg.profileEnabled).toBe(false);
    expect(cfg.profileThresholdMs).toBe(2500);
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

function syntheticProfile(samples: number[], durationUs: number): CpuProfileLike {
  return {
    startTime: 1_000_000,
    endTime: 1_000_000 + durationUs,
    samples,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } },
      { id: 2, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
      {
        id: 3,
        callFrame: {
          functionName: "sweepChunks",
          url: "file:///app/dist/memory.js",
          lineNumber: 41,
        },
      },
      { id: 4, callFrame: { functionName: "", url: "file:///app/dist/rpc.js", lineNumber: 9 } },
      { id: 5, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1 } },
    ],
  };
}

describe("summarizeProfile", () => {
  it("ranks frames by self time, drops idle, keeps GC, and names anonymous frames", () => {
    // 10 samples over 1s: 5 sweep, 2 anonymous rpc, 1 gc, 2 idle.
    const profile = syntheticProfile([3, 3, 3, 3, 3, 4, 4, 5, 2, 2], 1_000_000);
    const summary = summarizeProfile(profile, 3);
    expect(summary.profileDurationMs).toBe(1000);
    expect(summary.sampleCount).toBe(8);
    expect(summary.frames.map((f) => f.label)).toEqual([
      "sweepChunks /app/dist/memory.js:42",
      "(anonymous) /app/dist/rpc.js:10",
      "(garbage collector)",
    ]);
    expect(summary.frames[0]).toMatchObject({ percent: 50, ms: 500 });
    expect(summary.frames[2]).toMatchObject({ percent: 10, ms: 100 });
  });

  it("ignores samples that point at unknown nodes and handles an empty profile", () => {
    expect(summarizeProfile(syntheticProfile([99, 98], 500_000)).frames).toEqual([]);
    expect(summarizeProfile(syntheticProfile([], 0))).toEqual({
      frames: [],
      sampleCount: 0,
      profileDurationMs: 0,
    });
  });
});

describe("formatStallAttribution", () => {
  it("prints a header plus one aligned line per frame", () => {
    const text = formatStallAttribution({
      sample: { maxMs: 8123.4, meanMs: 30, p99Ms: 100 },
      sampleCount: 800,
      profileDurationMs: 30_000,
      frames: [
        { label: "sweepChunks /app/dist/memory.js:42", percent: 27, ms: 8100 },
        { label: "(garbage collector)", percent: 3, ms: 900 },
      ],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("event loop stall attribution: max=8123ms samples=800 over 30000ms");
    expect(lines[1]).toBe("   27%   8100ms  sweepChunks /app/dist/memory.js:42");
    expect(lines[2]).toBe("    3%    900ms  (garbage collector)");
  });

  it("says so when nothing busy was sampled", () => {
    const text = formatStallAttribution({
      sample: { maxMs: 1200, meanMs: 1, p99Ms: 2 },
      sampleCount: 0,
      profileDurationMs: 30_000,
      frames: [],
    });
    expect(text).toMatch(/no busy frames sampled$/);
  });
});

describe("StallProfilerPolicy", () => {
  it("arms on the first stalled window and disarms after the quiet run", () => {
    const policy = new StallProfilerPolicy(3);
    expect(policy.observe(false)).toBe("none");
    expect(policy.armed).toBe(false);
    expect(policy.observe(true)).toBe("arm");
    expect(policy.armed).toBe(true);
    expect(policy.observe(true)).toBe("none");
    expect(policy.observe(false)).toBe("none");
    expect(policy.observe(false)).toBe("none");
    // A stall inside the quiet run resets the countdown.
    expect(policy.observe(true)).toBe("none");
    expect(policy.observe(false)).toBe("none");
    expect(policy.observe(false)).toBe("none");
    expect(policy.observe(false)).toBe("disarm");
    expect(policy.armed).toBe(false);
    expect(policy.observe(false)).toBe("none");
  });
});

function hogEventLoop(ms: number): void {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sqrt(x + 1);
  }
  if (x < 0) {
    throw new Error("unreachable");
  }
}

describe("startEventLoopMonitor stall attribution", () => {
  it("arms a fake profiler on the first stall and attributes the next one", async () => {
    const stop = vi.fn(async () => syntheticProfile([3, 3, 3, 2], 200_000));
    const start = vi.fn(async () => {});
    const dispose = vi.fn();
    const attributions: Array<{ frames: Array<{ label: string }> }> = [];
    const handle = startEventLoopMonitor({
      sampleIntervalMs: 100,
      warnThresholdMs: 20,
      profileThresholdMs: 20,
      profilerFactory: () => ({ start, stop, dispose }),
      onAttribution: (attribution) => {
        attributions.push(attribution);
      },
    });
    try {
      // Window 1 stalls -> arm. A later stalled window -> stop/start + attribution.
      hogEventLoop(80);
      await vi.waitFor(() => expect(start).toHaveBeenCalled(), { timeout: 3_000 });
      for (let i = 0; i < 6 && attributions.length === 0; i += 1) {
        hogEventLoop(80);
        await new Promise((r) => setTimeout(r, 60));
      }
      await vi.waitFor(() => expect(attributions.length).toBeGreaterThan(0), { timeout: 3_000 });
      expect(attributions[0]?.frames[0]?.label).toBe("sweepChunks /app/dist/memory.js:42");
      expect(stop).toHaveBeenCalled();
    } finally {
      handle.stop();
    }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled(), { timeout: 2_000 });
  });

  it("attributes a real synchronous stall to the function that held the loop", async () => {
    const attributions: Array<{ frames: Array<{ label: string }> }> = [];
    const handle = startEventLoopMonitor({
      sampleIntervalMs: 150,
      warnThresholdMs: 20,
      profileThresholdMs: 20,
      onAttribution: (attribution) => {
        attributions.push(attribution);
      },
    });
    try {
      // Keep stalling across several windows: the first arms the profiler, a
      // later one is captured by it.
      for (let i = 0; i < 10 && attributions.length === 0; i += 1) {
        hogEventLoop(120);
        await new Promise((r) => setTimeout(r, 60));
      }
      await vi.waitFor(() => expect(attributions.length).toBeGreaterThan(0), { timeout: 5_000 });
      // V8 may inline the hog into its caller, so assert on the file rather than
      // the function name: the busy frames must point into this test file.
      const labels = attributions.flatMap((a) => a.frames.map((f) => f.label));
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.some((label) => label.includes("event-loop-monitor.test.ts"))).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
