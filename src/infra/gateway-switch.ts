/**
 * Switch the running gateway (and its background service) to THIS install.
 *
 * Installing a new Bitterbot next to an existing one (a git clone built with
 * pnpm, an older release tarball, a package install) leaves the old gateway
 * serving the port until something restarts it, and leaves the background
 * service pointing at the old code. `bitterbot gateway switch` (and
 * install.sh / install.ps1 / `bitterbot onboard` / the setup page, which all
 * call this module) finds what runs today, decides whether it is this
 * install, and hands over:
 *
 *   0. snapshot the data an update could damage (the updater's snapshot:
 *      config, .env, memory databases, GENOME/MEMORY, keys; copies only);
 *   1. stop the old gateway: through its service manager when the service
 *      runs it, otherwise a graceful SIGTERM to that pid, but ONLY when the
 *      process is verifiably a Bitterbot gateway (and still the same process:
 *      its start time is compared); then wait for the port to free and for
 *      its children (the P2P orchestrator) to exit;
 *   2. copy the keys of a git clone's `.env` that the state directory's
 *      `.env` lacks (the old gateway loaded them from its working directory);
 *   3. point the background service at this install (the same plan as
 *      `bitterbot gateway install --force`, carrying the old service's
 *      environment) or install one where a service manager exists; only
 *      without one, start this install's gateway in the background;
 *   4. wait until this version answers on the port and stays up, for as long
 *      as it is alive and starting (a first start can migrate memory);
 *   5. on failure, roll back: stop the new gateway and its children, restore
 *      the snapshot's databases the new version migrated past what the old
 *      one knew, put the old service definition file back byte for byte (and
 *      `current` for a tarball-to-tarball switch), restart the old process the
 *      way it was started once it has really exited, and say exactly what to
 *      run when that is not possible.
 *
 * Every side effect goes through `GatewaySwitchDeps`, so the decision and
 * rollback logic is unit-tested without touching real processes, services or
 * ports (src/infra/gateway-switch.test.ts). The real implementations live in
 * src/infra/gateway-switch-system.ts.
 */

import path from "node:path";
import type { InstallKind } from "./install-kind.js";

/** An install, located by its package root (a realpath). */
export type InstallRef = {
  root: string | null;
  kind: InstallKind;
  version: string | null;
};

/** A background service definition, as the service readers return it. */
export type ServiceDefinition = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
};

/** The service definition file as it is on disk, for a byte-for-byte restore. */
export type RawServiceDefinition = { path: string; content: string };

export type ServiceFindings = {
  /** Human name of the service manager ("systemd user service"). */
  label: string;
  definition: ServiceDefinition | null;
  /** The definition file's exact content (unit, plist, task script). */
  raw: RawServiceDefinition | null;
  /** systemd `EnvironmentFile=` values of the old unit (kept on the new one). */
  environmentFiles: string[];
  /** The install the definition runs (null when it cannot be resolved). */
  runsFrom: InstallRef | null;
  /** The definition starts `<app>/current/bin/bitterbot` (follows tarball upgrades). */
  followsCurrent: boolean;
  /** The definition runs this install. */
  pointsHere: boolean;
  running: boolean;
  pid?: number;
};

export type ListenerFindings = {
  pid: number | null;
  /** Process start time at detection (pid reuse guard); null when unknown. */
  startTime?: string | null;
  /** The command line (or process title) of the listening process. */
  command: string | null;
  /** Verified to be a Bitterbot gateway (never act on anything else). */
  isGateway: boolean;
  runsFrom: InstallRef | null;
  /** The version the gateway itself reports (1.5+), when it answered. */
  reportedVersion: string | null;
  /** This install serves the port already. */
  isSelf: boolean;
  /** The background service started this process (its pid is an ancestor). */
  underService: boolean;
  /** The node (or launcher) executable, for restarting it on rollback. */
  exePath: string | null;
  /** Child processes (the P2P orchestrator) that must exit with it. */
  childPids: number[];
};

/** Which config/state a gateway uses. */
export type GatewayTarget = {
  stateDir: string;
  configPath: string | null;
  profile: string | null;
  port: number;
};

/** A git clone's `.env` keys the state directory's `.env` lacks. */
export type EnvMigration = {
  source: string;
  target: string;
  keys: string[];
  /** Keys whose values cannot be written safely; copy them by hand. */
  skipped: string[];
};

export type GatewaySwitchFindings = {
  port: number;
  self: InstallRef;
  service: ServiceFindings | null;
  listener: ListenerFindings | null;
  /** gateway.mode is "remote": the gateway is on another machine. */
  remoteMode: boolean;
  /** A service manager exists here (systemd user, launchd, Task Scheduler). */
  serviceManager?: boolean;
  /**
   * Extra `gateway` arguments for a gateway started in the background here
   * (`--allow-unconfigured` when the config does not set gateway.mode yet).
   */
  extraGatewayArgs?: string[];
  /** What this switch targets (this command's state dir, profile and port). */
  target?: GatewayTarget;
  /** What the old gateway or service targets (from its environment). */
  oldTarget?: GatewayTarget | null;
  /** Environment of the old service carried to the new one. */
  carriedEnv?: Record<string, string>;
  envMigration?: EnvMigration | null;
  /** Variables the old process had that come from neither `.env` (names only). */
  processOnlyEnv?: string[];
};

