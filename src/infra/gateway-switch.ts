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
 *   1. stop the old gateway: through its service manager when the service
 *      runs it, otherwise a graceful SIGTERM to that pid, but ONLY when the
 *      process is verifiably a Bitterbot gateway; then wait for the port to
 *      free and for its children (the P2P orchestrator) to exit;
 *   2. re-point the background service at this install (the same plan as
 *      `bitterbot gateway install --force`) and start it, or, when there was
 *      no service, start this install's gateway in the background;
 *   3. wait until the gateway on the port is this version;
 *   4. on failure, roll back: stop the new gateway, restore the old service
 *      definition verbatim (and `current` for a tarball-to-tarball switch),
 *      restart the old process the way it was started, and say exactly what
 *      to run when that is not possible.
 *
 * The data directory (~/.bitterbot: config, memory, keys) is never read for
 * writing here: only the service definition, the process and, for a release
 * tarball, the `current` link move.
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

export type ServiceFindings = {
  /** Human name of the service manager ("systemd user service"). */
  label: string;
  definition: ServiceDefinition | null;
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

export type GatewaySwitchFindings = {
  port: number;
  self: InstallRef;
  service: ServiceFindings | null;
  listener: ListenerFindings | null;
  /** gateway.mode is "remote": the gateway is on another machine. */
  remoteMode: boolean;
  /**
   * Extra `gateway` arguments for a gateway started in the background here
   * (`--allow-unconfigured` when the config does not set gateway.mode yet).
   */
  extraGatewayArgs?: string[];
};

export type GatewaySwitchDecision =
  | {
      action: "none";
      reason: "fresh" | "already-current";
    }
  | {
      action: "blocked";
      reason:
        | "remote-mode"
        | "container"
        | "foreign-listener"
        | "unidentified-listener"
        | "cannot-restore";
      message: string;
    }
  | {
      action: "switch";
      /** The install being replaced (the running one, else the service's). */
      from: InstallRef | null;
      stopService: boolean;
      /** A verified gateway pid to SIGTERM when the service stop did not stop it. */
      stopPid: number | null;
      /** Re-point (reinstall) the background service at this install. */
      installService: boolean;
      /** No service: start this install's gateway in the background. */
      startDetached: boolean;
    };

/** How to bring the old gateway back when the new one does not come up. */
export type RestorePlan = {
  /** Reinstall this service definition verbatim. */
  serviceDefinition: ServiceDefinition | null;
  /** Restart the old foreground gateway with this command. */
  restartCommand: { argv: string[]; cwd?: string } | null;
  /** For a tarball-to-tarball switch: point `<appDir>/current` back at `version`. */
  currentLink: { appDir: string; version: string } | null;
  /** Human instructions when nothing can be restored automatically. */
  manual: string | null;
};

export type GatewaySwitchStep =
  | "stop-service"
  | "stop-process"
  | "wait-stopped"
  | "stop-children"
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
  rollback?: {
    ok: boolean;
    restored: "service" | "process" | "nothing";
    manual: string | null;
  };
};

export type GatewayHealth = { ok: boolean; version: string | null; detail?: string };

export type DetachedStart = { pid?: number; logPath: string };

