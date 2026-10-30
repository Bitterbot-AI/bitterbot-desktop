/**
 * GatewayService backend for WSL2 distros without a systemd user bus
 * (`init(Ubuntu)` as PID 1, `systemctl --user` fails with "Failed to connect
 * to bus"). Nothing here is root-owned: the supervisor state lives under the
 * state dir, and the boot trigger is a Windows scheduled task for the current
 * Windows user that runs `wsl.exe -d <distro> -u <user> -- <launcher> gateway
 * supervise` at logon. The supervisor (src/cli/gateway-cli/supervise.ts)
 * spawns and relaunches the gateway and adopts one that is already running.
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { readGatewayLockOwner } from "../infra/gateway-lock.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine } from "./output.js";
import { execSchtasks } from "./schtasks-exec.js";
import { parseSchtasksQuery } from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import {
  type ExecFn,
  readWindowsTempDir,
  readWindowsUser,
  renderNoInteropHints,
  resolveWindowsInterop,
  resolveWslDistroName,
  toWindowsPath,
  type WindowsInterop,
} from "./wsl-interop.js";
import {
  resolveLauncherFromProgramArguments,
  resolveSupervisedPort,
} from "./wsl-supervisor-policy.js";

export { resolveLauncherFromProgramArguments, resolveSupervisedPort };
import {
  isPortOpen,
  readLastExitLogLines,
  readSupervisorPid,
  readWslSupervisorRecord,
  removeSupervisorLockFiles,
  removeWslSupervisorRecord,
  resolveWslSupervisorPaths,
  type WslSupervisorRecord,
  writeWslSupervisorRecord,
} from "./wsl-supervisor-record.js";
import { buildWslTaskXml, encodeTaskXmlUtf16, resolveWslTaskName } from "./wsl-task-xml.js";

export const WSL_SUPERVISOR_LABEL = "wsl-supervisor";
const STOP_WAIT_MS = 60_000;

export type WslSupervisorDeps = {
  exec?: ExecFn;
  existsSync?: (p: string) => boolean;
  isPidAlive?: (pid: number) => boolean;
  /** Start the supervisor detached; returns its pid. */
  spawnDetached?: (
    command: string,
    args: string[],
    opts: { env: Record<string, string | undefined>; cwd?: string },
  ) => number | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isPortOpen?: (port: number) => Promise<boolean>;
  readGatewayLockOwner?: typeof readGatewayLockOwner;
  writeFile?: (p: string, data: Buffer) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  processEnv?: Record<string, string | undefined>;
  /** The program the supervisor is started with when none can be derived. */
  selfLauncher?: () => string[];
};

function defaultSpawnDetached(
  command: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
): number | null {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: opts.env as NodeJS.ProcessEnv,
    cwd: opts.cwd,
  });
  child.unref();
  return child.pid ?? null;
}

function resolveDeps(deps: WslSupervisorDeps) {
  return {
    exec: deps.exec ?? ((command: string, args: string[]) => execFileUtf8(command, args)),
    existsSync: deps.existsSync ?? fsSync.existsSync,
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    spawnDetached: deps.spawnDetached ?? defaultSpawnDetached,
    kill: deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal)),
    isPortOpen: deps.isPortOpen ?? isPortOpen,
    readGatewayLockOwner: deps.readGatewayLockOwner ?? readGatewayLockOwner,
    writeFile: deps.writeFile ?? ((p: string, data: Buffer) => fs.writeFile(p, data)),
    unlink: deps.unlink ?? ((p: string) => fs.unlink(p)),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    processEnv: deps.processEnv ?? (process.env as Record<string, string | undefined>),
    selfLauncher: deps.selfLauncher ?? (() => [process.execPath, process.argv[1] ?? ""]),
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

function supervisorSpawnEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = { ...env };
  // The launcher sets its own install root; entry.js re-execs itself unless
  // this marker is dropped (same as process-respawn.ts).
  delete out.BITTERBOT_INSTALL_ROOT;
  delete out.BITTERBOT_NODE_OPTIONS_READY;
  return out;
}

async function startSupervisor(
  env: Record<string, string | undefined>,
  record: Pick<WslSupervisorRecord, "programArguments" | "workingDirectory">,
  stdout: NodeJS.WritableStream,
  d: Resolved,
): Promise<number | null> {
  const running = await readSupervisorPid(env, { isPidAlive: d.isPidAlive });
  if (running) {
    stdout.write(`${formatLine("Supervisor already running", `pid ${running}`)}\n`);
    return running;
  }
  const launcher = resolveLauncherFromProgramArguments(record.programArguments);
  const program = launcher.length > 0 && d.existsSync(launcher[0]) ? launcher : d.selfLauncher();
  const pid = d.spawnDetached(program[0], [...program.slice(1), "gateway", "supervise"], {
    env: supervisorSpawnEnv({ ...d.processEnv, ...pickProfileEnv(env) }),
    cwd: record.workingDirectory ?? env.HOME,
  });
  stdout.write(`${formatLine("Started gateway supervisor", pid ? `pid ${pid}` : "spawned")}\n`);
  return pid;
}

function pickProfileEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const key of ["BITTERBOT_PROFILE", "BITTERBOT_STATE_DIR", "BITTERBOT_CONFIG_PATH", "HOME"]) {
    if (env[key]) {
      out[key] = env[key];
    }
  }
  return out;
}

async function stopSupervisor(
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
  d: Resolved,
): Promise<boolean> {
  const pid = await readSupervisorPid(env, { isPidAlive: d.isPidAlive });
  if (!pid) {
    stdout.write("Gateway supervisor not running.\n");
    return false;
  }
  try {
    d.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < STOP_WAIT_MS && d.isPidAlive(pid)) {
    await d.sleep(250);
  }
  if (d.isPidAlive(pid)) {
    throw new Error(`gateway supervisor (pid ${pid}) did not exit within ${STOP_WAIT_MS / 1000}s`);
  }
  stdout.write(`${formatLine("Stopped gateway supervisor", `pid ${pid}`)}\n`);
  return true;
}

type TaskRegistration = {
  interop: WindowsInterop;
  taskName: string;
  xml: string;
  windowsUser: string;
  xmlLinuxPath: string | null;
  xmlWindowsPath: string | null;
};

async function prepareTask(params: {
  env: Record<string, string | undefined>;
  launcher: string[];
  description: string;
  d: Resolved;
  dryRun: boolean;
}): Promise<{ registration: TaskRegistration | null; warnings: string[] }> {
  const { env, d } = params;
  const interop = resolveWindowsInterop({ env, existsSync: d.existsSync });
  if (!interop) {
    return { registration: null, warnings: renderNoInteropHints() };
  }
  const distro = resolveWslDistroName(env) ?? "Ubuntu";
  const linuxUser =
    env.USER?.trim() || env.LOGNAME?.trim() || path.basename(env.HOME ?? "") || "user";
  const windowsUser =
    (await readWindowsUser(interop, d.exec)) ?? (params.dryRun ? "<windows-user>" : null);
  if (!windowsUser) {
    return {
      registration: null,
      warnings: [
        "Could not read the Windows user name (cmd.exe /c echo %USERNAME%); no logon task registered.",
      ],
    };
  }
  const taskName = resolveWslTaskName(distro, env.BITTERBOT_PROFILE);
  const xml = buildWslTaskXml({
    taskName,
    description: `${params.description}: starts the WSL gateway supervisor at logon`,
    windowsUser,
    distro,
    linuxUser,
    launcher: params.launcher,
    wslExe: "C:\\Windows\\System32\\wsl.exe",
  });
  const temp = await readWindowsTempDir(interop, d.exec);
  const fileName = `bitterbot-gateway-task-${process.pid}.xml`;
  const xmlLinuxPath = temp ? path.posix.join(temp.linux, fileName) : null;
  const xmlWindowsPath =
    xmlLinuxPath === null
      ? null
      : ((await toWindowsPath(xmlLinuxPath, d.exec)) ??
        (params.dryRun ? `${temp?.windows ?? "%TEMP%"}\\${fileName}` : null));
  if (!params.dryRun && (!xmlLinuxPath || !xmlWindowsPath)) {
    return {
      registration: null,
      warnings: [
        "Could not resolve a Windows-visible temp path for the task XML (cmd.exe /c echo %TEMP%, wslpath); no logon task registered.",
        `Register it later with: ${formatCliCommand("bitterbot gateway install --force")}`,
      ],
    };
  }
  return {
    registration: { interop, taskName, xml, windowsUser, xmlLinuxPath, xmlWindowsPath },
    warnings: [],
  };
}

async function registerTask(reg: TaskRegistration, d: Resolved): Promise<void> {
  if (!reg.xmlLinuxPath || !reg.xmlWindowsPath) {
    throw new Error(
      "could not resolve a Windows-visible temp path for the task XML (cmd.exe /c echo %TEMP%, wslpath)",
    );
  }
  await d.writeFile(reg.xmlLinuxPath, encodeTaskXmlUtf16(reg.xml));
  try {
    const res = await execSchtasks(
      ["/Create", "/F", "/TN", reg.taskName, "/XML", reg.xmlWindowsPath],
      {
        executable: reg.interop.schtasksExe,
        exec: d.exec,
      },
    );
    if (res.code !== 0) {
      throw new Error(`schtasks create failed: ${(res.stderr || res.stdout).trim()}`);
    }
  } finally {
    await d.unlink(reg.xmlLinuxPath).catch(() => undefined);
  }
}

