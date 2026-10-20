import { createSubsystemLogger } from "../logging/subsystem.js";
import { evaluate, extractValue } from "./extract.js";
import {
  buildMonitor,
  defaultMonitorsPath,
  loadMonitors,
  patchMonitor,
  saveMonitors,
} from "./store.js";
import { MONITOR_MAX_COUNT, type Monitor } from "./types.js";

const log = createSubsystemLogger("monitors");

/** A response larger than this is not a value worth watching. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** After this many failed checks in a row the owner is told once. */
export const MONITOR_ERRORS_BEFORE_NOTICE = 3;
/** A monitor that cannot be checked is tried less often, up to this multiple. */
const MAX_ERROR_SLOWDOWN = 8;

export type MonitorEvent =
  | { kind: "fired"; monitor: Monitor; summary: string }
  | { kind: "failing"; monitor: Monitor; error: string }
  | { kind: "checked"; monitor: Monitor };

export type MonitorEngineOptions = {
  storePath?: string;
  nowMs?: () => number;
  /** Fetch the body of a URL. The default goes through the SSRF guard. */
  fetchBody?: (url: string) => Promise<string>;
  onEvent?: (event: MonitorEvent) => void;
  /** How often to look for monitors that are due. */
  tickMs?: number;
  maxConcurrent?: number;
};

async function guardedFetchBody(url: string): Promise<string> {
  const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
  const { response, release } = await fetchWithSsrFGuard({
    url,
    maxRedirects: 5,
    timeoutMs: 20_000,
    init: {
      headers: {
        Accept: "application/json, text/html;q=0.9, */*;q=0.5",
        "User-Agent": "Bitterbot-Monitor/1.0",
      },
    },
  });
  try {
    if (!response.ok) {
      throw new Error(`the server answered ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      throw new Error("the response is too large to watch");
    }
    const body = await response.text();
    return body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;
  } finally {
    await release().catch(() => {});
  }
}

export class MonitorEngine {
  private monitors: Monitor[] = [];
  private readonly storePath: string;
  private readonly nowMs: () => number;
  private readonly fetchBody: (url: string) => Promise<string>;
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MonitorEngineOptions = {}) {
    this.storePath = opts.storePath ?? defaultMonitorsPath();
    this.nowMs = opts.nowMs ?? Date.now;
    this.fetchBody = opts.fetchBody ?? guardedFetchBody;
  }

  async start(): Promise<void> {
    this.monitors = await loadMonitors(this.storePath);
    const tickMs = this.opts.tickMs ?? 15_000;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    log.info(`monitor engine started with ${this.monitors.length} monitor(s)`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.saving.catch(() => {});
  }

  list(): Monitor[] {
    return this.monitors.map((m) => ({ ...m, health: { ...m.health } }));
  }

  get(id: string): Monitor | undefined {
    return this.list().find((m) => m.id === id);
  }

  async add(params: Record<string, unknown>): Promise<Monitor> {
    if (this.monitors.length >= MONITOR_MAX_COUNT) {
      throw new Error(`there are already ${MONITOR_MAX_COUNT} monitors; remove one first`);
    }
    const monitor = buildMonitor(params, this.nowMs());
    this.monitors.push(monitor);
    await this.save();
    return { ...monitor };
  }

  async update(id: string, patch: Record<string, unknown>): Promise<Monitor> {
    const index = this.monitors.findIndex((m) => m.id === id);
    if (index < 0) {
      throw new Error(`no monitor with id ${id}`);
    }
    this.monitors[index] = patchMonitor(this.monitors[index], patch, this.nowMs());
    await this.save();
    return { ...this.monitors[index] };
  }

  async remove(id: string): Promise<boolean> {
    const before = this.monitors.length;
    this.monitors = this.monitors.filter((m) => m.id !== id);
    if (this.monitors.length === before) {
      return false;
    }
    await this.save();
    return true;
  }

  /** When a monitor is next due. Failing monitors are checked less often. */
  nextCheckAt(monitor: Monitor): number {
    const last = monitor.health.lastCheckAt;
    if (last === undefined) {
      return 0;
    }
    const slowdown = Math.min(2 ** monitor.health.consecutiveErrors, MAX_ERROR_SLOWDOWN);
    return last + monitor.intervalMs * slowdown;
  }

  async tick(): Promise<void> {
    const now = this.nowMs();
    const limit = this.opts.maxConcurrent ?? 2;
    const due = this.monitors
      .filter((m) => m.enabled && !this.inFlight.has(m.id) && this.nextCheckAt(m) <= now)
      .toSorted((a, b) => this.nextCheckAt(a) - this.nextCheckAt(b))
      .slice(0, Math.max(0, limit - this.inFlight.size));
    await Promise.all(due.map((m) => this.check(m.id)));
  }

  /** Check one monitor now, whether or not it is due. */
  async check(id: string): Promise<Monitor> {
    const monitor = this.monitors.find((m) => m.id === id);
    if (!monitor) {
      throw new Error(`no monitor with id ${id}`);
    }
    if (this.inFlight.has(id)) {
      return { ...monitor };
    }
    this.inFlight.add(id);
    const now = this.nowMs();
    try {
      const value = extractValue(await this.fetchBody(monitor.url), monitor.extract);
      const result = evaluate(monitor.condition, monitor.health, value);
      monitor.health = {
        ...monitor.health,
        ...result.health,
        lastCheckAt: now,
        lastOkAt: now,
        lastError: undefined,
        consecutiveErrors: 0,
        ...(result.changed ? { lastChangeAt: now } : {}),
        ...(result.fired ? { lastFiredAt: now } : {}),
      };
      if (result.fired && result.summary) {
        this.emit({ kind: "fired", monitor: { ...monitor }, summary: result.summary });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      monitor.health = {
        ...monitor.health,
        lastCheckAt: now,
        lastError: error.slice(0, 300),
        consecutiveErrors: monitor.health.consecutiveErrors + 1,
      };
      if (monitor.health.consecutiveErrors === MONITOR_ERRORS_BEFORE_NOTICE) {
        this.emit({ kind: "failing", monitor: { ...monitor }, error });
      }
    } finally {
      this.inFlight.delete(id);
    }
    this.emit({ kind: "checked", monitor: { ...monitor } });
    await this.save();
    return { ...monitor, health: { ...monitor.health } };
  }

  private emit(event: MonitorEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch (err) {
      log.warn(`monitor event handler failed: ${String(err)}`);
    }
  }

  private save(): Promise<void> {
    const snapshot = this.monitors.map((m) => ({ ...m }));
    this.saving = this.saving
      .catch(() => {})
      .then(() => saveMonitors(this.storePath, snapshot))
      .catch((err) => log.warn(`could not save monitors: ${String(err)}`));
    return this.saving;
  }
}
