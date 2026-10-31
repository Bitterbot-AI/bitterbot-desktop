/**
 * Event-loop delay monitor for the gateway.
 *
 * The gateway runs the memory engines, P2P bridge, and every RPC handler on a
 * single Node event loop. A long synchronous burst there (an unyielded SQLite
 * sweep, a stampede of identical RPCs, a slow IPC drain) blocks the loop, so the
 * 30s WebSocket keepalive `tick` cannot flush and the Control UI bounces with a
 * `code=1006` tick-timeout. Historically that blockage could only be *inferred*
 * indirectly — e.g. several RPCs resolving at the same wall-clock instant with
 * near-identical durations (queued behind the block, released together).
 *
 * This monitor measures the stall directly. `perf_hooks.monitorEventLoopDelay`
 * runs a high-resolution histogram in libuv (negligible cost); every
 * `sampleIntervalMs` we read max/p99/mean, reset, and if the worst stall in the
 * window crossed the warn threshold we emit a structured WARN and (when OTel is
 * enabled) a `gateway.event_loop_delay` span. Operators then see *when* the loop
 * stalled and can line it up against the `res ✓ <method> <ms>` line for the
 * handler that was running, instead of reverse-engineering it from timestamps.
 *
 * Knowing *when* is not always enough: a stall with no RPC in flight (a timer-
 * driven memory sweep, a GC pause) leaves nothing to line up against. So the
 * monitor also attributes stalls. Once a window has stalled past the warn
 * threshold it arms V8's sampling CPU profiler (`inspector` Profiler, ~10ms
 * samples, a separate sampler thread so it observes the blocked main thread).
 * Each later window whose max stall crosses the attribution threshold logs the
 * frames that held the loop (self time, file:line), including `(garbage
 * collector)` when the stall is a GC pause. After enough quiet windows the
 * profiler disarms again, so a healthy gateway pays nothing.
 *
 * On by default at gateway boot. Tunable / disengageable via env:
 *   BITTERBOT_EVENT_LOOP_MONITOR=0        disable entirely
 *   BITTERBOT_EVENT_LOOP_SAMPLE_MS=30000  sampling window (ms)
 *   BITTERBOT_EVENT_LOOP_WARN_MS=250      warn when a window's max delay >= this
 *   BITTERBOT_EVENT_LOOP_PROFILE=0        never attribute (no profiler)
 *   BITTERBOT_EVENT_LOOP_PROFILE_MS=1000  attribute when a window's max >= this
 */

import { Session } from "node:inspector";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { startSpan } from "../observability/otel.js";

const log = createSubsystemLogger("gateway/event-loop");

const NS_PER_MS = 1e6;
const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_WARN_THRESHOLD_MS = 250;
const DEFAULT_PROFILE_THRESHOLD_MS = 1_000;
/** libuv histogram resolution; the loop is probed every this-many ms. */
const HISTOGRAM_RESOLUTION_MS = 20;
/** V8 sampling interval while the profiler is armed (microseconds). */
const PROFILER_SAMPLING_INTERVAL_US = 10_000;
/** Consecutive windows below the warn threshold before the profiler disarms. */
const QUIET_WINDOWS_TO_DISARM = 10;
/** How many frames a stall attribution lists. */
const ATTRIBUTION_TOP_FRAMES = 6;

export type EventLoopSample = { maxMs: number; meanMs: number; p99Ms: number };

export type EventLoopMonitorConfig = {
  enabled: boolean;
  sampleIntervalMs: number;
  warnThresholdMs: number;
  /** Attribute stalls with the sampling profiler (armed after the first warning). */
  profileEnabled: boolean;
  /** A window's max stall must reach this before its frames are logged. */
  profileThresholdMs: number;
};

export type EventLoopMonitorHandle = { stop: () => void };

/** One line of a stall attribution: where the main thread spent its time. */
export type StallFrame = {
  label: string;
  /** Share of the window's samples that landed in this frame (0-100). */
  percent: number;
  /** Approximate self time in the window (ms). */
  ms: number;
};

export type StallAttribution = {
  sample: EventLoopSample;
  frames: StallFrame[];
  sampleCount: number;
  profileDurationMs: number;
};

/** The subset of a CDP `Profiler.Profile` the attribution uses. */
export type CpuProfileLike = {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }>;
  samples?: number[];
  startTime: number;
  endTime: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDisabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/**
 * Resolve the monitor config from env, with optional explicit overrides taking
 * precedence. Pure — no process state — so it is unit-testable with a fake env.
 */