export type GatewaySwitchDecision =
  | {
      action: "none";
      reason: "fresh" | "already-current" | "remote-mode" | "service-stopped";
      /** Something worth saying anyway (a stopped service left alone). */
      note?: string;
    }
  | {
      action: "blocked";
      reason:
        | "container"
        | "foreign-listener"
        | "unidentified-listener"
        | "cannot-restore"
        | "target-mismatch";
      message: string;
    }
  | {
      action: "switch";
      /** The install being replaced (the running one, else the service's). */
      from: InstallRef | null;
      stopService: boolean;
      /** A verified gateway pid to SIGTERM when the service stop did not stop it. */
      stopPid: number | null;
      /** Point the background service at this install (reinstall, or a new one). */
      installService: boolean;
      /** No service was installed before: a rollback uninstalls the new one. */
      freshService: boolean;
      /** No service manager: start this install's gateway in the background. */
      startDetached: boolean;
    };

/** How to bring the old gateway back when the new one does not come up. */
export type RestorePlan = {
  /** The old definition file, restored byte for byte. */
  rawDefinition: RawServiceDefinition | null;
  /** Reinstall this service definition when the raw file is unavailable. */
  serviceDefinition: ServiceDefinition | null;
  /** The old service was running (restart it after the restore). */
  serviceWasRunning: boolean;
  /** Restart the old foreground gateway with this command. */
  restartCommand: { argv: string[]; cwd?: string } | null;
  /** For a tarball-to-tarball switch: point `<appDir>/current` back at `version`. */
  currentLink: { appDir: string; version: string } | null;
  /** Human instructions when nothing can be restored automatically. */
  manual: string | null;
};

export type GatewaySwitchStep =
  | "snapshot"
  | "stop-service"
  | "stop-process"
  | "wait-stopped"
  | "stop-children"
  | "copy-env"
  | "install-service"
  | "start-gateway"
  | "wait-healthy"
  | "rollback";

export type GatewaySwitchOutcome = {
  ok: boolean;
  status: "switched" | "nothing-to-do" | "blocked" | "rolled-back" | "failed";
  findings: GatewaySwitchFindings;
  decision: GatewaySwitchDecision;
  steps: Array<{ step: GatewaySwitchStep; ok: boolean; detail?: string }>;
  error?: string;
  /** Keys copied into the state directory's `.env` (names only). */
  envCopied?: string[];
  snapshotDir?: string | null;
  rollback?: {
    ok: boolean;
    restored: "service" | "process" | "nothing";
    manual: string | null;
    /** Files the snapshot restore put back. */
    dataRestored?: string[];
  };
};

export type DetachedStart = { pid?: number; logPath: string };

/** Who serves the port now. `rpc` is "auth" when the status RPC refused our credentials. */
export type GatewayProbe = {
  pid: number | null;
  version: string | null;
  root: string | null;
  rpc?: "ok" | "auth" | "error";
};