async function queryTask(
  env: Record<string, string | undefined>,
  d: Resolved,
): Promise<{
  registered: boolean | null;
  detail?: string;
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
}> {
  const interop = resolveWindowsInterop({ env, existsSync: d.existsSync });
  if (!interop) {
    return { registered: null, detail: "no Windows interop" };
  }
  const distro = resolveWslDistroName(env) ?? "Ubuntu";
  const taskName = resolveWslTaskName(distro, env.BITTERBOT_PROFILE);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"], {
    executable: interop.schtasksExe,
    exec: d.exec,
  });
  if (res.code !== 0) {
    return { registered: false, detail: (res.stderr || res.stdout).trim() || undefined };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  return { registered: true, ...parsed };
}

function describeDryRun(
  reg: TaskRegistration | null,
  launcher: string[],
  recordPath: string,
  stdout: NodeJS.WritableStream,
) {
  stdout.write("Dry run: nothing was written, registered or started.\n\n");
  stdout.write(`${formatLine("Would record command", recordPath)}\n`);
  if (reg) {
    stdout.write(`${formatLine("Would write task XML", reg.xmlLinuxPath ?? "<temp>")}\n`);
    stdout.write(
      `${formatLine("Would run", `${reg.interop.schtasksExe} /Create /F /TN "${reg.taskName}" /XML "${reg.xmlWindowsPath ?? "<temp>"}"`)}\n`,
    );
    stdout.write(`${formatLine("Would delete", reg.xmlLinuxPath ?? "<temp>")}\n`);
  } else {
    stdout.write("Would register no logon task (Windows interop not reachable).\n");
  }
  stdout.write(
    `${formatLine("Would start", `${[...launcher, "gateway", "supervise"].join(" ")} (detached)`)}\n`,
  );
  if (reg) {
    stdout.write(`\nTask XML (${reg.taskName}):\n${reg.xml}`);
  }
}

