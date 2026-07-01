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
 * On by default at gateway boot. Tunable / disengageable via env:
 *   BITTERBOT_EVENT_LOOP_MONITOR=0        disable entirely
 *   BITTERBOT_EVENT_LOOP_SAMPLE_MS=30000  sampling window (ms)
 *   BITTERBOT_EVENT_LOOP_WARN_MS=250      warn when a window's max delay >= this
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { startSpan } from "../observability/otel.js";

const log = createSubsystemLogger("gateway/event-loop");

const NS_PER_MS = 1e6;
const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_WARN_THRESHOLD_MS = 250;
/** libuv histogram resolution; the loop is probed every this-many ms. */
const HISTOGRAM_RESOLUTION_MS = 20;

export type EventLoopSample = { maxMs: number; meanMs: number; p99Ms: number };

export type EventLoopMonitorConfig = {
  enabled: boolean;
  sampleIntervalMs: number;
  warnThresholdMs: number;
};

export type EventLoopMonitorHandle = { stop: () => void };

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
export function startEventLoopMonitor(
  overrides?: Partial<EventLoopMonitorConfig>,
): EventLoopMonitorHandle {
  const config = resolveEventLoopMonitorConfig(process.env, overrides);
  if (!config.enabled) {
    log.debug("event-loop delay monitor disabled via config");
    return { stop: () => {} };
  }

  const histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  histogram.enable();

  const timer = setInterval(() => {
    const sample: EventLoopSample = {
      maxMs: histogram.max / NS_PER_MS,
      meanMs: histogram.mean / NS_PER_MS,
      p99Ms: histogram.percentile(99) / NS_PER_MS,
    };
    histogram.reset();
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
    `event-loop delay monitor active sampleMs=${config.sampleIntervalMs} warnMs=${config.warnThresholdMs}`,
  );

  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
