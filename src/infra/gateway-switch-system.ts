/**
 * The real side of `bitterbot gateway switch` (src/infra/gateway-switch.ts):
 * reading the installed background service, the process listening on the
 * gateway port (Linux /proc, macOS ps + lsof, Windows CIM), the install it
 * runs from, and the deps that stop, install and start things.
 *
 * Detection only reads. The switch itself writes to the state directory in
 * exactly three ways: the pre-switch snapshot (the updater's), the `.env`
 * keys copied from a git clone (src/infra/gateway-switch-env.ts), and the
 * background log of a gateway started without a service manager.
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
  carriedServiceEnv,
  copyDotEnvKeys,
  insertEnvironmentFiles,
  parseEnvironmentFiles,
  planDotEnvMerge,
  processOnlyEnvNames,
  readProcEnviron,
} from "./gateway-switch-env.js";
import {
  decideGatewaySwitch,
  definitionFollowsCurrent,
  definitionPort,
  isBitterbotEntryArg,
  isBitterbotGatewayCommand,
  sameRoot,
  serviceLabelFor,
  targetMismatch,
  type EnvMigration,
  type GatewaySwitchDecision,
  type GatewaySwitchDeps,
  type GatewaySwitchFindings,
  type GatewayTarget,
  type InstallRef,
  type ListenerFindings,
  type ServiceDefinition,
  type RawServiceDefinition,
  type ServiceFindings,
} from "./gateway-switch.js";
import { detectInstallKind } from "./install-kind.js";
import { withoutInstallerEnv } from "./installer-env.js";
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

const quietStream = () => new Writable({ write: (_chunk, _enc, cb) => cb() });

/** The definition file exactly as it is (systemd unit, plist, task script). */
async function readRawDefinition(
  definition: ServiceDefinition | null,
  env: NodeJS.ProcessEnv,
): Promise<RawServiceDefinition | null> {
  try {
    let file = definition?.sourcePath ?? null;
    if (!file && process.platform === "win32") {
      // Throws without a home directory in env; no raw file then.
      file = (await import("../daemon/schtasks.js")).resolveTaskScriptPath(env);
    }
    if (!file) {
      return null;
    }
    return { path: file, content: await fs.readFile(file, "utf8") };
  } catch {
    return null;
  }
}

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
    const raw = await readRawDefinition(definition, env);
    const root = definition
      ? await resolveRootFromArgs(definition.programArguments, definition.workingDirectory ?? null)
      : null;
    const runsFrom = await installRefFor(root);
    return {
      label: serviceLabelFor(process.platform),
      definition,
      raw,
      environmentFiles:
        process.platform === "linux" && raw ? parseEnvironmentFiles(raw.content) : [],
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

/** The version a gateway reports over the status RPC (1.5+), and how the RPC went. */
export async function queryGatewayStatus(
  cfg: BitterbotConfig,
  port: number,
  configPort: number,
): Promise<{ version: string | null; rpc: "ok" | "auth" | "error" }> {
  if (port !== configPort) {
    return { version: null, rpc: "error" };
  }
  try {
    const { callGateway } = await import("../gateway/call.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");
    // Probe mode: a refused or torn-down connection is logged at debug level
    // only, so nothing but our own progress lines reach the terminal.
    const status = await callGateway<{ runtime?: { version?: unknown } }>({
      config: cfg,
      method: "status",
      timeoutMs: 3_000,
      clientName: GATEWAY_CLIENT_NAMES.PROBE,
      mode: GATEWAY_CLIENT_MODES.PROBE,
    });
    const version = status?.runtime?.version;
    return {
      version: typeof version === "string" && version !== "dev" ? version : null,
      rpc: "ok",
    };
  } catch (err) {
    const text = String(err instanceof Error ? err.message : err);
    return {
      version: null,
      rpc: /unauthori|forbidden|auth|token|password|1008/i.test(text) ? "auth" : "error",
    };
  }
}

async function queryGatewayVersion(
  cfg: BitterbotConfig,
  port: number,
  configPort: number,
): Promise<string | null> {
  return (await queryGatewayStatus(cfg, port, configPort)).version;
}

/** Process start time, for the pid reuse check (Linux /proc, macOS ps). */
export async function readStartTime(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    const { readProcStartTime } = await import("./tarball-updater.js");
    const t = readProcStartTime(pid);
    return t === null ? null : String(t);
  }
  if (process.platform === "darwin") {
    const res = await run(["ps", "-o", "lstart=", "-p", String(pid)]);
    return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  }
  return null;
}

