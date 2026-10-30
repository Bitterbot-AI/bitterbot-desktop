/**
 * Pure decision logic for the WSL gateway supervisor (`bitterbot gateway
 * supervise`). No I/O here: the runtime in src/cli/gateway-cli/supervise.ts
 * feeds observations in and acts on the decisions, so the policy is testable
 * as a table.
 *
 * Relaunch policy:
 * - any non-zero exit or a signal: relaunch after a backoff that starts at
 *   5 s, doubles per consecutive failure and caps at 60 s; a run that stayed
 *   up for 10 minutes resets the failure count;
 * - exit code 0 is an intentional stop or a SIGUSR1 full-process restart
 *   (run-loop.ts: the parent spawns the new gateway detached, releases the
 *   lock and exits 0 while the child keeps running). The supervisor does not
 *   relaunch on exit 0; it waits a grace period and probes. A gateway holding
 *   the lock or answering on the port means the handoff worked and the
 *   supervisor adopts it (polls, takes over when it exits). Nothing running
 *   after the grace means a stop nobody asked the supervisor for; it
 *   relaunches once and logs why. A second exit 0 with no takeover before the
 *   healthy-uptime reset means something keeps stopping the gateway on
 *   purpose, so the supervisor stops relaunching and exits.
 */

export const SUPERVISOR_BACKOFF_BASE_MS = 5_000;
export const SUPERVISOR_BACKOFF_CAP_MS = 60_000;
export const SUPERVISOR_HEALTHY_UPTIME_MS = 10 * 60_000;
export const SUPERVISOR_EXIT0_GRACE_MS = 20_000;
export const SUPERVISOR_ADOPTION_POLL_MS = 5_000;
export const SUPERVISOR_LOG_KEEP = 14;
export const SUPERVISOR_LOG_PREFIX = "gateway-";

export type SupervisorExitObservation = {
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
};

export type SupervisorState = {
  /** Failures since the last healthy run (drives the backoff). */
  consecutiveFailures: number;
  /** The last relaunch was the one-shot grace relaunch after an exit 0. */
  graceRelaunchUsed: boolean;
  /** SIGTERM/SIGINT reached the supervisor: never relaunch. */
  stopping: boolean;
};

export type SupervisorDecision =
  | { action: "relaunch"; delayMs: number; reason: string; state: SupervisorState }
  | { action: "probe-handoff"; graceMs: number; reason: string; state: SupervisorState }
  | { action: "stop"; reason: string; state: SupervisorState };

export type HandoffProbe = {
  /** A live gateway holds the gateway lock for this config. */
  lockHeld: boolean;
  /** Something answers on the configured gateway port. */
  portOpen: boolean;
};

export type HandoffDecision =
  | { action: "wait-external"; reason: string; state: SupervisorState }
  | { action: "relaunch"; delayMs: number; reason: string; state: SupervisorState }
  | { action: "stop"; reason: string; state: SupervisorState };

export function initialSupervisorState(): SupervisorState {
  return { consecutiveFailures: 0, graceRelaunchUsed: false, stopping: false };
}

/** 5 s, 10 s, 20 s, 40 s, 60 s, 60 s, ... for failure number 1, 2, 3, ... */
export function computeBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const raw = SUPERVISOR_BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(SUPERVISOR_BACKOFF_CAP_MS, raw);
}

export function describeExit(exit: Pick<SupervisorExitObservation, "exitCode" | "signal">): string {
  if (exit.signal) {
    return `signal ${exit.signal}`;
  }
  if (exit.exitCode === null || exit.exitCode === undefined) {
    return "exit unknown";
  }
  return `exit ${exit.exitCode}`;
}

/** What to do when the supervised child exits. */
export function decideAfterExit(
  exit: SupervisorExitObservation,
  state: SupervisorState,
): SupervisorDecision {
  const healthy = exit.uptimeMs >= SUPERVISOR_HEALTHY_UPTIME_MS;
  const base: SupervisorState = {
    ...state,
    consecutiveFailures: healthy ? 0 : state.consecutiveFailures,
    graceRelaunchUsed: healthy ? false : state.graceRelaunchUsed,
  };
  if (state.stopping) {
    return {
      action: "stop",
      reason: `supervisor stopping; gateway ${describeExit(exit)}`,
      state: base,
    };
  }
  const crashed = exit.signal !== null || exit.exitCode !== 0;
  if (crashed) {
    const failures = base.consecutiveFailures + 1;
    const delayMs = computeBackoffMs(failures);
    return {
      action: "relaunch",
      delayMs,
      reason: `${describeExit(exit)} after ${formatUptime(exit.uptimeMs)}; relaunch in ${Math.round(delayMs / 1000)}s (failure ${failures})`,
      state: { ...base, consecutiveFailures: failures },
    };
  }
  return {
    action: "probe-handoff",
    graceMs: SUPERVISOR_EXIT0_GRACE_MS,
    reason: `exit 0 after ${formatUptime(exit.uptimeMs)}; checking for a restart handoff in ${Math.round(SUPERVISOR_EXIT0_GRACE_MS / 1000)}s`,
    state: base,
  };
}