export type GatewaySwitchDeps = {
  /** Stop the background service (its manager stops the gateway). */
  stopService: () => Promise<void>;
  /** Install (and start) the service with this definition. */
  installService: (definition: ServiceDefinition) => Promise<void>;
  /** The service definition for THIS install (buildGatewayInstallPlan). */
  buildServiceDefinition: () => Promise<ServiceDefinition>;
  /** Start a gateway in the background, unsupervised. */
  startDetached: (cmd: { argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) => DetachedStart;
  /** The process command line now (re-checked right before signalling). */
  readCommandLine: (pid: number) => Promise<string | null>;
  isPidAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  isPortListening: (port: number) => Promise<boolean>;
  /** Who serves the port now: version reported, and the install it runs from. */
  probeGateway: (port: number) => Promise<{ version: string | null; root: string | null }>;
  /** Point `<appDir>/current` at `version`. */
  swapCurrentLink: (appDir: string, version: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type GatewaySwitchTimeouts = {
  stopMs: number;
  childrenMs: number;
  healthyMs: number;
  restoreMs: number;
  pollMs: number;
};

export const DEFAULT_SWITCH_TIMEOUTS: GatewaySwitchTimeouts = {
  stopMs: 45_000,
  childrenMs: 15_000,
  healthyMs: 120_000,
  restoreMs: 90_000,
  pollMs: 500,
};

/** How long a gateway started here may be gone before the switch gives up on it. */
const EXITED_GRACE_MS = 15_000;

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

/** The `--port` a definition passes, if any. */
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
  return null;
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

/** Decide what to do from what was found. Pure. */
export function decideGatewaySwitch(findings: GatewaySwitchFindings): GatewaySwitchDecision {
  const { self, service, listener, port } = findings;
  if (findings.remoteMode) {
    return {
      action: "blocked",
      reason: "remote-mode",
      message:
        "This machine is set up to use a remote gateway (gateway.mode is remote), so there is no local gateway to switch.",
    };
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
      message: `Port ${port} is used by another program${listener.pid ? ` (pid ${listener.pid}${listener.command ? `, ${listener.command}` : ""})` : ""}, not a Bitterbot gateway. It was left alone.`,
    };
  }
  const listenerOld = Boolean(listener && listener.isGateway && !listener.isSelf);
  const serviceElsewhere = Boolean(service && !service.pointsHere);
  if (!listenerOld && !serviceElsewhere) {
    return { action: "none", reason: listener || service ? "already-current" : "fresh" };
  }
  if (listenerOld && listener && listener.pid === null) {
    return {
      action: "blocked",
      reason: "unidentified-listener",
      message: `A Bitterbot gateway is running on port ${port}, but its process could not be identified (run as the same user, or install lsof). Stop it yourself, then run: bitterbot gateway switch`,
    };
  }
  // A foreground gateway (no service runs it) must be restartable before we
  // stop it, or a failed switch would leave nothing running.
  if (listenerOld && listener && !listener.underService && !restartCommandFor(findings)) {
    return {
      action: "blocked",
      reason: "cannot-restore",
      message: `A Bitterbot gateway is running on port ${port} (pid ${listener.pid}), but where it was started from could not be determined, so it could not be restarted if the switch failed. Stop it yourself (Ctrl+C in its terminal, or: kill ${listener.pid}), then run: bitterbot gateway switch`,
    };
  }
  const from = listenerOld ? (listener?.runsFrom ?? null) : (service?.runsFrom ?? null);
  return {
    action: "switch",
    from,
    stopService: Boolean(service && (service.running || listener?.underService)),
    stopPid: listenerOld ? (listener?.pid ?? null) : null,
    installService: Boolean(service),
    startDetached: !service && listenerOld,
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
  const oldRef = findings.listener?.isGateway
    ? (findings.listener.runsFrom ?? null)
    : (findings.service?.runsFrom ?? null);
  const oldTarball = tarballVersionDir(oldRef);
  const selfTarball = tarballVersionDir(findings.self);
  const currentLink =
    oldTarball && selfTarball && sameRoot(oldTarball.appDir, selfTarball.appDir)
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
  return { serviceDefinition: definition, restartCommand, currentLink, manual };
}

/** Env for restarting an OLD install: drop this install's launcher markers. */
export function envForOldInstall(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.BITTERBOT_INSTALL_KIND;
  delete next.BITTERBOT_INSTALL_ROOT;
  delete next.BITTERBOT_NODE_OPTIONS_READY;
  return next;
}

async function waitFor(
  deps: GatewaySwitchDeps,
  timeoutMs: number,
  pollMs: number,
  check: () => Promise<boolean> | boolean,
): Promise<boolean> {
  const until = deps.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return true;
    }
    if (deps.now() >= until) {
      return false;
    }
    await deps.sleep(pollMs);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the gateway on the port is this install. */
async function isSelfServing(
  deps: GatewaySwitchDeps,
  findings: GatewaySwitchFindings,
): Promise<boolean> {
  if (!(await deps.isPortListening(findings.port))) {
    return false;
  }
  const probe = await deps.probeGateway(findings.port).catch(() => null);
  if (!probe) {
    return false;
  }
  if (probe.root && findings.self.root) {
    return sameRoot(probe.root, findings.self.root);
  }
  return Boolean(probe.version && findings.self.version && probe.version === findings.self.version);
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
}): Promise<GatewaySwitchOutcome> {
  const { findings, decision, deps } = params;
  const env = params.env ?? process.env;
  const t = { ...DEFAULT_SWITCH_TIMEOUTS, ...params.timeouts };
  const steps: GatewaySwitchOutcome["steps"] = [];
  const record = (step: GatewaySwitchStep, ok: boolean, detail?: string) => {
    steps.push({ step, ok, ...(detail ? { detail } : {}) });
  };
  if (decision.action === "none") {
    return { ok: true, status: "nothing-to-do", findings, decision, steps };
  }
  if (decision.action === "blocked") {
    return { ok: false, status: "blocked", findings, decision, steps, error: decision.message };
  }

  const restore = buildRestorePlan(findings);
  const port = findings.port;
  let serviceTouched = false;
  let oldStopped = false;
  let detachedPid: number | undefined;

  const rollback = async (reason: string): Promise<GatewaySwitchOutcome> => {
    params.onStep?.("rollback", reason);
    // 1. Stop whatever the switch started.
    if (serviceTouched) {
      await deps.stopService().catch(() => {});
    }
    if (detachedPid && deps.isPidAlive(detachedPid)) {
      try {
        deps.signal(detachedPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await waitFor(deps, t.stopMs, t.pollMs, async () => !(await deps.isPortListening(port)));
    // 2. Put the old code back.
    if (restore.currentLink) {
      try {
        deps.swapCurrentLink(restore.currentLink.appDir, restore.currentLink.version);
      } catch {
        // keep going: the service definition below may pin the old root anyway
      }
    }
    const serviceWasRunning = Boolean(findings.service?.running || findings.listener?.underService);
    let serviceRestored = false;
    let processRestarted = false;
    let manual = restore.manual;
    if (restore.serviceDefinition && (serviceTouched || oldStopped)) {
      try {
        await deps.installService(restore.serviceDefinition);
        serviceRestored = true;
        // Installing starts it; a service that was not running before stays stopped.
        if (!serviceWasRunning) {
          await deps.stopService().catch(() => {});
        }
      } catch (err) {
        manual = `Restoring the background service failed (${errorText(err)}). Reinstall it from your previous install (for a git clone: cd <clone> && pnpm bitterbot gateway install --force).`;
      }
    }
    if (oldStopped && restore.restartCommand) {
      try {
        deps.startDetached({ ...restore.restartCommand, env: envForOldInstall(env) });
        processRestarted = true;
      } catch (err) {
        manual = `Restarting the previous gateway failed (${errorText(err)}). Start it the way you usually do.`;
      }
    }
    const restored: "service" | "process" | "nothing" = serviceRestored
      ? "service"
      : processRestarted
        ? "process"
        : "nothing";
    const wasRunning = Boolean(findings.listener?.isGateway) || serviceWasRunning;
    const expectRunning = processRestarted || (serviceRestored && serviceWasRunning);
    let ok = true;
    if (wasRunning && expectRunning) {
      ok = await waitFor(deps, t.restoreMs, t.pollMs, () => deps.isPortListening(port));
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
      rollback: { ok, restored, manual },
    };
  };

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
      return {
        ok: false,
        status: "failed",
        findings,
        decision,
        steps,
        error: `Could not stop the background service: ${errorText(err)}. Nothing was changed.`,
      };
    }
  }
  const pid = decision.stopPid;
  if (pid !== null && deps.isPidAlive(pid)) {
    // Re-check right before signalling: the pid must still be a gateway.
    const command = await deps.readCommandLine(pid).catch(() => null);
    const knownRoot = Boolean(findings.listener?.runsFrom?.root);
    if (!isBitterbotGatewayCommand(command, knownRoot)) {
      record("stop-process", false, "pid is no longer a Bitterbot gateway");
      if (oldStopped) {
        return await rollback(`Process ${pid} is no longer a Bitterbot gateway; not stopping it.`);
      }
      return {
        ok: false,
        status: "failed",
        findings,
        decision,
        steps,
        error: `Process ${pid} is no longer a Bitterbot gateway; it was left alone.`,
      };
    }
    params.onStep?.("stop-process", String(pid));
    try {
      deps.signal(pid, "SIGTERM");
      oldStopped = true;
      record("stop-process", true, String(pid));
    } catch (err) {
      record("stop-process", false, errorText(err));
      if (oldStopped) {
        return await rollback(`Could not stop process ${pid}: ${errorText(err)}`);
      }
      return {
        ok: false,
        status: "failed",
        findings,
        decision,
        steps,
        error: `Could not stop process ${pid}: ${errorText(err)}. Nothing was changed.`,
      };
    }
  }
  if (oldStopped) {
    params.onStep?.("wait-stopped");
    const stopped = await waitFor(deps, t.stopMs, t.pollMs, async () => {
      const pidGone = pid === null || !deps.isPidAlive(pid);
      return pidGone && !(await deps.isPortListening(port));
    });
    record("wait-stopped", stopped);
    if (!stopped) {
      return await rollback(
        `The old gateway did not stop within ${Math.round(t.stopMs / 1000)} seconds.`,
      );
    }
    // Its children (the P2P orchestrator) exit with it; nudge stragglers that
    // are verifiably the orchestrator.
    const children = findings.listener?.childPids ?? [];
    if (children.length > 0) {
      params.onStep?.("stop-children");
      let gone = await waitFor(deps, t.childrenMs, t.pollMs, () =>
        children.every((c) => !deps.isPidAlive(c)),
      );
      if (!gone) {
        for (const child of children) {
          if (!deps.isPidAlive(child)) {
            continue;
          }
          const command = await deps.readCommandLine(child).catch(() => null);
          if (command?.toLowerCase().includes("bitterbot-orchestrator")) {
            try {
              deps.signal(child, "SIGTERM");
            } catch {
              // already gone
            }
          }
        }
        gone = await waitFor(deps, t.childrenMs, t.pollMs, () =>
          children.every((c) => !deps.isPidAlive(c)),
        );
      }
      record("stop-children", gone);
    }
  }

  // 2. Start this install.
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
        cwd: definition.workingDirectory,
        env,
      });
      detachedPid = started.pid;
      record("start-gateway", true, `pid ${started.pid ?? "?"}, log ${started.logPath}`);
    } catch (err) {
      record("start-gateway", false, errorText(err));
      return await rollback(`Could not start the gateway: ${errorText(err)}`);
    }
  }

  // 3. Healthy on this version?
  params.onStep?.("wait-healthy");
  // A gateway started here that exits (a boot failure) fails fast, after a
  // short grace in case it restarted itself under a fresh pid.
  let diedAt: number | null = null;
  const healthy = await waitFor(deps, t.healthyMs, t.pollMs * 2, async () => {
    if (await isSelfServing(deps, findings)) {
      return true;
    }
    if (detachedPid && !deps.isPidAlive(detachedPid)) {
      diedAt ??= deps.now();
      return deps.now() - diedAt >= EXITED_GRACE_MS;
    }
    return false;
  });
  const serving = healthy && (diedAt === null || (await isSelfServing(deps, findings)));
  record("wait-healthy", serving);
  if (!serving) {
    return await rollback(
      diedAt !== null
        ? "The new gateway exited during startup."
        : `The new gateway did not become healthy within ${Math.round(t.healthyMs / 1000)} seconds.`,
    );
  }
  return { ok: true, status: "switched", findings, decision, steps };
}