/**
 * Linux without lsof: the pid owning a LISTEN socket on `port`, from
 * /proc/net/tcp{,6} (socket inode) and /proc/<pid>/fd (who holds it).
 */
export async function findLinuxListenerPid(
  port: number,
  procRoot = "/proc",
): Promise<number | null> {
  const inodes = new Set<string>();
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["tcp", "tcp6"]) {
    const raw = await fs.readFile(path.join(procRoot, "net", table), "utf8").catch(() => "");
    for (const line of raw.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st ... inode (column 9); st 0A = LISTEN
      if (cols[1]?.endsWith(`:${portHex}`) && cols[3] === "0A" && cols[9] && cols[9] !== "0") {
        inodes.add(cols[9]);
      }
    }
  }
  if (inodes.size === 0) {
    return null;
  }
  const pids = (await fs.readdir(procRoot).catch(() => [] as string[])).filter((e) =>
    /^\d+$/.test(e),
  );
  for (const pid of pids) {
    const fdDir = path.join(procRoot, pid, "fd");
    const fds = await fs.readdir(fdDir).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await fs.readlink(path.join(fdDir, fd)).catch(() => "");
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m?.[1] && inodes.has(m[1])) {
        return Number.parseInt(pid, 10);
      }
    }
  }
  return null;
}

/**
 * Is anything listening on `port` on any address, read from the socket table
 * only. Never test-binds the port (inspectPortUsage does when lsof finds
 * nothing): during a switch that could steal the port from a gateway that is
 * starting.
 */
async function hasListenerWithoutBinding(port: number): Promise<boolean> {
  if (process.platform === "linux") {
    return (await findLinuxListenerPid(port)) !== null;
  }
  if (process.platform === "darwin") {
    const res = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }
  return false;
}