export type GatewaySwitchDeps = {
  /** Stop the background service (its manager stops the gateway). */
  stopService: () => Promise<void>;
  /** Install (and start) the service with this definition. */
  installService: (definition: ServiceDefinition) => Promise<void>;
  /** Remove a service this switch installed (rollback of a fresh install). */
  uninstallService: () => Promise<void>;
  /** Write the old definition file back exactly, reload, and start it when asked. */
  restoreRawDefinition: (raw: RawServiceDefinition, opts: { start: boolean }) => Promise<void>;
  /** Is the service's gateway process up (systemd ActiveState, launchd pid)? */
  serviceRunning: () => Promise<boolean>;
  /** The service definition for THIS install (buildGatewayInstallPlan). */
  buildServiceDefinition: () => Promise<ServiceDefinition>;
  /** Start a gateway in the background, unsupervised. */
  startDetached: (cmd: { argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) => DetachedStart;
  /** The process command line now (re-checked right before signalling). */
  readCommandLine: (pid: number) => Promise<string | null>;
  /** The process start time (pid reuse guard), null when unknown. */
  readStartTime: (pid: number) => Promise<string | null>;
  listChildren: (pid: number) => Promise<number[]>;
  isPidAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  isPortListening: (port: number) => Promise<boolean>;
  probeGateway: (port: number) => Promise<GatewayProbe>;
  /** Point `<appDir>/current` at `version`. */
  swapCurrentLink: (appDir: string, version: string) => void;
  /** Snapshot config/.env/databases/keys before anything changes. */
  snapshot: () => Promise<{ dir: string } | null>;
  /** Restore what the new version changed (auto policy; never `.env`). */
  restoreSnapshot: (snapshot: { dir: string }) => Promise<string[]>;
  /** Copy the missing `.env` keys (backup first; never overwrite). */
  copyEnv: (migration: EnvMigration) => Promise<{ copied: string[]; backup: string | null }>;
  /** Interactive only: keep waiting for a gateway that is alive but still starting? */
  askKeepWaiting?: (elapsedMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type GatewaySwitchTimeouts = {
  stopMs: number;
  childrenMs: number;
  /** Wait this long, then ask (interactive) or keep going while alive up to maxHealthyMs. */
  healthyMs: number;
  maxHealthyMs: number;
  /** The new gateway must stay up (same pid) this long after it answers. */
  stableMs: number;
  /** A gateway started here that exits: give up after this grace. */
  exitedGraceMs: number;
  restoreMs: number;
  progressMs: number;
  pollMs: number;
};

export const DEFAULT_SWITCH_TIMEOUTS: GatewaySwitchTimeouts = {
  stopMs: 45_000,
  childrenMs: 15_000,
  // The new version may migrate memory databases on its first start.
  healthyMs: 300_000,
  maxHealthyMs: 20 * 60_000,
  stableMs: 5_000,
  exitedGraceMs: 15_000,
  // CI's healthy() waits 240 s; a restore must not give up sooner.
  restoreMs: 240_000,
  progressMs: 30_000,
  pollMs: 500,
};

/** A new gateway seen dying this many times while it starts is crash-looping. */
const CRASH_LOOP_DEATHS = 3;

const GATEWAY_ENTRY_RE =
  /(?:^|[/\\])(?:dist[/\\](?:entry|index)\.(?:m?js)|bitterbot\.mjs|scripts[/\\]run-node\.mjs|src[/\\](?:entry|index)\.ts|bin[/\\]bitterbot)$/i;

/**
 * True when a command line (or process title) is a Bitterbot gateway: the
 * gateway renames itself `bitterbot-gateway`; on Windows (and before the
 * rename) the command line names a Bitterbot entry and the `gateway` command.
 * `knownBitterbotRoot` is set when the process's install root resolved to a
 * Bitterbot package, so a clone in a directory not called "bitterbot" counts.
 */
export function isBitterbotGatewayCommand(
  command: string | null | undefined,
  knownBitterbotRoot = false,
): boolean {
  if (!command) {
    return false;
  }
  const raw = command.trim().toLowerCase();
  if (!raw || raw.includes("bitterbot-orchestrator")) {
    return false;
  }
  if (/(^|[/\\\s])bitterbot-gateway(\s|$)/.test(raw)) {
    return true;
  }
  const tokens = raw.split(/\s+/);
  const hasGatewayCommand = tokens.includes("gateway");
  if (!hasGatewayCommand) {
    return false;
  }
  if (raw.includes("bitterbot")) {
    return true;
  }
  return knownBitterbotRoot && tokens.some((t) => GATEWAY_ENTRY_RE.test(t.replace(/^"|"$/g, "")));
}

/** True when an argument is a Bitterbot entry point or launcher path. */
export function isBitterbotEntryArg(arg: string): boolean {
  return GATEWAY_ENTRY_RE.test(arg.replace(/^"|"$/g, ""));
}

/** Human name of the service manager for this platform. */
export function serviceLabelFor(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS LaunchAgent";
    case "linux":
      return "systemd user service";
    case "win32":
      return "Windows scheduled task";
    default:
      return "background service";
  }
}

/** The definition starts the stable tarball launcher `<app>/current/bin/bitterbot`. */
export function definitionFollowsCurrent(definition: ServiceDefinition | null): boolean {
  const first = definition?.programArguments[0];
  if (!first) {
    return false;
  }
  return /[/\\]current[/\\]bin[/\\]bitterbot$/.test(first);
}

/** The `--port` a definition passes (or its BITTERBOT_GATEWAY_PORT), if any. */
export function definitionPort(definition: ServiceDefinition | null): number | null {
  const args = definition?.programArguments ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = arg === "--port" ? args[i + 1] : arg?.startsWith("--port=") ? arg.slice(7) : null;
    if (value) {
      const port = Number.parseInt(value, 10);
      if (Number.isFinite(port) && port > 0) {
        return port;
      }
    }
  }
  const envPort = Number.parseInt(definition?.environment?.BITTERBOT_GATEWAY_PORT ?? "", 10);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : null;
}

export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return path.resolve(a) === path.resolve(b);
}

/** The version directory layout of a tarball root (`<appDir>/<X.Y.Z>`). */
export function tarballVersionDir(
  ref: InstallRef | null,
): { appDir: string; version: string } | null {
  if (!ref?.root || ref.kind !== "tarball") {
    return null;
  }
  const version = path.basename(ref.root);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return null;
  }
  return { appDir: path.dirname(ref.root), version };
}