/** What to do once the exit-0 grace period has passed. */
export function decideAfterHandoffGrace(
  probe: HandoffProbe,
  state: SupervisorState,
): HandoffDecision {
  if (state.stopping) {
    return { action: "stop", reason: "supervisor stopping", state };
  }
  if (probe.lockHeld || probe.portOpen) {
    return {
      action: "wait-external",
      reason: probe.lockHeld
        ? "restart handoff: a new gateway holds the lock; waiting on it"
        : "a gateway answers on the port; waiting on it",
      state,
    };
  }
  if (state.graceRelaunchUsed) {
    return {
      action: "stop",
      reason:
        "exit 0 again with no gateway holding the lock and the port closed; the gateway is being stopped on purpose, not relaunching",
      state,
    };
  }
  return {
    action: "relaunch",
    delayMs: 0,
    reason:
      "exit 0 but no gateway holds the lock and the port is closed after the grace period; relaunching once",
    state: { ...state, graceRelaunchUsed: true },
  };
}

/**
 * In adoption mode (an externally started gateway, or a restart-handoff
 * child) the supervisor polls instead of owning a child process. Once nothing
 * holds the lock and the port is closed, it takes over.
 */
export function decideAdoptionPoll(
  probe: HandoffProbe,
  state: SupervisorState,
): { action: "keep-waiting" } | { action: "take-over"; reason: string; state: SupervisorState } {
  if (probe.lockHeld || probe.portOpen) {
    return { action: "keep-waiting" };
  }
  return {
    action: "take-over",
    reason: "the externally started gateway exited (lock released, port closed); taking over",
    state: { ...state, graceRelaunchUsed: false },
  };
}

export function formatUptime(uptimeMs: number): string {
  const seconds = Math.max(0, Math.round(uptimeMs / 1000));
  return `${seconds}s`;
}

/** One line per child exit: ISO time, pid, exit code or signal, uptime, decision. */
export function formatExitLogLine(params: {
  time: Date;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
  decision: string;
}): string {
  const exit = params.signal ? `signal=${params.signal}` : `exit=${params.exitCode ?? "unknown"}`;
  return `${params.time.toISOString()} pid=${params.pid ?? "unknown"} ${exit} uptime=${formatUptime(params.uptimeMs)} decision=${params.decision}`;
}

/** gateway-YYYYMMDD.log (local calendar day). */
export function supervisorLogFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${SUPERVISOR_LOG_PREFIX}${y}${m}${d}.log`;
}

const DAILY_LOG_RE = /^gateway-(\d{8})\.log$/;

/** Daily gateway logs beyond the newest `keep`, oldest first. */
export function selectLogFilesToPrune(
  fileNames: string[],
  keep: number = SUPERVISOR_LOG_KEEP,
): string[] {
  const dated = fileNames
    .map((name) => ({ name, match: DAILY_LOG_RE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .toSorted((a, b) => (a.match[1] < b.match[1] ? -1 : a.match[1] > b.match[1] ? 1 : 0));
  if (dated.length <= keep) {
    return [];
  }
  return dated.slice(0, dated.length - keep).map((entry) => entry.name);
}

export type SupervisorLockPayload = { pid: number; createdAt: string };

export function parseSupervisorLockPayload(raw: string): SupervisorLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SupervisorLockPayload>;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * A supervisor lock is stale when its payload is unreadable or names a pid
 * that is not alive (or is this very process, after a pid reuse).
 */
export function isSupervisorLockStale(params: {
  payload: SupervisorLockPayload | null;
  isPidAlive: (pid: number) => boolean;
  selfPid: number;
}): boolean {
  if (!params.payload) {
    return true;
  }
  if (params.payload.pid === params.selfPid) {
    return true;
  }
  return !params.isPidAlive(params.payload.pid);
}

/** The gateway port the recorded program arguments name, or null. */
export function parsePortFromProgramArguments(
  programArguments: string[] | undefined,
): number | null {
  if (!programArguments?.length) {
    return null;
  }
  for (let i = 0; i < programArguments.length; i += 1) {
    const arg = programArguments[i];
    let raw: string | undefined;
    if (arg === "--port") {
      raw = programArguments[i + 1];
    } else if (arg?.startsWith("--port=")) {
      raw = arg.slice("--port=".length);
    }
    if (raw === undefined) {
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65_535) {
      return parsed;
    }
  }
  return null;
}

export const DEFAULT_SUPERVISED_GATEWAY_PORT = 19001;

/** The gateway port: `--port` in the recorded arguments, else BITTERBOT_GATEWAY_PORT, else 19001. */
export function resolveSupervisedPort(
  programArguments: string[] | undefined,
  envPort: string | undefined,
): number {
  const fromArgs = parsePortFromProgramArguments(programArguments);
  if (fromArgs !== null) {
    return fromArgs;
  }
  const fromEnv = Number.parseInt(envPort ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SUPERVISED_GATEWAY_PORT;
}

/** The program that runs `gateway supervise`: everything before `gateway`. */
export function resolveLauncherFromProgramArguments(programArguments: string[]): string[] {
  const idx = programArguments.indexOf("gateway");
  if (idx > 0) {
    return programArguments.slice(0, idx);
  }
  return programArguments.length > 0 ? [programArguments[0]] : [];
}
