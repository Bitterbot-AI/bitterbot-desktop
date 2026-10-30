/**
 * On-disk state shared by the WSL supervisor backend (install/status) and the
 * supervisor process itself: the recorded command, the single-instance lock,
 * the pid file, the exits log and the daily gateway logs. Everything lives
 * under the state dir (~/.bitterbot by default), nothing root-owned.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveGatewayStateDir } from "./paths.js";
import {
  isSupervisorLockStale,
  parseSupervisorLockPayload,
  selectLogFilesToPrune,
  SUPERVISOR_LOG_KEEP,
  supervisorLogFileName,
} from "./wsl-supervisor-policy.js";

export const DEFAULT_ORCHESTRATOR_SOCKET = "/tmp/bitterbot-orchestrator.sock";

export type WslSupervisorPaths = {
  stateDir: string;
  runDir: string;
  logDir: string;
  recordPath: string;
  lockPath: string;
  pidPath: string;
  exitsLogPath: string;
};

export function resolveWslSupervisorPaths(
  env: Record<string, string | undefined>,
): WslSupervisorPaths {
  const stateDir = resolveGatewayStateDir(env);
  const runDir = path.join(stateDir, "run");
  const logDir = path.join(stateDir, "logs");
  return {
    stateDir,
    runDir,
    logDir,
    recordPath: path.join(runDir, "gateway-supervisor.json"),
    lockPath: path.join(runDir, "gateway-supervisor.lock"),
    pidPath: path.join(runDir, "gateway-supervisor.pid"),
    exitsLogPath: path.join(logDir, "gateway-exits.log"),
  };
}

/** What `bitterbot gateway install` recorded for the supervisor to run. */
export type WslSupervisorRecord = {
  version: 1;
  createdAt: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  taskName?: string;
  distro?: string;
  launcherPath?: string;
  description?: string;
};