/** Why the old gateway's target differs from this switch's, or null when it matches. */
export function targetMismatch(
  target: GatewayTarget | undefined,
  old: GatewayTarget | null | undefined,
): string | null {
  if (!target || !old) {
    return null;
  }
  const diffs: string[] = [];
  if (!sameRoot(target.stateDir, old.stateDir)) {
    diffs.push(`state directory ${old.stateDir} (this command uses ${target.stateDir})`);
  }
  if (old.configPath !== null && !sameRoot(old.configPath, target.configPath)) {
    diffs.push(
      `config ${old.configPath} (this command uses ${target.configPath ?? "the default"})`,
    );
  }
  if (old.profile !== target.profile) {
    diffs.push(
      `profile ${old.profile ?? "default"} (this command uses ${target.profile ?? "default"})`,
    );
  }
  if (old.port !== target.port) {
    diffs.push(`port ${old.port} (this command uses ${target.port})`);
  }
  return diffs.length > 0 ? diffs.join("; ") : null;
}

/** Decide what to do from what was found. Pure. */
export function decideGatewaySwitch(findings: GatewaySwitchFindings): GatewaySwitchDecision {
  const { self, service, listener, port } = findings;
  if (findings.remoteMode) {
    return { action: "none", reason: "remote-mode" };
  }
  if (self.kind === "container") {
    return {
      action: "blocked",
      reason: "container",
      message:
        "This is the container image. Update it with: docker compose pull && docker compose up -d",
    };
  }
  if (listener && !listener.isGateway) {
    return {
      action: "blocked",
      reason: "foreign-listener",
      message: `Port ${port} is used by another program${listener.pid ? ` (pid ${listener.pid}${listener.command ? `, ${listener.command}` : ""})` : ""}, not a Bitterbot gateway. It was left alone. Free the port, or set another one with gateway.port in the config.`,
    };
  }
  const listenerOld = Boolean(listener && listener.isGateway && !listener.isSelf);
  const serviceElsewhere = Boolean(service && !service.pointsHere);
  const listenerRunsService = Boolean(listener?.underService);
  // A stopped service the user stopped on purpose stays stopped: never start it.
  if (serviceElsewhere && service && !service.running && !listenerRunsService && !listenerOld) {
    return {
      action: "none",
      reason: "service-stopped",
      note: `The background service (${service.label}) is stopped and still set to run another install. It was left alone. To use this version for it: bitterbot gateway install --force`,
    };
  }
  if (!listenerOld && !serviceElsewhere) {
    return { action: "none", reason: listener || service ? "already-current" : "fresh" };
  }
  const mismatch = targetMismatch(findings.target, findings.oldTarget);
  if (mismatch) {
    return {
      action: "blocked",
      reason: "target-mismatch",
      message: `The running Bitterbot uses ${mismatch}. Switching would point it at different settings, so nothing was changed. Run the switch with the same settings (for example BITTERBOT_STATE_DIR, BITTERBOT_PROFILE or --port), or switch it by hand.`,
    };
  }
  if (listenerOld && listener && listener.pid === null) {
    return {
      action: "blocked",
      reason: "unidentified-listener",
      message: `A Bitterbot gateway is running on port ${port}, but its process could not be identified (run as the same user, or install lsof). Stop it yourself, then run: bitterbot gateway switch`,
    };
  }
  // The service is re-installed, so its old definition must be readable to
  // be restored if the switch fails.
  if (service && !service.definition && !service.raw) {
    return {
      action: "blocked",
      reason: "cannot-restore",
      message: `The background service (${service.label}) could not be read, so it could not be put back if the switch failed. To point it at this version anyway: bitterbot gateway install --force`,
    };
  }
  // A foreground gateway (no service runs it) must be restartable before we
  // stop it, or a failed switch would leave nothing running.
  if (listener && listener.isGateway && !listener.underService && !restartCommandFor(findings)) {
    return {
      action: "blocked",
      reason: "cannot-restore",
      message: `A Bitterbot gateway is running on port ${port} (pid ${listener.pid}), but where it was started from could not be determined, so it could not be restarted if the switch failed. Stop it yourself (Ctrl+C in its terminal, or: kill ${listener.pid}), then run: bitterbot gateway switch`,
    };
  }
  const from = listenerOld ? (listener?.runsFrom ?? null) : (service?.runsFrom ?? null);
  const canInstall = Boolean(service) || findings.serviceManager === true;
  // This install's own foreground gateway is stopped too when the service is
  // taken over, so the service's gateway (not the foreground one) serves.
  const foregroundPid =
    listener && listener.isGateway && !listener.underService ? listener.pid : null;
  return {
    action: "switch",
    from,
    stopService: Boolean(service && (service.running || listenerRunsService)),
    stopPid: listenerOld ? (listener?.pid ?? null) : canInstall ? foregroundPid : null,
    installService: canInstall,
    freshService: !service && canInstall,
    startDetached: !canInstall && listenerOld,
  };
}