export function resolveEventLoopMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<EventLoopMonitorConfig>,
): EventLoopMonitorConfig {
  return {
    enabled: overrides?.enabled ?? !parseDisabled(env.BITTERBOT_EVENT_LOOP_MONITOR),
    sampleIntervalMs:
      overrides?.sampleIntervalMs ??
      parsePositiveInt(env.BITTERBOT_EVENT_LOOP_SAMPLE_MS, DEFAULT_SAMPLE_INTERVAL_MS),
    warnThresholdMs:
      overrides?.warnThresholdMs ??
      parsePositiveInt(env.BITTERBOT_EVENT_LOOP_WARN_MS, DEFAULT_WARN_THRESHOLD_MS),
    profileEnabled: overrides?.profileEnabled ?? !parseDisabled(env.BITTERBOT_EVENT_LOOP_PROFILE),
    profileThresholdMs:
      overrides?.profileThresholdMs ??
      parsePositiveInt(env.BITTERBOT_EVENT_LOOP_PROFILE_MS, DEFAULT_PROFILE_THRESHOLD_MS),
  };
}

/**
 * Collapse a CPU profile into self-time per frame, heaviest first. Pure, so the
 * ranking is unit-testable with a synthetic profile. V8's synthetic nodes keep
 * their parenthesised names: `(garbage collector)` is a real answer (the stall
 * was a GC pause), `(idle)` is dropped because idle time is not a stall.
 */