export async function readWslSupervisorRecord(
  env: Record<string, string | undefined>,
): Promise<WslSupervisorRecord | null> {
  const { recordPath } = resolveWslSupervisorPaths(env);
  try {
    const raw = await fs.readFile(recordPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WslSupervisorRecord>;
    if (!Array.isArray(parsed.programArguments) || parsed.programArguments.length === 0) {
      return null;
    }
    return {
      version: 1,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      programArguments: parsed.programArguments.map(String),
      ...(parsed.workingDirectory ? { workingDirectory: String(parsed.workingDirectory) } : {}),
      ...(parsed.environment && typeof parsed.environment === "object"
        ? { environment: parsed.environment as Record<string, string> }
        : {}),
      ...(parsed.taskName ? { taskName: String(parsed.taskName) } : {}),
      ...(parsed.distro ? { distro: String(parsed.distro) } : {}),
      ...(parsed.launcherPath ? { launcherPath: String(parsed.launcherPath) } : {}),
      ...(parsed.description ? { description: String(parsed.description) } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeWslSupervisorRecord(
  env: Record<string, string | undefined>,
  record: Omit<WslSupervisorRecord, "version" | "createdAt">,
): Promise<string> {
  const { recordPath, runDir } = resolveWslSupervisorPaths(env);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const environment = record.environment
    ? Object.fromEntries(
        Object.entries(record.environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
        ),
      )
    : undefined;
  const payload: WslSupervisorRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    ...record,
    ...(environment ? { environment } : {}),
  };
  await fs.writeFile(recordPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return recordPath;
}

export async function removeWslSupervisorRecord(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const { recordPath } = resolveWslSupervisorPaths(env);
  try {
    await fs.unlink(recordPath);
    return true;
  } catch {
    return false;
  }
}

/** The supervisor pid when one is alive, else null (clears a stale pid file). */
export async function readSupervisorPid(
  env: Record<string, string | undefined>,
  deps: { isPidAlive?: (pid: number) => boolean } = {},
): Promise<number | null> {
  const alive = deps.isPidAlive ?? isPidAlive;
  const { lockPath, pidPath } = resolveWslSupervisorPaths(env);
  for (const file of [lockPath, pidPath]) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const payload = parseSupervisorLockPayload(raw) ?? parsePidFile(raw);
    if (payload && alive(payload.pid)) {
      return payload.pid;
    }
  }
  return null;
}

function parsePidFile(raw: string): { pid: number; createdAt: string } | null {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? { pid, createdAt: "" } : null;
}

export type SupervisorLockHandle = { lockPath: string; release: () => Promise<void> };

/**
 * Single instance: create the lock exclusively; a lock whose owner is dead is
 * removed and retried once. Returns null when a live supervisor holds it.
 */
export async function acquireSupervisorLock(
  env: Record<string, string | undefined>,
  deps: { isPidAlive?: (pid: number) => boolean; selfPid?: number } = {},
): Promise<SupervisorLockHandle | { held: true; pid: number | null }> {
  const alive = deps.isPidAlive ?? isPidAlive;
  const selfPid = deps.selfPid ?? process.pid;
  const { lockPath, pidPath, runDir } = resolveWslSupervisorPaths(env);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      const payload = { pid: selfPid, createdAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(payload), "utf8");
      await handle.close();
      await fs.writeFile(pidPath, `${selfPid}\n`, { encoding: "utf8", mode: 0o600 });
      return {
        lockPath,
        release: async () => {
          await fs.rm(lockPath, { force: true });
          await fs.rm(pidPath, { force: true });
        },
      };
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") {
        throw err;
      }
      const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
      const payload = parseSupervisorLockPayload(raw);
      if (isSupervisorLockStale({ payload, isPidAlive: alive, selfPid })) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      return { held: true, pid: payload?.pid ?? null };
    }
  }
  return { held: true, pid: null };
}

export async function removeSupervisorLockFiles(
  env: Record<string, string | undefined>,
): Promise<void> {
  const { lockPath, pidPath } = resolveWslSupervisorPaths(env);
  await fs.rm(lockPath, { force: true });
  await fs.rm(pidPath, { force: true });
}

export async function appendExitLogLine(
  env: Record<string, string | undefined>,
  line: string,
): Promise<void> {
  const { exitsLogPath, logDir } = resolveWslSupervisorPaths(env);
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(exitsLogPath, `${line}\n`, "utf8");
}

export async function readLastExitLogLines(
  env: Record<string, string | undefined>,
  count = 3,
): Promise<string[]> {
  const { exitsLogPath } = resolveWslSupervisorPaths(env);
  try {
    const raw = await fs.readFile(exitsLogPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-count);
  } catch {
    return [];
  }
}

/**
 * Appends child output to gateway-<YYYYMMDD>.log, opening a new file when the
 * calendar day changes and keeping only the newest 14 daily files.
 */
export class DailyGatewayLog {
  private stream: fsSync.WriteStream | null = null;
  private currentName: string | null = null;

  constructor(
    private readonly logDir: string,
    private readonly deps: { now?: () => Date; keep?: number } = {},
  ) {}

  currentPath(): string | null {
    return this.currentName ? path.join(this.logDir, this.currentName) : null;
  }

  write(chunk: string | Buffer): void {
    const stream = this.ensureStream();
    stream.write(chunk);
  }

  line(text: string): void {
    const time = (this.deps.now ?? (() => new Date()))().toISOString();
    this.write(`${time} [supervisor] ${text}\n`);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
    this.currentName = null;
  }

  private ensureStream(): fsSync.WriteStream {
    const name = supervisorLogFileName((this.deps.now ?? (() => new Date()))());
    if (this.stream && this.currentName === name) {
      return this.stream;
    }
    this.stream?.end();
    const previous = this.currentName;
    fsSync.mkdirSync(this.logDir, { recursive: true });
    this.stream = fsSync.createWriteStream(path.join(this.logDir, name), { flags: "a" });
    // An unwritable log must not take the supervisor down with it.
    this.stream.on("error", () => undefined);
    this.currentName = name;
    this.prune([name, ...(previous ? [previous] : [])]);
    return this.stream;
  }

  /** `pending` names files whose streams may not have hit the disk yet. */
  private prune(pending: string[]): void {
    try {
      const names = Array.from(new Set([...fsSync.readdirSync(this.logDir), ...pending]));
      for (const stale of selectLogFilesToPrune(names, this.deps.keep ?? SUPERVISOR_LOG_KEEP)) {
        fsSync.rmSync(path.join(this.logDir, stale), { force: true });
      }
    } catch {
      // never fail the supervisor over log housekeeping
    }
  }
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function isPortOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Remove a leftover orchestrator socket only when no process holds it (a
 * connect attempt is refused). A socket that answers belongs to a live
 * orchestrator and is left alone.
 */
export async function removeStaleOrchestratorSocket(
  socketPath: string = DEFAULT_ORCHESTRATOR_SOCKET,
  deps: {
    existsSync?: (p: string) => boolean;
    probe?: (p: string) => Promise<"open" | "refused">;
  } = {},
): Promise<boolean> {
  const existsSync = deps.existsSync ?? fsSync.existsSync;
  if (!existsSync(socketPath)) {
    return false;
  }
  const probe = deps.probe ?? probeUnixSocket;
  if ((await probe(socketPath)) === "open") {
    return false;
  }
  await fs.rm(socketPath, { force: true });
  return true;
}

function probeUnixSocket(socketPath: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (value: "open" | "refused") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("open"));
    socket.once("error", () => done("refused"));
  });
}