/** The command that restarts the old foreground gateway, or null. */
export function restartCommandFor(
  findings: GatewaySwitchFindings,
): { argv: string[]; cwd?: string } | null {
  const listener = findings.listener;
  const ref = listener?.runsFrom;
  if (!listener || !ref?.root) {
    return null;
  }
  const portArgs = [
    "gateway",
    "--port",
    String(findings.port),
    ...(findings.extraGatewayArgs ?? []),
  ];
  if (ref.kind === "tarball") {
    return { argv: [path.join(ref.root, "bin", "bitterbot"), ...portArgs], cwd: ref.root };
  }
  if (!listener.exePath) {
    return null;
  }
  return {
    argv: [listener.exePath, path.join(ref.root, "bitterbot.mjs"), ...portArgs],
    cwd: ref.root,
  };
}

/** What to restore if the switch fails. Pure. */
export function buildRestorePlan(findings: GatewaySwitchFindings): RestorePlan {
  const definition = findings.service?.definition ?? null;
  const oldRef =
    findings.listener?.isGateway && !findings.listener.isSelf
      ? (findings.listener.runsFrom ?? null)
      : (findings.service?.runsFrom ?? null);
  const oldTarball = tarballVersionDir(oldRef);
  const selfTarball = tarballVersionDir(findings.self);
  const currentLink =
    oldTarball &&
    selfTarball &&
    oldTarball.version !== selfTarball.version &&
    sameRoot(oldTarball.appDir, selfTarball.appDir)
      ? oldTarball
      : null;
  const restartCommand =
    findings.listener?.isGateway && !findings.listener.underService
      ? restartCommandFor(findings)
      : null;
  let manual: string | null = null;
  if (!definition && !restartCommand && findings.listener?.isGateway) {
    manual = oldRef?.root
      ? `Start the old gateway again from ${oldRef.root} (for a git clone: cd ${oldRef.root} && pnpm start gateway).`
      : "Start your previous gateway again the way you usually start it.";
  }
  return {
    rawDefinition: findings.service?.raw ?? null,
    serviceDefinition: definition,
    serviceWasRunning: Boolean(findings.service?.running || findings.listener?.underService),
    restartCommand,
    currentLink,
    manual,
  };
}

/** Env for restarting an OLD install: drop this install's launcher markers. */
export function envForOldInstall(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.BITTERBOT_INSTALL_KIND;
  delete next.BITTERBOT_INSTALL_ROOT;
  delete next.BITTERBOT_NODE_OPTIONS_READY;
  return next;
}

/** "2m10s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Carry out a "switch" decision with rollback. Never throws; the outcome says
 * what happened. A non-switch decision is returned as is.
 */
