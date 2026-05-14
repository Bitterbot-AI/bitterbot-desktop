/**
 * Hormonal-state accessor for the long-horizon task concurrency gate.
 *
 * PLAN-16/17 follow-up: wires a real-time hormonal state into the
 * `active-task-tracker` so `acquireTaskSlot` reads live cortisol /
 * dopamine instead of the baseline. Refreshes asynchronously on a
 * configurable interval; the gate itself stays synchronous by reading
 * a cached snapshot, which is appropriate because hormonal half-lives
 * are 30-60 minutes — sub-minute staleness is harmless.
 *
 * Default refresh interval: 30 seconds. Override via
 * `BITTERBOT_TASKS_HORMONAL_REFRESH_MS`.
 *
 * Disable entirely with `BITTERBOT_TASKS_HORMONAL_GATE=0` — the gate
 * then falls back to the baseline policy (3 concurrent).
 */

import type { BitterbotConfig } from "../config/config.js";
import type { HormonalState } from "../memory/hormonal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerHormonalStateGetter } from "./active-task-tracker.js";

const log = createSubsystemLogger("tasks/hormonal-accessor");

const DEFAULT_REFRESH_MS = 30_000;

type AccessorState = {
  cached: HormonalState | null;
  timer: ReturnType<typeof setInterval> | null;
};

let state: AccessorState | null = null;

export function isHormonalGateEnabled(): boolean {
  return process.env.BITTERBOT_TASKS_HORMONAL_GATE !== "0";
}

function resolveRefreshMs(): number {
  const raw = process.env.BITTERBOT_TASKS_HORMONAL_REFRESH_MS;
  if (!raw) return DEFAULT_REFRESH_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_REFRESH_MS;
  return parsed;
}

export type HormonalAccessorOptions = {
  /** Test seam: skip the polling loop, just register a static getter. */
  staticState?: HormonalState | null;
  /** Test seam: override the refresh implementation. */
  refresh?: () => Promise<HormonalState | null>;
  /** Test seam: refresh cadence override. */
  refreshMs?: number;
};

/**
 * Start the hormonal-state accessor. Registers the active-task-tracker
 * getter so the concurrency gate reads live state on every call.
 * Subsequent calls are no-ops. Returns true when active.
 */
export function startHormonalAccessor(
  cfg: BitterbotConfig,
  opts: HormonalAccessorOptions = {},
): boolean {
  if (state) return true;
  if (!isHormonalGateEnabled()) {
    registerHormonalStateGetter(null);
    return false;
  }
  state = { cached: opts.staticState ?? null, timer: null };
  registerHormonalStateGetter(() => state?.cached ?? null);

  if (opts.staticState !== undefined) {
    return true;
  }

  const refresh = opts.refresh ?? (() => readDefaultAgentHormonalState(cfg));
  // Fire once immediately so the cache is populated on boot.
  void runRefresh(refresh);
  const interval = opts.refreshMs ?? resolveRefreshMs();
  const timer = setInterval(() => void runRefresh(refresh), interval);
  timer.unref?.();
  state.timer = timer;
  log.info(`hormonal accessor active refreshMs=${interval}`);
  return true;
}

export function stopHormonalAccessor(): void {
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  state = null;
  registerHormonalStateGetter(null);
}

/** Test helper: inspect the currently-cached snapshot. */
export function peekHormonalAccessorState(): HormonalState | null {
  return state?.cached ?? null;
}

async function runRefresh(refresh: () => Promise<HormonalState | null>): Promise<void> {
  if (!state) return;
  try {
    const next = await refresh();
    if (state) {
      state.cached = next;
    }
  } catch (err) {
    log.debug(
      `hormonal refresh failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readDefaultAgentHormonalState(cfg: BitterbotConfig): Promise<HormonalState | null> {
  try {
    const [{ MemoryIndexManager }, { resolveDefaultAgentId }] = await Promise.all([
      import("../memory/manager.js"),
      import("../agents/agent-scope.js"),
    ]);
    const agentId = resolveDefaultAgentId(cfg);
    const manager = await MemoryIndexManager.get({ cfg, agentId, purpose: "status" });
    if (!manager) return null;
    const snapshot = manager.hormonalState();
    if (!snapshot) return null;
    return {
      dopamine: snapshot.dopamine,
      cortisol: snapshot.cortisol,
      oxytocin: snapshot.oxytocin,
      // lastDecay is internal bookkeeping in HormonalStateManager; we
      // synthesize a value so this file's HormonalState shape is
      // satisfied without exposing the manager's private decay clock.
      lastDecay: Date.now(),
    };
  } catch (err) {
    log.debug(`could not read hormonal state: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
