/**
 * The real side of `bitterbot gateway switch` (src/infra/gateway-switch.ts):
 * reading the installed background service, the process listening on the
 * gateway port (Linux /proc, macOS ps + lsof, Windows CIM), the install it
 * runs from, and the deps that stop, install and start things.
 *
 * Detection only reads. Nothing here writes to the data directory.
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { VERSION } from "../version.js";
import { resolveBitterbotPackageRoot } from "./bitterbot-root.js";
import {
  decideGatewaySwitch,
  definitionFollowsCurrent,
  isBitterbotEntryArg,
  isBitterbotGatewayCommand,
  sameRoot,
  type GatewaySwitchDecision,
  type GatewaySwitchDeps,
  type GatewaySwitchFindings,
  type InstallRef,
  type ListenerFindings,
  type ServiceDefinition,
  type ServiceFindings,
} from "./gateway-switch.js";
import { detectInstallKind } from "./install-kind.js";
import { inspectPortUsage } from "./ports-inspect.js";
import { swapVersionLink } from "./tarball-install.js";

const log = createSubsystemLogger("gateway/switch");

export type ProcInfo = {
  pid: number;
  ppid: number | null;
  commandLine: string | null;
  exe: string | null;
  cwd: string | null;
};

async function run(argv: string[], timeoutMs = 5_000): Promise<{ code: number; stdout: string }> {
  try {
    const res = await runCommandWithTimeout(argv, { timeoutMs });
    return { code: res.code ?? 1, stdout: res.stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

async function readLinuxProc(pid: number): Promise<ProcInfo | null> {
  const base = `/proc/${pid}`;
  let stat: string;
  try {
    stat = await fs.readFile(`${base}/stat`, "utf8");
  } catch {
    return null;
  }
  // "pid (comm) state ppid ..."; comm may contain spaces and parens.
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number.parseInt(after[1] ?? "", 10);
  const cmdline = await fs.readFile(`${base}/cmdline`, "utf8").catch(() => "");
  const args = cmdline.split("\0").filter(Boolean);
  const exe = await fs.readlink(`${base}/exe`).catch(() => null);
  const cwd = await fs.readlink(`${base}/cwd`).catch(() => null);
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : null,
    commandLine: args.length > 0 ? args.join(" ") : null,
    exe: exe ? exe.replace(/ \(deleted\)$/, "") : null,
    cwd,
  };
}

async function readDarwinProc(pid: number): Promise<ProcInfo | null> {
  const ps = await run(["ps", "-o", "ppid=,command=", "-p", String(pid)]);
  if (ps.code !== 0 || !ps.stdout.trim()) {
    return null;
  }
  const m = /^\s*(\d+)\s+(.*)$/.exec(ps.stdout.trim());
  const lsof = await run(["lsof", "-a", "-p", String(pid), "-d", "cwd,txt", "-Fn"]);
  let cwd: string | null = null;
  let exe: string | null = null;
  let fd = "";
  for (const line of lsof.stdout.split(/\r?\n/)) {
    if (line.startsWith("f")) {
      fd = line.slice(1);
    } else if (line.startsWith("n")) {
      if (fd === "cwd" && !cwd) {
        cwd = line.slice(1);
      } else if (fd === "txt" && !exe) {
        exe = line.slice(1);
      }
    }
  }
  return {
    pid,
    ppid: m ? Number.parseInt(m[1] ?? "", 10) : null,
    commandLine: m ? (m[2] ?? null) : ps.stdout.trim(),
    exe,
    cwd,
  };
}

type CimProcess = {
  ProcessId?: number;
  ParentProcessId?: number;
  CommandLine?: string | null;
  ExecutablePath?: string | null;
};

async function readWindowsProcs(filter: string): Promise<CimProcess[]> {
  const res = await run(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress`,
    ],
    10_000,
  );
  if (res.code !== 0 || !res.stdout.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(res.stdout) as CimProcess | CimProcess[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** One process's parent, command line, executable and working directory. */
export async function readProcInfo(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (platform === "linux") {
    return await readLinuxProc(pid);
  }
  if (platform === "darwin") {
    return await readDarwinProc(pid);
  }
  if (platform === "win32") {
    const [p] = await readWindowsProcs(`ProcessId=${pid}`);
    if (!p) {
      return null;
    }
    return {
      pid,
      ppid: typeof p.ParentProcessId === "number" ? p.ParentProcessId : null,
      commandLine: p.CommandLine ?? null,
      exe: p.ExecutablePath ?? null,
      cwd: null,
    };
  }
  return null;
}