export async function executeGatewaySwitch(params: {
  findings: GatewaySwitchFindings;
  decision: GatewaySwitchDecision;
  deps: GatewaySwitchDeps;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<GatewaySwitchTimeouts>;
  onStep?: (step: GatewaySwitchStep, detail?: string) => void;
  /** Progress lines during long waits ("Still starting (2m10s)..."). */
  onProgress?: (line: string) => void;
}): Promise<GatewaySwitchOutcome> {
  const { findings, decision, deps } = params;
  const env = params.env ?? process.env;
  const t = { ...DEFAULT_SWITCH_TIMEOUTS, ...params.timeouts };
  const steps: GatewaySwitchOutcome["steps"] = [];
  const record = (step: GatewaySwitchStep, ok: boolean, detail?: string) => {
    steps.push({ step, ok, ...(detail ? { detail } : {}) });
  };
  const progress = (line: string) => params.onProgress?.(line);
  if (decision.action === "none") {
    return { ok: true, status: "nothing-to-do", findings, decision, steps };
  }
  if (decision.action === "blocked") {
    return { ok: false, status: "blocked", findings, decision, steps, error: decision.message };
  }

  /** Poll `check` until true or the timeout, with a progress line now and then. */
  const waitFor = async (
    timeoutMs: number,
    check: () => Promise<boolean> | boolean,
    label?: string,
  ): Promise<boolean> => {
    const start = deps.now();
    let nextProgress = start + t.progressMs;
    for (;;) {
      if (await check()) {
        return true;
      }
      const now = deps.now();
      if (now - start >= timeoutMs) {
        return false;
      }
      if (label && now >= nextProgress) {
        progress(`  ${label} (${formatElapsed(now - start)})...`);
        nextProgress = now + t.progressMs;
      }
      await deps.sleep(t.pollMs);
    }
  };

  /** Children exit with their gateway; a verified orchestrator that lingers is ended. */
  const waitChildren = async (children: number[]): Promise<boolean> => {
    const alive = () => children.filter((c) => deps.isPidAlive(c));
    if (children.length === 0) {
      return true;
    }
    if (await waitFor(t.childrenMs, () => alive().length === 0)) {
      return true;
    }
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      for (const child of alive()) {
        const command = await deps.readCommandLine(child).catch(() => null);
        if (command?.toLowerCase().includes("bitterbot-orchestrator")) {
          try {
            deps.signal(child, sig);
          } catch {
            // already gone
          }
        }
      }
      if (await waitFor(t.childrenMs, () => alive().length === 0)) {
        return true;
      }
    }
    return false;
  };

  const restore = buildRestorePlan(findings);
  const port = findings.port;
  const oldPid = decision.stopPid;
  let serviceTouched = false;
  let oldStopped = false;
  let detachedPid: number | undefined;
  let snapshot: { dir: string } | null = null;
  let envCopied: string[] | undefined;
  /** Pids seen serving as the new gateway (never mistaken for a restored old one). */
  const newPids = new Set<number>();

  const rollback = async (reason: string): Promise<GatewaySwitchOutcome> => {
    params.onStep?.("rollback", reason);
    // 1. Stop whatever the switch started, and its children.
    const newProbe = await deps.probeGateway(port).catch(() => null);
    if (newProbe?.pid && newProbe.pid !== oldPid && (serviceTouched || detachedPid)) {
      newPids.add(newProbe.pid);
    }
    if (detachedPid) {
      newPids.add(detachedPid);
    }
    const newChildren: number[] = [];
    for (const pid of newPids) {
      newChildren.push(...(await deps.listChildren(pid).catch(() => [])));
    }
    if (serviceTouched) {
      if (decision.freshService) {
        await deps.uninstallService().catch(() => {});
      } else {
        await deps.stopService().catch(() => {});
      }
    }
    for (const pid of newPids) {
      if (pid !== oldPid && deps.isPidAlive(pid)) {
        try {
          deps.signal(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    // 2. The old foreground gateway must really be gone before it restarts
    // (a slow shutdown still holds the port and the gateway lock).
    const oldGone = await waitFor(
      t.stopMs,
      () => oldPid === null || !oldStopped || !deps.isPidAlive(oldPid),
      "Waiting for the old gateway to finish stopping",
    );
    const newGone = await waitFor(
      t.stopMs,
      async () =>
        [...newPids].every((p) => !deps.isPidAlive(p)) &&
        (!oldGone || !oldStopped || !(await deps.isPortListening(port))),
      "Waiting for the new gateway to stop",
    );
    const childrenGone = await waitChildren(newChildren);
    // 3. Data the new version migrated past what the old one knows (only
    // once no gateway can be writing it).
    let dataRestored: string[] | undefined;
    if (snapshot && newGone && oldGone && childrenGone) {
      dataRestored = await deps.restoreSnapshot(snapshot).catch(() => undefined);
    }
    // 4. Put the old code back.
    if (restore.currentLink) {
      try {
        deps.swapCurrentLink(restore.currentLink.appDir, restore.currentLink.version);
      } catch {
        // keep going: the service definition below may pin the old root anyway
      }
    }
    let serviceRestored = false;
    let processRestarted = false;
    let manual = restore.manual;
    if (serviceTouched && !decision.freshService) {
      try {
        if (restore.rawDefinition) {
          await deps.restoreRawDefinition(restore.rawDefinition, {
            start: restore.serviceWasRunning,
          });
        } else if (restore.serviceDefinition) {
          await deps.installService(restore.serviceDefinition);
          if (!restore.serviceWasRunning) {
            await deps.stopService().catch(() => {});
          }
        }
        serviceRestored = Boolean(restore.rawDefinition || restore.serviceDefinition);
      } catch (err) {
        manual = `Restoring the background service failed (${errorText(err)}). Reinstall it from your previous install (for a git clone: cd <clone> && pnpm bitterbot gateway install --force).`;
      }
    }
    if (oldStopped && restore.restartCommand) {
      if (!oldGone) {
        manual = `The previous gateway (pid ${oldPid}) is still shutting down. Once it has exited, start it again: ${restore.restartCommand.argv.join(" ")}`;
      } else {
        try {
          deps.startDetached({ ...restore.restartCommand, env: envForOldInstall(env) });
          processRestarted = true;
        } catch (err) {
          manual = `Restarting the previous gateway failed (${errorText(err)}). Start it the way you usually do.`;
        }
      }
    }
    const restored: "service" | "process" | "nothing" = serviceRestored
      ? "service"
      : processRestarted
        ? "process"
        : "nothing";
    const wasRunning = Boolean(findings.listener?.isGateway) || restore.serviceWasRunning;
    const expectRunning = processRestarted || (serviceRestored && restore.serviceWasRunning);
    let ok = true;
    if (wasRunning && expectRunning) {
      // Restored only when a gateway that is neither the old dying process
      // nor the new one serves the port and stays up.
      let candidate: number | null | undefined;
      let since = 0;
      ok = await waitFor(
        t.restoreMs,
        async () => {
          if (!(await deps.isPortListening(port))) {
            candidate = undefined;
            return false;
          }
          const probe = await deps.probeGateway(port).catch(() => null);
          const pid = probe?.pid ?? null;
          if (pid !== null && (pid === oldPid || newPids.has(pid))) {
            candidate = undefined;
            return false;
          }
          if (candidate !== pid) {
            candidate = pid;
            since = deps.now();
          }
          return deps.now() - since >= t.stableMs;
        },
        "Waiting for the previous gateway to come back",
      );
      if (!ok && !manual) {
        manual =
          "The previous gateway did not come back on its own. Start it the way you usually do.";
      }
    } else if (wasRunning && oldStopped) {
      ok = false;
      manual ??= "Start your previous gateway again the way you usually start it.";
    }
    record("rollback", ok, ok ? `restored ${restored}` : (manual ?? undefined));
    return {
      ok: false,
      status: "rolled-back",
      findings,
      decision,
      steps,
      error: reason,
      envCopied,
      snapshotDir: snapshot?.dir ?? null,
      rollback: {
        ok,
        restored,
        manual,
        ...(dataRestored && dataRestored.length > 0 ? { dataRestored } : {}),
      },
    };
  };

  const failed = (error: string): GatewaySwitchOutcome => ({
    ok: false,
    status: "failed",
    findings,
    decision,
    steps,
    error,
    snapshotDir: snapshot?.dir ?? null,
  });

  // 0. Snapshot while nothing has changed yet.
  params.onStep?.("snapshot");
  try {
    snapshot = await deps.snapshot();
    record("snapshot", true, snapshot?.dir);
  } catch (err) {
    record("snapshot", false, errorText(err));
    return failed(
      `Could not take the safety snapshot of your data: ${errorText(err)}. Nothing was changed.`,
    );
  }

  // 1. Stop the old gateway.
  if (decision.stopService) {
    params.onStep?.("stop-service");
    try {
      await deps.stopService();
      serviceTouched = true;
      oldStopped = true;
      record("stop-service", true);
    } catch (err) {
      record("stop-service", false, errorText(err));
      return failed(
        `Could not stop the background service: ${errorText(err)}. Nothing was changed.`,
      );
    }
  }
  if (oldPid !== null && deps.isPidAlive(oldPid)) {
    // Re-check right before signalling: the pid must still be the same gateway.
    const command = await deps.readCommandLine(oldPid).catch(() => null);
    const knownRoot = Boolean(findings.listener?.runsFrom?.root);
    const expectedStart = findings.listener?.startTime ?? null;
    const startNow = expectedStart ? await deps.readStartTime(oldPid).catch(() => null) : null;
    const sameProcess = !expectedStart || startNow === null || startNow === expectedStart;
    if (!isBitterbotGatewayCommand(command, knownRoot) || !sameProcess) {
      record("stop-process", false, "pid is no longer the same Bitterbot gateway");
      if (oldStopped) {
        return await rollback(
          `Process ${oldPid} is no longer the same Bitterbot gateway; not stopping it.`,
        );
      }
      return failed(
        `Process ${oldPid} is no longer the same Bitterbot gateway; it was left alone.`,
      );
    }
    params.onStep?.("stop-process", String(oldPid));
    try {
      deps.signal(oldPid, "SIGTERM");
      oldStopped = true;
      record("stop-process", true, String(oldPid));
    } catch (err) {
      record("stop-process", false, errorText(err));
      if (oldStopped) {
        return await rollback(`Could not stop process ${oldPid}: ${errorText(err)}`);
      }
      return failed(`Could not stop process ${oldPid}: ${errorText(err)}. Nothing was changed.`);
    }
  }
  if (oldStopped) {
    params.onStep?.("wait-stopped");
    const stopped = await waitFor(
      t.stopMs,
      async () => {
        const pidGone = oldPid === null || !deps.isPidAlive(oldPid);
        return pidGone && !(await deps.isPortListening(port));
      },
      "Waiting for the old gateway to exit",
    );
    record("wait-stopped", stopped);
    if (!stopped) {
      return await rollback(
        `The old gateway did not stop within ${Math.round(t.stopMs / 1000)} seconds.`,
      );
    }
    const children = findings.listener?.childPids ?? [];
    if (children.length > 0) {
      params.onStep?.("stop-children");
      const gone = await waitChildren(children);
      record("stop-children", gone);
      if (!gone) {
        return await rollback(
          "The old gateway's P2P orchestrator did not exit; its port and socket would still be in use.",
        );
      }
    }
  }

  // 2. A git clone's .env keys the state directory lacks.
  const migration = findings.envMigration;
  if (migration && migration.keys.length > 0) {
    params.onStep?.("copy-env");
    try {
      const res = await deps.copyEnv(migration);
      envCopied = res.copied;
      record("copy-env", true, res.copied.join(", "));
    } catch (err) {
      record("copy-env", false, errorText(err));
      return await rollback(`Could not copy the .env keys: ${errorText(err)}`);
    }
  }

  // 3. Start this install.
  if (decision.installService) {
    params.onStep?.("install-service");
    try {
      const definition = await deps.buildServiceDefinition();
      serviceTouched = true;
      await deps.installService(definition);
      record("install-service", true);
    } catch (err) {
      record("install-service", false, errorText(err));
      return await rollback(`Could not set up the background service: ${errorText(err)}`);
    }
  } else if (decision.startDetached) {
    params.onStep?.("start-gateway");
    try {
      const definition = await deps.buildServiceDefinition();
      const started = deps.startDetached({
        argv: [...definition.programArguments, ...(findings.extraGatewayArgs ?? [])],
        // Started from its own root, so it can be located (and recognised as
        // this install) even when its command line becomes a process title.
        cwd: definition.workingDirectory ?? findings.self.root ?? undefined,
        env: { ...env, ...findings.carriedEnv },
      });
      detachedPid = started.pid;
      record("start-gateway", true, `pid ${started.pid ?? "?"}, log ${started.logPath}`);
    } catch (err) {
      record("start-gateway", false, errorText(err));
      return await rollback(`Could not start the gateway: ${errorText(err)}`);
    }
  }

  // 4. Healthy: this version answers and the same process stays up. A
  // gateway that is alive keeps getting time (first starts can migrate
  // memory); one that exits fails fast.
  params.onStep?.("wait-healthy");
  const started = deps.now();
  let deadline = started + t.healthyMs;
  let candidate: number | null | undefined;
  let candidateSince = 0;
  let diedAt: number | null = null;
  let nextProgress = started + t.progressMs;
  const newAlive = async (): Promise<boolean> => {
    if (detachedPid) {
      return deps.isPidAlive(detachedPid);
    }
    return await deps.serviceRunning().catch(() => true);
  };
  let healthy = false;
  let exited = false;
  let wasAlive = true;
  let deaths = 0;
  for (;;) {
    const probe = (await deps.isPortListening(port))
      ? await deps.probeGateway(port).catch(() => null)
      : null;
    const rootOk =
      probe !== null &&
      (probe.root && findings.self.root
        ? sameRoot(probe.root, findings.self.root)
        : Boolean(probe.version && probe.version === findings.self.version));
    const versionOk =
      probe !== null &&
      ((probe.version !== null && probe.version === findings.self.version) ||
        (probe.version === null && probe.rpc === "auth"));
    const pid = probe?.pid ?? null;
    if (rootOk && versionOk && (pid === null || pid !== oldPid)) {
      if (pid !== null) {
        newPids.add(pid);
      }
      if (candidate !== pid) {
        candidate = pid;
        candidateSince = deps.now();
      }
      if (deps.now() - candidateSince >= t.stableMs) {
        healthy = true;
        break;
      }
    } else {
      candidate = undefined;
    }
    const now = deps.now();
    if (await newAlive()) {
      diedAt = null;
      wasAlive = true;
    } else {
      // A service manager restarts a gateway that crashes at boot: count
      // the deaths, so a crash loop fails as fast as a plain exit.
      if (wasAlive) {
        deaths += 1;
      }
      wasAlive = false;
      diedAt ??= now;
      if (now - diedAt >= t.exitedGraceMs || deaths >= CRASH_LOOP_DEATHS) {
        exited = true;
        break;
      }
    }
    if (now >= nextProgress) {
      progress(
        `  Still starting (${formatElapsed(now - started)})... a first start can take a few minutes while memory is upgraded.`,
      );
      nextProgress = now + t.progressMs;
    }
    if (now >= deadline) {
      if (!(await newAlive())) {
        break;
      }
      if (deps.askKeepWaiting) {
        if (!(await deps.askKeepWaiting(now - started))) {
          break;
        }
        deadline = now + t.healthyMs;
      } else if (now - started >= t.maxHealthyMs) {
        break;
      } else {
        deadline = Math.min(started + t.maxHealthyMs, now + t.healthyMs);
      }
    }
    await deps.sleep(t.pollMs * 2);
  }
  record("wait-healthy", healthy);
  if (!healthy) {
    return await rollback(
      exited
        ? "The new gateway exited during startup."
        : `The new gateway did not become healthy within ${formatElapsed(deps.now() - started)}.`,
    );
  }
  return {
    ok: true,
    status: "switched",
    findings,
    decision,
    steps,
    envCopied,
    snapshotDir: snapshot?.dir ?? null,
  };
}