async function findListenerPid(
  port: number,
): Promise<{ pid: number | null; command: string | null } | null> {
  const usage = await inspectPortUsage(port);
  if (usage.status !== "busy" && !(await isPortListening(port))) {
    return null;
  }
  const withPid = usage.listeners.filter((l) => typeof l.pid === "number");
  if (withPid.length === 0 && process.platform === "linux") {
    // No lsof (minimal images): read the socket owner from /proc.
    const pid = await findLinuxListenerPid(port);
    if (pid) {
      return { pid, command: (await readProcInfo(pid))?.commandLine ?? null };
    }
  }
  if (withPid.length === 0) {
    return { pid: null, command: null };
  }
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

/** Is there a service manager to install the gateway service with? */
async function hasServiceManager(): Promise<boolean> {
  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }
  if (process.platform === "linux") {
    try {
      return await (await import("../daemon/systemd.js")).isSystemdUserServiceAvailable();
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeProfile(value: string | undefined): string | null {
  const v = value?.trim();
  return v && v.toLowerCase() !== "default" ? v : null;
}

/** The state dir / config / profile an environment selects. */
async function targetFor(env: NodeJS.ProcessEnv, port: number): Promise<GatewayTarget> {
  const { resolveStateDir, resolveConfigPath } = await import("../config/paths.js");
  const stateDir = resolveStateDir(env);
  return {
    stateDir,
    configPath: resolveConfigPath(env, stateDir),
    profile: normalizeProfile(env.BITTERBOT_PROFILE),
    port,
  };
}

/** `env` with the old gateway's state-selecting variables (unset where it had none). */
function withOldSelection(
  env: NodeJS.ProcessEnv,
  old: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of ["BITTERBOT_STATE_DIR", "BITTERBOT_CONFIG_PATH", "BITTERBOT_PROFILE"]) {
    if (old[key] === undefined) {
      delete next[key];
    } else {
      next[key] = old[key];
    }
  }
  return next;
}

/**
 * Why the installed service serves different settings than `env` / `port`
 * (state dir, config, profile, port), or null when they match.
 */
export async function serviceTargetMismatch(
  service: ServiceFindings,
  env: NodeJS.ProcessEnv,
  port: number,
): Promise<string | null> {
  const target = await targetFor(env, port);
  const old = await targetFor(
    withOldSelection(env, service.definition?.environment ?? {}),
    definitionPort(service.definition) ?? port,
  );
  return targetMismatch(target, old);
}

function readTextSafe(file: string): string | null {
  try {
    return fsSync.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

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
  let listenerCwd: string | null = null;
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
      listenerCwd = (await readProcInfo(found.pid))?.cwd ?? null;
      const command = proc.command ?? found.command;
      const underService = Boolean(
        service &&
        ((service.pid && proc.ancestors.includes(service.pid)) ||
          (!service.pid &&
            service.running &&
            proc.root &&
            sameRoot(proc.root, service.runsFrom?.root))),
      );
      // A service-run gateway whose title hides its entry and whose working
      // directory is not its root: it runs what the service definition runs.
      const root = proc.root ?? (underService ? (service?.runsFrom?.root ?? null) : null);
      const isGateway = isBitterbotGatewayCommand(command, Boolean(root));
      const reportedVersion = isGateway ? await queryGatewayVersion(cfg, port, configPort) : null;
      const ref = await installRefFor(root);
      if (ref && reportedVersion) {
        ref.version = reportedVersion;
      }
      listener = {
        pid: found.pid,
        startTime: await readStartTime(found.pid).catch(() => null),
        command,
        isGateway,
        runsFrom: ref,
        reportedVersion,
        isSelf: root
          ? sameRoot(root, self.root)
          : Boolean(reportedVersion && reportedVersion === self.version),
        underService,
        exePath: proc.exe,
        childPids: isGateway ? await listChildPids(found.pid) : [],
      };
    }
  }

  // What the old gateway targets: the service's environment when the service
  // runs it, else the old process's own environment (Linux).
  const target = await targetFor(env, port);
  const listenerOld = Boolean(listener?.isGateway && !listener.isSelf);
  const serviceDefEnv = service?.definition?.environment;
  let oldEnv: Record<string, string> | null = null;
  let oldPort = port;
  if (service && (!listenerOld || listener?.underService)) {
    oldEnv = serviceDefEnv ?? {};
    oldPort = definitionPort(service.definition) ?? port;
  } else if (listenerOld && listener?.pid) {
    oldEnv = process.platform === "linux" ? readProcEnviron(listener.pid) : null;
  }
  const oldTarget = oldEnv ? await targetFor(withOldSelection(env, oldEnv), oldPort) : null;

  // A git clone's .env, which the old gateway loaded from its working directory.
  const oldCwd = listenerOld ? listenerCwd : (service?.definition?.workingDirectory ?? null);
  const envTarget = path.join(target.stateDir, ".env");
  let envMigration: EnvMigration | null = null;
  let sourceEnv: Record<string, string> = {};
  if (oldCwd) {
    const source = path.join(oldCwd, ".env");
    const sourceText = !sameRoot(source, envTarget) ? readTextSafe(source) : null;
    if (sourceText !== null) {
      const plan = planDotEnvMerge(sourceText, readTextSafe(envTarget) ?? "");
      if (plan.keys.length > 0 || plan.skipped.length > 0) {
        envMigration = { source, target: envTarget, keys: plan.keys, skipped: plan.skipped };
      }
      const dotenv = (await import("dotenv")).default;
      sourceEnv = dotenv.parse(sourceText);
    }
  }
  let processOnlyEnv: string[] = [];
  if (listenerOld && !listener?.underService && oldEnv) {
    const dotenv = (await import("dotenv")).default;
    processOnlyEnv = processOnlyEnvNames({
      processEnv: oldEnv,
      known: [sourceEnv, dotenv.parse(readTextSafe(envTarget) ?? ""), serviceDefEnv ?? {}, env],
    });
  }

  const findings: GatewaySwitchFindings = {
    port,
    self,
    service,
    listener,
    remoteMode: cfg.gateway?.mode === "remote",
    serviceManager: service ? true : await hasServiceManager(),
    extraGatewayArgs: cfg.gateway?.mode ? [] : ["--allow-unconfigured"],
    target,
    oldTarget,
    carriedEnv: carriedServiceEnv(serviceDefEnv),
    envMigration,
    processOnlyEnv,
  };
  return { findings, decision: decideGatewaySwitch(findings), config: cfg };
}

/** Environment for a gateway started here: never the installer's per-command variables. */
function backgroundEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = withoutInstallerEnv(env);
  // An install's markers come from its own launcher, never from this process.
  for (const key of [
    "BITTERBOT_INSTALL_KIND",
    "BITTERBOT_INSTALL_ROOT",
    "BITTERBOT_NODE_OPTIONS_READY",
  ]) {
    delete next[key];
  }
  return next;
}