/** Direct children of `pid`. */
export async function listChildPids(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number[]> {
  if (platform === "linux") {
    const out: number[] = [];
    const entries = await fs.readdir("/proc").catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map(async (e) => {
          const stat = await fs.readFile(`/proc/${e}/stat`, "utf8").catch(() => "");
          const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number.parseInt(after[1] ?? "", 10) === pid) {
            out.push(Number.parseInt(e, 10));
          }
        }),
    );
    return out;
  }
  if (platform === "darwin") {
    const res = await run(["ps", "-A", "-o", "pid=,ppid="]);
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === pid)
      .map(([child]) => child)
      .filter((c): c is number => Number.isInteger(c));
  }
  if (platform === "win32") {
    return (await readWindowsProcs(`ParentProcessId=${pid}`))
      .map((p) => p.ProcessId)
      .filter((c): c is number => typeof c === "number");
  }
  return [];
}

function splitCommandLine(commandLine: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(commandLine); m; m = re.exec(commandLine)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/** The Bitterbot package root containing `dir` (a realpath), or null. */
export async function packageRootOf(dir: string): Promise<string | null> {
  const root = await resolveBitterbotPackageRoot({ cwd: dir }).catch(() => null);
  return root ? await realpathSafe(root) : null;
}

/** The release-tarball root of a bundled node (`<root>/runtime/node/bin/node`). */
export function tarballRootFromExe(exe: string | null): string | null {
  if (!exe) {
    return null;
  }
  const m = /^(.*)[/\\]runtime[/\\]node[/\\]bin[/\\]node(?:\.exe)?$/i.exec(exe);
  return m?.[1] ?? null;
}

/** The install root named by a command's arguments (an entry file or launcher). */
export async function resolveRootFromArgs(
  args: string[],
  cwd: string | null,
): Promise<string | null> {
  for (const arg of args) {
    if (!arg || arg.startsWith("-") || !isBitterbotEntryArg(arg)) {
      continue;
    }
    const abs = path.isAbsolute(arg) ? arg : cwd ? path.resolve(cwd, arg) : null;
    if (!abs) {
      continue;
    }
    const real = await realpathSafe(abs);
    const root = await packageRootOf(path.dirname(real));
    if (root) {
      return root;
    }
  }
  return null;
}

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function installRefFor(root: string | null): Promise<InstallRef | null> {
  if (!root) {
    return null;
  }
  return {
    root,
    // The installed root's own kind, not this process's declared one.
    kind: detectInstallKind(root, { env: {} }),
    version: await readPackageVersion(root),
  };
}

/** This install: the package this CLI runs from. */
export async function resolveSelfInstall(): Promise<InstallRef> {
  const root = await resolveBitterbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  }).catch(() => null);
  const real = root ? await realpathSafe(root) : null;
  return {
    root: real,
    kind: real ? detectInstallKind(real) : "unknown",
    version:
      VERSION && VERSION !== "0.0.0" ? VERSION : real ? await readPackageVersion(real) : null,
  };
}

/**
 * Where a running process comes from: its bundled-node executable (tarball),
 * its command line (when not replaced by a process title), its working
 * directory, else its parents' (the gateway runs as a child of the CLI
 * process, which runs as a child of `pnpm start` in a clone).
 */
export async function resolveProcessRoot(
  pid: number,
  readInfo: (pid: number) => Promise<ProcInfo | null> = (p) => readProcInfo(p),
): Promise<{
  root: string | null;
  exe: string | null;
  ancestors: number[];
  command: string | null;
}> {
  const ancestors: number[] = [];
  let current: number | null = pid;
  let exe: string | null = null;
  let command: string | null = null;
  for (let depth = 0; depth < 5 && current && current > 1; depth += 1) {
    const info = await readInfo(current);
    if (!info) {
      break;
    }
    ancestors.push(current);
    if (depth === 0) {
      exe = info.exe;
      command = info.commandLine;
    }
    const fromExe = tarballRootFromExe(info.exe);
    if (fromExe) {
      return { root: await realpathSafe(fromExe), exe, ancestors, command };
    }
    if (info.commandLine) {
      const fromArgs = await resolveRootFromArgs(splitCommandLine(info.commandLine), info.cwd);
      if (fromArgs) {
        return { root: fromArgs, exe, ancestors, command };
      }
    }
    if (info.cwd) {
      const fromCwd = await packageRootOf(info.cwd);
      if (fromCwd) {
        return { root: fromCwd, exe, ancestors, command };
      }
    }
    current = info.ppid;
  }
  return { root: null, exe, ancestors, command };
}

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