export async function installWslSupervisor(
  args: GatewayServiceInstallArgs,
  deps: WslSupervisorDeps = {},
): Promise<{ recordPath: string; taskName: string | null; supervisorPid: number | null }> {
  const d = resolveDeps(deps);
  const { env, stdout } = args;
  const dryRun = args.dryRun === true;
  const launcher = resolveLauncherFromProgramArguments(args.programArguments);
  if (launcher.length === 0) {
    throw new Error("programArguments must name the gateway launcher");
  }
  const description = resolveGatewayServiceDescription({
    env,
    environment: args.environment,
    description: args.description,
  });
  const { recordPath } = resolveWslSupervisorPaths(env);
  const { registration, warnings } = await prepareTask({ env, launcher, description, d, dryRun });

  if (dryRun) {
    describeDryRun(registration, launcher, recordPath, stdout);
    for (const warning of warnings) {
      stdout.write(`${warning}\n`);
    }
    return { recordPath, taskName: registration?.taskName ?? null, supervisorPid: null };
  }

  const environment = args.environment
    ? Object.fromEntries(
        Object.entries(args.environment).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : undefined;
  await writeWslSupervisorRecord(env, {
    programArguments: args.programArguments,
    workingDirectory: args.workingDirectory,
    environment,
    taskName: registration?.taskName,
    distro: resolveWslDistroName(env) ?? undefined,
    launcherPath: launcher[0],
    description,
  });
  stdout.write("\n");
  stdout.write(`${formatLine("Recorded supervisor command", recordPath)}\n`);

  let taskName: string | null = null;
  if (registration) {
    await registerTask(registration, d);
    taskName = registration.taskName;
    stdout.write(`${formatLine("Registered logon task", taskName)}\n`);
  } else {
    for (const warning of warnings) {
      stdout.write(`${warning}\n`);
    }
  }

  const supervisorPid = await startSupervisor(env, args, stdout, d);
  return { recordPath, taskName, supervisorPid };
}

export async function readWslSupervisorRuntime(
  env: Record<string, string | undefined>,
  deps: WslSupervisorDeps = {},
): Promise<GatewayServiceRuntime> {
  const d = resolveDeps(deps);
  const record = await readWslSupervisorRecord(env);
  const supervisorPid = await readSupervisorPid(env, { isPidAlive: d.isPidAlive });
  const task = await queryTask(env, d);
  if (!record && !supervisorPid && task.registered !== true) {
    return { status: "stopped", missingUnit: true, detail: "supervisor not installed" };
  }
  const gatewayEnv = { ...env, ...record?.environment };
  const owner = await d
    .readGatewayLockOwner({ env: gatewayEnv as NodeJS.ProcessEnv })
    .catch(() => null);
  const gatewayPid =
    owner && (owner.status === "alive" || owner.status === "unknown") ? owner.pid : null;
  const effectivePort = resolveSupervisedPort(
    record?.programArguments,
    gatewayEnv.BITTERBOT_GATEWAY_PORT,
  );
  const portOpen = await d.isPortOpen(effectivePort).catch(() => false);
  const gatewayRunning = gatewayPid !== null || portOpen;
  const exits = await readLastExitLogLines(env, 3);

  const lines: string[] = [
    supervisorPid ? `Supervisor: pid ${supervisorPid}` : "Supervisor: not running",
    gatewayPid
      ? `Gateway: pid ${gatewayPid} (holds the gateway lock)`
      : portOpen
        ? "Gateway: not holding the lock, but something answers on the port"
        : "Gateway: not running",
    `Port ${effectivePort}: ${portOpen ? "listening" : "closed"}`,
    task.registered === null
      ? `Logon task: unknown (${task.detail ?? "no Windows interop"})`
      : task.registered
        ? `Logon task: ${task.status ?? "registered"}${task.lastRunTime ? `, last run ${task.lastRunTime}` : ""}${task.lastRunResult ? ` (${task.lastRunResult})` : ""}`
        : "Logon task: not registered",
  ];
  if (exits.length > 0) {
    lines.push("Last exits:", ...exits.map((line) => `  ${line}`));
  }
  return {
    status: gatewayRunning ? "running" : "stopped",
    state: supervisorPid ? "supervised" : "unsupervised",
    pid: gatewayPid ?? undefined,
    lastRunTime: task.lastRunTime,
    lastRunResult: task.lastRunResult,
    lines,
  };
}

export function createWslSupervisorService(deps: WslSupervisorDeps = {}): GatewayService {
  const d = resolveDeps(deps);
  return {
    label: WSL_SUPERVISOR_LABEL,
    loadedText: "installed",
    notLoadedText: "not installed",
    supportsDryRun: true,
    install: async (args) => {
      await installWslSupervisor(args, deps);
    },
    uninstall: async ({ env, stdout }) => {
      const task = await queryTask(env, d);
      if (task.registered) {
        const interop = resolveWindowsInterop({ env, existsSync: d.existsSync });
        const distro = resolveWslDistroName(env) ?? "Ubuntu";
        const taskName = resolveWslTaskName(distro, env.BITTERBOT_PROFILE);
        const res = await execSchtasks(["/Delete", "/F", "/TN", taskName], {
          executable: interop?.schtasksExe,
          exec: d.exec,
        });
        if (res.code !== 0) {
          throw new Error(`schtasks delete failed: ${(res.stderr || res.stdout).trim()}`);
        }
        stdout.write(`${formatLine("Removed logon task", taskName)}\n`);
      }
      await removeSupervisorLockFiles(env);
      const removed = await removeWslSupervisorRecord(env);
      const { recordPath } = resolveWslSupervisorPaths(env);
      stdout.write(
        removed
          ? `${formatLine("Removed supervisor command", recordPath)}\n`
          : `Supervisor command not found at ${recordPath}\n`,
      );
    },
    stop: async ({ env, stdout }) => {
      await stopSupervisor(env ?? d.processEnv, stdout, d);
    },
    restart: async ({ env, stdout }) => {
      const effectiveEnv = env ?? d.processEnv;
      await stopSupervisor(effectiveEnv, stdout, d);
      const record = await readWslSupervisorRecord(effectiveEnv);
      if (!record) {
        throw new Error("no recorded supervisor command; run `bitterbot gateway install` first");
      }
      await startSupervisor(effectiveEnv, record, stdout, d);
    },
    isLoaded: async ({ env }) => {
      const effectiveEnv = env ?? d.processEnv;
      if (await readSupervisorPid(effectiveEnv, { isPidAlive: d.isPidAlive })) {
        return true;
      }
      const task = await queryTask(effectiveEnv, d);
      return task.registered === true;
    },
    readCommand: async (env) => {
      const record = await readWslSupervisorRecord(env);
      if (!record) {
        return null;
      }
      return {
        programArguments: record.programArguments,
        workingDirectory: record.workingDirectory,
        environment: record.environment,
        sourcePath: resolveWslSupervisorPaths(env).recordPath,
      };
    },
    readRuntime: async (env) => await readWslSupervisorRuntime(env, deps),
  };
}
