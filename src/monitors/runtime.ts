import type { BitterbotConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { notifyOwner } from "../infra/owner-notify.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { MonitorEngine, type MonitorEvent } from "./engine.js";

const log = createSubsystemLogger("monitors");

let active: MonitorEngine | null = null;
let broadcast: ((payload: unknown) => void) | null = null;

export function getMonitorEngine(): MonitorEngine | null {
  return active;
}

export function setMonitorEngineForTests(engine: MonitorEngine | null): void {
  active = engine;
}

/** The gateway installs its broadcaster so the Control UI sees checks as they happen. */
export function setMonitorBroadcast(fn: ((payload: unknown) => void) | null): void {
  broadcast = fn;
}

/**
 * A monitor that fires tells the owner (which also puts the news in front of
 * the agent's main session) and wakes the agent to act on it. A monitor that
 * cannot be checked says so once, after a few tries.
 */
export function handleMonitorEvent(event: MonitorEvent): void {
  try {
    broadcast?.({ kind: event.kind, monitor: event.monitor });
  } catch {
    // Nobody watching.
  }
  const { monitor } = event;
  if (event.kind === "fired") {
    const note = monitor.note ? ` What you asked for when this happens: ${monitor.note}` : "";
    void notifyOwner({
      kind: "monitor-fired",
      dedupeKey: `monitor-fired:${monitor.id}:${monitor.health.lastValueHash ?? ""}`,
      text: `Monitor "${monitor.name}" ${event.summary}. ${monitor.url}${note}`,
    }).catch((err) => log.warn(`monitor notice failed: ${String(err)}`));
    // A `cron:` reason is one the heartbeat does not skip on an empty HEARTBEAT.md.
    requestHeartbeatNow({ reason: `cron:monitor:${monitor.id}` });
  } else if (event.kind === "failing") {
    void notifyOwner({
      kind: "monitor-failing",
      dedupeKey: `monitor-failing:${monitor.id}`,
      text:
        `Monitor "${monitor.name}" could not be checked ${monitor.health.consecutiveErrors} times in a row: ${event.error}. ` +
        "It keeps trying, less often. Fix or remove it from the Automations page.",
    }).catch((err) => log.warn(`monitor notice failed: ${String(err)}`));
  }
}

export async function startMonitorEngine(cfg: BitterbotConfig): Promise<MonitorEngine | null> {
  await stopMonitorEngine();
  if (cfg.monitors?.enabled === false || isTruthyEnvValue(process.env.BITTERBOT_SKIP_MONITORS)) {
    log.info("monitor engine skipped (disabled in config or BITTERBOT_SKIP_MONITORS=1)");
    return null;
  }
  const engine = new MonitorEngine({ onEvent: handleMonitorEvent });
  try {
    await engine.start();
  } catch (err) {
    log.warn(`monitor engine failed to start: ${String(err)}`);
    return null;
  }
  active = engine;
  return engine;
}

export async function stopMonitorEngine(): Promise<void> {
  const current = active;
  active = null;
  await current?.stop().catch(() => {});
}