const quietStream = () => new Writable({ write: (_chunk, _enc, cb) => cb() });

/** The installed gateway service and what it runs, or null when none is installed. */
export async function inspectGatewayService(params: {
  self: InstallRef;
  env?: NodeJS.ProcessEnv;
}): Promise<ServiceFindings | null> {
  const env = params.env ?? process.env;
  try {
    const { resolveGatewayService } = await import("../daemon/service.js");
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env }).catch(() => false);
    if (!loaded) {
      return null;
    }
    const definition = (await service
      .readCommand(env)
      .catch(() => null)) as ServiceDefinition | null;
    const runtime = await service.readRuntime(env).catch(() => null);
    const root = definition
      ? await resolveRootFromArgs(definition.programArguments, definition.workingDirectory ?? null)
      : null;
    const runsFrom = await installRefFor(root);
    return {
      label: serviceLabelFor(process.platform),
      definition,
      runsFrom,
      followsCurrent: definitionFollowsCurrent(definition),
      // Unresolvable definitions are left alone (never nag about them).
      pointsHere: !root || sameRoot(root, params.self.root),
      running: runtime?.status === "running",
      ...(runtime?.pid ? { pid: runtime.pid } : {}),
    };
  } catch (err) {
    log.debug(`service inspection failed: ${String(err)}`);
    return null;
  }
}

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
export function isPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The version a gateway reports over the status RPC (1.5+), or null. */
async function queryGatewayVersion(
  cfg: BitterbotConfig,
  port: number,
  configPort: number,
): Promise<string | null> {
  if (port !== configPort) {
    return null;
  }
  try {
    const { callGateway } = await import("../gateway/call.js");
    const status = await callGateway<{ runtime?: { version?: unknown } }>({
      config: cfg,
      method: "status",
      timeoutMs: 3_000,
    });
    const version = status?.runtime?.version;
    return typeof version === "string" && version !== "dev" ? version : null;
  } catch {
    return null;
  }
}

async function findListenerPid(
  port: number,
): Promise<{ pid: number | null; command: string | null } | null> {
  const usage = await inspectPortUsage(port);
  if (usage.status !== "busy") {
    return (await isPortListening(port)) ? { pid: null, command: null } : null;
  }
  const withPid = usage.listeners.filter((l) => typeof l.pid === "number");
  const pick =
    withPid.find((l) => isBitterbotGatewayCommand(l.commandLine ?? l.command)) ??
    withPid[0] ??
    usage.listeners[0];
  return { pid: pick?.pid ?? null, command: pick?.commandLine ?? pick?.command ?? null };
}

export type DetectOptions = {
  port?: number;
  env?: NodeJS.ProcessEnv;
  config?: BitterbotConfig;
};

/** Read everything the decision needs. Read-only. */
export async function detectGatewaySwitch(opts: DetectOptions = {}): Promise<{
  findings: GatewaySwitchFindings;
  decision: GatewaySwitchDecision;
  config: BitterbotConfig;
}> {
  const env = opts.env ?? process.env;
  const { loadConfig, resolveGatewayPort } = await import("../config/config.js");
  const cfg = opts.config ?? loadConfig();
  const configPort = resolveGatewayPort(cfg, env);
  const port = opts.port ?? configPort;
  const self = await resolveSelfInstall();
  const service = await inspectGatewayService({ self, env });

  let listener: ListenerFindings | null = null;
  const found = await findListenerPid(port);
  if (found) {
    if (found.pid === null) {
      const version = await queryGatewayVersion(cfg, port, configPort);
      listener = {
        pid: null,
        command: found.command,
        isGateway: version !== null,
        runsFrom: null,
        reportedVersion: version,
        isSelf: Boolean(version && version === self.version),
        underService: false,
        exePath: null,
        childPids: [],
      };
    } else {
      const proc = await resolveProcessRoot(found.pid);
      const command = proc.command ?? found.command;
      const isGateway = isBitterbotGatewayCommand(command, Boolean(proc.root));
      const reportedVersion = isGateway ? await queryGatewayVersion(cfg, port, configPort) : null;
      const ref = await installRefFor(proc.root);
      if (ref && reportedVersion) {
        ref.version = reportedVersion;
      }
      const underService = Boolean(
        service &&
        ((service.pid && proc.ancestors.includes(service.pid)) ||
          (!service.pid &&
            service.running &&
            proc.root &&
            sameRoot(proc.root, service.runsFrom?.root))),
      );
      listener = {
        pid: found.pid,
        command,
        isGateway,
        runsFrom: ref,
        reportedVersion,
        isSelf: proc.root
          ? sameRoot(proc.root, self.root)
          : Boolean(reportedVersion && reportedVersion === self.version),
        underService,
        exePath: proc.exe,
        childPids: isGateway ? await listChildPids(found.pid) : [],
      };
    }
  }

  const findings: GatewaySwitchFindings = {
    port,
    self,
    service,
    listener,
    remoteMode: cfg.gateway?.mode === "remote",
    extraGatewayArgs: cfg.gateway?.mode ? [] : ["--allow-unconfigured"],
  };
  return { findings, decision: decideGatewaySwitch(findings), config: cfg };
}