export function summarizeProfile(
  profile: CpuProfileLike,
  top: number = ATTRIBUTION_TOP_FRAMES,
): { frames: StallFrame[]; sampleCount: number; profileDurationMs: number } {
  const samples = profile.samples ?? [];
  const durationMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const counts = new Map<string, number>();
  let counted = 0;
  for (const id of samples) {
    const node = byId.get(id);
    if (!node) {
      continue;
    }
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === "(idle)") {
      continue;
    }
    counted += 1;
    const file = url.replace(/^file:\/\//, "");
    const where = file ? `${file}:${lineNumber + 1}` : "";
    const label = `${functionName || "(anonymous)"}${where ? ` ${where}` : ""}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = samples.length;
  const frames = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([label, count]) => ({
      label,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
      ms: total > 0 ? Math.round((count / total) * durationMs) : 0,
    }));
  return { frames, sampleCount: counted, profileDurationMs: Math.round(durationMs) };
}

export function formatStallAttribution(attribution: StallAttribution): string {
  const head =
    `event loop stall attribution: max=${Math.round(attribution.sample.maxMs)}ms ` +
    `samples=${attribution.sampleCount} over ${attribution.profileDurationMs}ms`;
  if (attribution.frames.length === 0) {
    return `${head}; no busy frames sampled`;
  }
  const lines = attribution.frames.map(
    (frame) =>
      `  ${String(frame.percent).padStart(3)}% ${String(frame.ms).padStart(6)}ms  ${frame.label}`,
  );
  return [head, ...lines].join("\n");
}

/**
 * Arm/disarm policy for the stall profiler, kept pure so the state machine is
 * testable: arm on the first warned window, stay armed while stalls keep coming,
 * disarm after `quietWindowsToDisarm` consecutive quiet windows.
 */
export class StallProfilerPolicy {
  private quietWindows = 0;
  private armedState = false;

  constructor(private readonly quietWindowsToDisarm: number = QUIET_WINDOWS_TO_DISARM) {}

  get armed(): boolean {
    return this.armedState;
  }

  /** Feed one window; returns the transition the caller must apply. */
  observe(stalled: boolean): "arm" | "disarm" | "none" {
    if (stalled) {
      this.quietWindows = 0;
      if (!this.armedState) {
        this.armedState = true;
        return "arm";
      }
      return "none";
    }
    if (!this.armedState) {
      return "none";
    }
    this.quietWindows += 1;
    if (this.quietWindows >= this.quietWindowsToDisarm) {
      this.armedState = false;
      this.quietWindows = 0;
      return "disarm";
    }
    return "none";
  }
}

type ProfilerDriver = {
  start(): Promise<void>;
  /** Stop and return the profile since the last start. */
  stop(): Promise<CpuProfileLike | null>;
  dispose(): void;
};

/** Thin async wrapper over the inspector Profiler domain. */
function createInspectorProfiler(): ProfilerDriver {
  const session = new Session();
  let connected = false;
  const post = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (err: Error | null, result?: unknown) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result as T);
      });
    });
  return {
    async start() {
      if (!connected) {
        session.connect();
        connected = true;
        await post("Profiler.enable");
        await post("Profiler.setSamplingInterval", { interval: PROFILER_SAMPLING_INTERVAL_US });
      }
      await post("Profiler.start");
    },
    async stop() {
      const result = await post<{ profile?: CpuProfileLike }>("Profiler.stop");
      return result?.profile ?? null;
    },
    dispose() {
      if (connected) {
        try {
          session.disconnect();
        } catch {
          // already gone
        }
        connected = false;
      }
    },
  };
}

/** True when a sampled window's worst stall warrants a warning. */
export function shouldWarn(sample: EventLoopSample, warnThresholdMs: number): boolean {
  return Number.isFinite(sample.maxMs) && sample.maxMs >= warnThresholdMs;
}

export function formatEventLoopWarning(sample: EventLoopSample, windowMs: number): string {
  return (
    `event loop stalled: max=${Math.round(sample.maxMs)}ms ` +
    `p99=${Math.round(sample.p99Ms)}ms mean=${sample.meanMs.toFixed(1)}ms ` +
    `window=${Math.round(windowMs / 1000)}s`
  );
}

/**
 * Start sampling the event-loop delay. Returns a handle whose `stop()` tears the
 * monitor down (interval + histogram). Safe to call when disabled — it returns a
 * no-op handle so callers need not branch on enablement.
 */
export type StartEventLoopMonitorOptions = Partial<EventLoopMonitorConfig> & {
  /** Test seam: receives each attribution instead of (not in addition to) logging it. */
  onAttribution?: (attribution: StallAttribution) => void;
  /** Test seam: replace the inspector-backed profiler. */
  profilerFactory?: () => ProfilerDriver;
};

export function startEventLoopMonitor(
  overrides?: StartEventLoopMonitorOptions,
): EventLoopMonitorHandle {
  const { onAttribution, profilerFactory, ...configOverrides } = overrides ?? {};
  const config = resolveEventLoopMonitorConfig(process.env, configOverrides);
  if (!config.enabled) {
    log.debug("event-loop delay monitor disabled via config");
    return { stop: () => {} };
  }

  const histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  histogram.enable();

  // ── Stall attribution (sampling profiler, armed on demand) ──
  const policy = new StallProfilerPolicy();
  let profiler: ProfilerDriver | null = null;
  let profilerBroken = false;
  let profilerBusy = false;
  const disarmProfiler = async () => {
    const current = profiler;
    profiler = null;
    if (!current) {
      return;
    }
    try {
      await current.stop();
    } catch {
      // nothing to flush
    }
    current.dispose();
  };
  const attribute = async (sample: EventLoopSample) => {
    if (!config.profileEnabled || profilerBroken || profilerBusy) {
      return;
    }
    profilerBusy = true;
    try {
      const stalled = shouldWarn(sample, config.warnThresholdMs);
      const transition = policy.observe(stalled);
      if (transition === "arm") {
        profiler = (profilerFactory ?? createInspectorProfiler)();
        await profiler.start();
        log.info("event-loop stall profiler armed; the next stall will be attributed");
        return;
      }
      if (transition === "disarm") {
        await disarmProfiler();
        log.info("event-loop stall profiler disarmed after a quiet period");
        return;
      }
      if (!profiler) {
        return;
      }
      // Rotate the profile every window so memory stays bounded and each
      // attribution covers exactly the window that stalled.
      const profile = await profiler.stop();
      await profiler.start();
      if (!profile || sample.maxMs < config.profileThresholdMs) {
        return;
      }
      const summary = summarizeProfile(profile);
      const attribution: StallAttribution = { sample, ...summary };
      if (onAttribution) {
        onAttribution(attribution);
      } else {
        log.warn(formatStallAttribution(attribution), {
          maxMs: Math.round(sample.maxMs),
          frames: attribution.frames,
        });
      }
    } catch (err) {
      profilerBroken = true;
      log.debug(`event-loop stall profiler unavailable: ${String(err)}`);
      await disarmProfiler();
    } finally {
      profilerBusy = false;
    }
  };

  const timer = setInterval(() => {
    const sample: EventLoopSample = {
      maxMs: histogram.max / NS_PER_MS,
      meanMs: histogram.mean / NS_PER_MS,
      p99Ms: histogram.percentile(99) / NS_PER_MS,
    };
    histogram.reset();
    void attribute(sample);
    if (!shouldWarn(sample, config.warnThresholdMs)) {
      return;
    }
    log.warn(formatEventLoopWarning(sample, config.sampleIntervalMs), {
      maxMs: Math.round(sample.maxMs),
      p99Ms: Math.round(sample.p99Ms),
      meanMs: Math.round(sample.meanMs * 10) / 10,
      windowMs: config.sampleIntervalMs,
    });
    // Best-effort span; no-op when OTel is disabled (the default).
    void startSpan("gateway.event_loop_delay", {
      "event_loop.max_ms": Math.round(sample.maxMs),
      "event_loop.p99_ms": Math.round(sample.p99Ms),
      "event_loop.mean_ms": Math.round(sample.meanMs * 10) / 10,
      "event_loop.window_ms": config.sampleIntervalMs,
    }).then((span) => span.end());
  }, config.sampleIntervalMs);
  // Never keep the process alive solely for the monitor.
  timer.unref?.();

  log.info(
    `event-loop delay monitor active sampleMs=${config.sampleIntervalMs} warnMs=${config.warnThresholdMs}` +
      (config.profileEnabled ? ` profileMs=${config.profileThresholdMs}` : " profile=off"),
  );

  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
      void disarmProfiler();
    },
  };
}