/** Rotate `file` to `file.1` once it passes `maxBytes`, so the log never grows unbounded. */
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    if (fsSync.statSync(file).size > maxBytes) {
      fsSync.renameSync(file, `${file}.1`);
    }
  } catch {
    // no log yet
  }
}

/**
 * Start a gateway detached (only where there is no service manager), logging
 * next to the gateway's other logs (`<state dir>/logs/gateway-switch.log`,
 * rotated at 5 MB).
 */
export function startDetachedGateway(cmd: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logDir?: string;
}): { pid?: number; logPath: string } {
  const [file, ...args] = cmd.argv;
  if (!file) {
    throw new Error("empty command");
  }
  const logDir = cmd.logDir ?? path.join(os.homedir(), ".bitterbot", "logs");
  fsSync.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, "gateway-switch.log");
  rotateLog(logPath);
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

/** The real deps: service manager, signals, ports, the `current` link, snapshot, .env. */
export function createSystemSwitchDeps(params: {
  findings: GatewaySwitchFindings;
  config: BitterbotConfig;
  env?: NodeJS.ProcessEnv;
  askKeepWaiting?: (elapsedMs: number) => Promise<boolean>;
}): GatewaySwitchDeps {
  const env = params.env ?? process.env;
  const { findings, config } = params;
  const service = async () => (await import("../daemon/service.js")).resolveGatewayService();
  const stateDir = findings.target?.stateDir ?? path.join(os.homedir(), ".bitterbot");
  const systemctl = async (args: string[]) => {
    const { execFileUtf8 } = await import("../daemon/exec-file.js");
    const res = await execFileUtf8("systemctl", ["--user", ...args]);
    if (res.code !== 0) {
      throw new Error(`systemctl ${args.join(" ")} failed: ${res.stderr || res.stdout}`.trim());
    }
  };
  const installService = async (definition: ServiceDefinition) => {
    const svc = await service();
    await svc.install({
      env,
      stdout: quietStream(),
      programArguments: definition.programArguments,
      workingDirectory: definition.workingDirectory,
      environment: definition.environment,
    });
    // Keep the old unit's EnvironmentFile= lines (buildSystemdUnit has none).
    const files = findings.service?.environmentFiles ?? [];
    if (process.platform === "linux" && files.length > 0) {
      const { resolveSystemdUserUnitPath } = await import("../daemon/systemd.js");
      const unitPath = resolveSystemdUserUnitPath(env);
      const unit = await fs.readFile(unitPath, "utf8");
      const next = insertEnvironmentFiles(unit, files);
      if (next !== unit) {
        await fs.writeFile(unitPath, next, "utf8");
        await systemctl(["daemon-reload"]);
        await svc.restart({ env, stdout: quietStream() });
      }
    }
  };
  return {
    stopService: async () => {
      await (await service()).stop({ env, stdout: quietStream() });
    },
    installService,
    uninstallService: async () => {
      await (await service()).uninstall({ env, stdout: quietStream() });
    },
    restoreRawDefinition: async (raw, opts) => {
      await fs.writeFile(raw.path, raw.content, "utf8");
      const svc = await service();
      if (process.platform === "linux") {
        await systemctl(["daemon-reload"]);
        if (opts.start) {
          await svc.restart({ env, stdout: quietStream() });
        }
      } else if (process.platform === "darwin") {
        if (opts.start) {
          const { repairLaunchAgentBootstrap } = await import("../daemon/launchd.js");
          const res = await repairLaunchAgentBootstrap({ env });
          if (!res.ok) {
            throw new Error(`launchctl bootstrap failed: ${res.detail ?? "unknown error"}`);
          }
        }
      } else if (opts.start) {
        await svc.restart({ env, stdout: quietStream() });
      }
    },
    serviceRunning: async () => {
      const runtime = await (await service()).readRuntime(env);
      return runtime.status !== "stopped";
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
        // The old service's environment, with this install's plan on top.
        environment: { ...findings.carriedEnv, ...toStringRecord(plan.environment) },
      };
    },
    startDetached: (cmd) => startDetachedGateway({ ...cmd, logDir: path.join(stateDir, "logs") }),
    readCommandLine: async (pid) => (await readProcInfo(pid))?.commandLine ?? null,
    readStartTime,
    listChildren: (pid) => listChildPids(pid),
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
    // A gateway bound to a tailnet or LAN address does not answer on
    // 127.0.0.1: fall back to the socket table.
    isPortListening: async (port) =>
      (await isPortListening(port)) || (await hasListenerWithoutBinding(port)),
    probeGateway: async (port) => {
      const { resolveGatewayPort } = await import("../config/config.js");
      const status = await queryGatewayStatus(config, port, resolveGatewayPort(config, env));
      const found = await findListenerPid(port);
      if (!found?.pid) {
        return { pid: null, version: status.version, root: null, rpc: status.rpc };
      }
      const proc = await resolveProcessRoot(found.pid);
      let root = proc.root;
      if (!root) {
        // Started by the (re-pointed) service: it runs what the service runs.
        const svc = await inspectGatewayService({ self: findings.self, env });
        if (svc?.pid && proc.ancestors.includes(svc.pid)) {
          root = svc.runsFrom?.root ?? null;
        }
      }
      return { pid: found.pid, version: status.version, root, rpc: status.rpc };
    },
    swapCurrentLink: (appDir, version) => swapVersionLink(appDir, "current", version),
    snapshot: async () => {
      const { resolveConfigPath } = await import("../config/paths.js");
      const { resolveAgentWorkspaceDir, resolveDefaultAgentId } =
        await import("../agents/agent-scope.js");
      const { resolveP2pKeyDir } = await import("./p2p-key-dir.js");
      const { createUpdateSnapshot } = await import("./update-snapshot.js");
      let workspaceDir: string | null = null;
      try {
        workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      } catch {
        workspaceDir = null;
      }
      const from =
        (findings.listener?.isGateway && !findings.listener.isSelf
          ? findings.listener.runsFrom?.version
          : findings.service?.runsFrom?.version) ?? null;
      const versionName = (v: string | null | undefined) =>
        v && /^\d+\.\d+\.\d+/.test(v) ? (/^\d+\.\d+\.\d+/.exec(v)?.[0] ?? "0.0.0") : "0.0.0";
      const res = await createUpdateSnapshot({
        sources: {
          stateDir,
          configPath: findings.target?.configPath ?? resolveConfigPath(env, stateDir),
          workspaceDir,
          keyDir: resolveP2pKeyDir(config.p2p?.keyDir),
        },
        from: versionName(from),
        to: versionName(findings.self.version),
        // Unknown for the old version: the restore uses the schema each
        // database had at snapshot time instead.
        fromMemorySchemaLatest: 0,
      });
      return { dir: res.dir };
    },
    restoreSnapshot: async (snap) => {
      const { applySnapshotRestore, planSnapshotRestore, readSnapshotManifest } =
        await import("./update-snapshot.js");
      const manifest = readSnapshotManifest(snap.dir);
      if (!manifest) {
        return [];
      }
      // What the old version knows: the newest schema its databases had.
      const known = manifest.entries
        .map((e) => e.schemaVersion)
        .filter((v): v is number => typeof v === "number");
      const plan = await planSnapshotRestore({
        manifest,
        snapshotDir: snap.dir,
        mode: "auto",
        targetMemorySchemaLatest: known.length > 0 ? Math.max(...known) : Number.MAX_SAFE_INTEGER,
      });
      // The merged .env stays (it only gained keys); see the switch output.
      plan.restore = plan.restore.filter((r) => path.basename(r.entry.file) !== ".env");
      return applySnapshotRestore({ plan, snapshotDir: snap.dir, stateDir, manifest }).restored;
    },
    copyEnv: async (migration) => {
      const res = copyDotEnvKeys({ source: migration.source, target: migration.target });
      return { copied: res.copied, backup: res.backup };
    },
    ...(params.askKeepWaiting ? { askKeepWaiting: params.askKeepWaiting } : {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