/** Environment for a gateway started here: never the installer's test overrides. */
function backgroundEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    "BITTERBOT_INSTALL_TEST_MODE",
    "BITTERBOT_INSTALL_BASE_URL",
    "BITTERBOT_INSTALL_TEST_PUBKEY",
    "BITTERBOT_INSTALL_TEST_VERIFIER",
  ]) {
    delete next[key];
  }
  return next;
}

/** Start a gateway detached, logging to a file in the OS temp directory. */
export function startDetachedGateway(cmd: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { pid?: number; logPath: string } {
  const [file, ...args] = cmd.argv;
  if (!file) {
    throw new Error("empty command");
  }
  const logPath = path.join(os.tmpdir(), `bitterbot-gateway-switch-${Date.now()}.log`);
  const fd = fsSync.openSync(logPath, "a", 0o600);
  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: cmd.cwd && fsSync.existsSync(cmd.cwd) ? cmd.cwd : os.homedir(),
      env: backgroundEnv(cmd.env ?? process.env),
      windowsHide: true,
    });
    child.on("error", (err) => log.warn(`gateway start failed: ${String(err)}`));
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    fsSync.closeSync(fd);
  }
}

function toStringRecord(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

/** The real deps: service manager, signals, ports, the `current` link. */
export function createSystemSwitchDeps(params: {
  findings: GatewaySwitchFindings;
  config: BitterbotConfig;
  env?: NodeJS.ProcessEnv;
}): GatewaySwitchDeps {
  const env = params.env ?? process.env;
  const { findings, config } = params;
  const service = async () => (await import("../daemon/service.js")).resolveGatewayService();
  return {
    stopService: async () => {
      await (await service()).stop({ env, stdout: quietStream() });
    },
    installService: async (definition) => {
      await (
        await service()
      ).install({
        env,
        stdout: quietStream(),
        programArguments: definition.programArguments,
        workingDirectory: definition.workingDirectory,
        environment: definition.environment,
      });
    },
    buildServiceDefinition: async () => {
      const { buildGatewayInstallPlan } = await import("../commands/daemon-install-helpers.js");
      const { DEFAULT_GATEWAY_DAEMON_RUNTIME } = await import("../commands/daemon-runtime.js");
      const cfgToken = config.gateway?.auth?.token;
      // Keep the gateway's auth: the config token, else the one the old
      // service carried, else this shell's.
      const token =
        (typeof cfgToken === "string" && cfgToken.trim() ? cfgToken.trim() : undefined) ??
        findings.service?.definition?.environment?.BITTERBOT_GATEWAY_TOKEN ??
        env.BITTERBOT_GATEWAY_TOKEN;
      const plan = await buildGatewayInstallPlan({
        env,
        port: findings.port,
        token,
        runtime: DEFAULT_GATEWAY_DAEMON_RUNTIME,
        config,
      });
      return {
        programArguments: plan.programArguments,
        ...(plan.workingDirectory ? { workingDirectory: plan.workingDirectory } : {}),
        environment: toStringRecord(plan.environment),
      };
    },
    startDetached: startDetachedGateway,
    readCommandLine: async (pid) => (await readProcInfo(pid))?.commandLine ?? null,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signal: (pid, sig) => {
      process.kill(pid, sig);
    },
    isPortListening: (port) => isPortListening(port),
    probeGateway: async (port) => {
      const { resolveGatewayPort } = await import("../config/config.js");
      const version = await queryGatewayVersion(config, port, resolveGatewayPort(config, env));
      const found = await findListenerPid(port);
      const root = found?.pid ? (await resolveProcessRoot(found.pid)).root : null;
      return { version, root };
    },
    swapCurrentLink: (appDir, version) => swapVersionLink(appDir, "current", version),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
