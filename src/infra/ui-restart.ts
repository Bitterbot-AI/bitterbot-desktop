/**
 * Post-update Control-UI restarter: the vite dev server is a SEPARATE process
 * the gateway does not own, and it cannot pick up an applied update on its
 * own — `pnpm install` swaps node_modules under its pre-bundled dep cache,
 * the gateway URL/token are baked in via `define` at server start, and on
 * some filesystems (WSL /mnt/*) its watcher never sees file events at all.
 * The observed failure is a UI silently running stale code against a fresh
 * gateway ("the UI did not match the latest code").
 *
 * So the update flow spawns this small DETACHED process (the boot-watchdog
 * pattern — it must survive the gateway's own SIGUSR1 re-exec) which:
 *
 *   1. Probes the UI port. Not listening → exit. It only ever RESTARTS a UI
 *      that was running; it never starts one the operator didn't run.
 *   2. Finds the listener pid and reads its command line. Anything that is
 *      not identifiably OUR vite (command mentions vite AND this checkout) is
 *      left strictly alone — a stale UI is better than killing a stranger.
 *   3. Terminates it, then waits: `pnpm start:all` supervises the UI child
 *      and respawns it fresh (all-or-nothing was relaxed to
 *      respawn-with-backoff for the UI child, see scripts/start-all.mjs), so
 *      if the port comes back on its own the supervisor owned it and we are
 *      done. Only when nobody brings it back do we respawn `pnpm dev`
 *      ourselves, detached, logging to the state dir.
 *
 * Spawned on a SUCCESSFUL update.run and after an auto-rollback — the two
 * moments the code under the running UI changed. A plain gateway restart
 * changes no code and never touches the UI. Kill switch:
 * `update.uiRestart.enabled = false`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { runCommandWithTimeout } from "../process/exec.js";

export const DEFAULT_UI_PORT = 5173;
/** Give the update RPC response time to reach the (old) UI before killing it. */
const SETTLE_DELAY_MS = 8_000;
/** How long a supervisor (start:all) gets to respawn the UI before we do. */
const SUPERVISOR_WAIT_MS = 20_000;
const TERM_WAIT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const RESPAWN_CONFIRM_MS = 60_000;

export type UiRestartAction =
  | "ui-not-running"
  | "pid-not-found"
  | "identity-mismatch"
  | "kill-failed"
  | "restarted-by-supervisor"
  | "respawned"
  | "respawn-failed";

type RunCommand = (
  argv: string[],
  opts: { timeoutMs: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunCommand: RunCommand = async (argv, opts) => {
  const res = await runCommandWithTimeout(argv, { timeoutMs: opts.timeoutMs, cwd: opts.cwd });
  return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 1 };
};

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(path.join(resolveStateDir(), "ui-restart.log"), line, "utf-8");
  } catch {
    /* logging is best-effort */
  }
}

/** TCP connect probe (the start:all portInUse shape). */
export function probeTcp(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Pure pieces (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Is this command line OUR Control-UI dev server? Two independent anchors:
 * it must mention vite, and it must reference this checkout (any path form —
 * the win32 CIM command line uses backslashes). A grep, an editor, or someone
 * else's vite on the same port never matches; we then refuse to kill.
 */
export function isUiProcessCommand(cmdline: string, root: string): boolean {
  const cmd = cmdline.toLowerCase().replace(/\\/g, "/");
  // `vite` as a path segment, bare word, or entry script — NOT any substring
  // ("vim …/vite.config.ts" holds the word but is not the dev server).
  if (!/(^|[/\s"'])vite(\.m?js|\.cjs)?([/\s"']|$)/.test(cmd)) return false;
  const rootNorm = root.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return rootNorm.length > 0 && cmd.includes(rootNorm);
}

/** `ss -ltnp` line: … users:(("node",pid=19748,fd=23)) */
export function parsePidFromSs(output: string, port: number): number | null {
  for (const line of output.split("\n")) {
    if (!line.includes(`:${port} `) && !line.trimEnd().endsWith(`:${port}`)) continue;
    const m = line.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** `lsof -ti tcp:<port> -sTCP:LISTEN`: one pid per line. */
export function parsePidFromLsof(output: string): number | null {
  const first = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^\d+$/.test(l));
  return first ? Number(first) : null;
}

/** win32 `netstat -ano -p tcp`: `  TCP  0.0.0.0:5173  0.0.0.0:0  LISTENING  12345` */
export function parsePidFromNetstat(output: string, port: number): number | null {
  for (const line of output.split("\n")) {
    if (!line.includes("LISTENING")) continue;
    // Local address column only — `:5173` in the foreign column must not match.
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    const pid = cols[cols.length - 1] ?? "";
    if (/^\d+$/.test(pid)) return Number(pid);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Platform lookups
// ---------------------------------------------------------------------------

async function findListenerPid(params: {
  port: number;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}): Promise<number | null> {
  const { port, platform, runCommand } = params;
  if (platform === "win32") {
    const res = await runCommand(["netstat", "-ano", "-p", "tcp"], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    return res && res.code === 0 ? parsePidFromNetstat(res.stdout, port) : null;
  }
  if (platform === "linux") {
    const ss = await runCommand(["ss", "-ltnp", `sport = :${port}`], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    if (ss && ss.code === 0) {
      const pid = parsePidFromSs(ss.stdout, port);
      if (pid) return pid;
    }
  }
  // macOS, and the Linux fallback when ss is absent or unrevealing.
  const lsof = await runCommand(["lsof", "-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  }).catch(() => null);
  return lsof && lsof.code === 0 ? parsePidFromLsof(lsof.stdout) : null;
}

async function readProcessCommand(params: {
  pid: number;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}): Promise<string | null> {
  const { pid, platform, runCommand } = params;
  if (platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (raw.length > 0) return raw.split("\0").filter(Boolean).join(" ");
    } catch {
      /* fall through to ps */
    }
  }
  if (platform === "win32") {
    const res = await runCommand(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    ).catch(() => null);
    return res && res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  }
  const res = await runCommand(["ps", "-p", String(pid), "-o", "command="], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  }).catch(() => null);
  return res && res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

async function killPid(params: {
  pid: number;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
  force: boolean;
}): Promise<void> {
  const { pid, platform, runCommand, force } = params;
  if (platform === "win32") {
    await runCommand(["taskkill", ...(force ? ["/F"] : []), "/PID", String(pid)], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// The restart sequence
// ---------------------------------------------------------------------------

export type UiRestartDeps = {
  runCommand?: RunCommand;
  probe?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  /** Test seam: never signal a real pid from a test. */
  killImpl?: (pid: number, force: boolean) => Promise<void>;
  /** Test seam: skip the initial settle delay. */
  settleMs?: number;
  supervisorWaitMs?: number;
  termWaitMs?: number;
  respawnConfirmMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => Promise<boolean>,
  totalMs: number,
  sleep: (ms: number) => Promise<void>,
  stepMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * Restart the Control-UI dev server after a code change. Never throws; the
 * returned action is also appended to <stateDir>/ui-restart.log.
 */
export async function runUiRestart(params: {
  root: string;
  reason: string;
  port?: number;
  deps?: UiRestartDeps;
}): Promise<{ action: UiRestartAction; detail: string }> {
  const port = params.port ?? DEFAULT_UI_PORT;
  const deps = params.deps ?? {};
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const probe = deps.probe ?? probeTcp;
  const sleep = deps.sleep ?? defaultSleep;
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const kill =
    deps.killImpl ??
    ((pid: number, force: boolean) => killPid({ pid, platform, runCommand, force }));
  const desktopDir = path.join(params.root, "desktop");

  const finish = (action: UiRestartAction, detail: string) => {
    log(`[${params.reason}] ${action}: ${detail}`);
    return { action, detail };
  };

  await sleep(deps.settleMs ?? SETTLE_DELAY_MS);

  // Restart only what was running.
  if (!(await probe(port))) {
    return finish("ui-not-running", `nothing listening on ${port}; leaving it that way`);
  }

  const pid = await findListenerPid({ port, platform, runCommand });
  if (!pid) {
    return finish(
      "pid-not-found",
      `port ${port} is busy but no listener pid found — not touching it`,
    );
  }

  const cmdline = await readProcessCommand({ pid, platform, runCommand });
  if (!cmdline || !isUiProcessCommand(cmdline, params.root)) {
    return finish(
      "identity-mismatch",
      `pid ${pid} on ${port} is not our vite (${(cmdline ?? "unreadable").slice(0, 160)}) — not touching it`,
    );
  }

  log(`[${params.reason}] stopping stale UI pid ${pid} (${cmdline.slice(0, 160)})`);
  await kill(pid, false);
  let freed = await waitFor(
    async () => !(await probe(port)),
    deps.termWaitMs ?? TERM_WAIT_MS,
    sleep,
  );
  if (!freed) {
    await kill(pid, true);
    freed = await waitFor(async () => !(await probe(port)), deps.termWaitMs ?? TERM_WAIT_MS, sleep);
  }
  if (!freed) {
    return finish("kill-failed", `pid ${pid} still holds ${port} after SIGKILL`);
  }

  // A supervisor (pnpm start:all) respawns its UI child with fresh code; give
  // it first right of refusal so we never end up with two dev servers racing.
  if (await waitFor(() => probe(port), deps.supervisorWaitMs ?? SUPERVISOR_WAIT_MS, sleep, 2000)) {
    return finish("restarted-by-supervisor", `port ${port} came back on its own`);
  }

  // Nobody owns it — respawn detached ourselves, logging to the state dir.
  try {
    const logPath = path.join(resolveStateDir(), "logs");
    fs.mkdirSync(logPath, { recursive: true });
    const out = fs.openSync(path.join(logPath, "control-ui.log"), "a");
    const child = spawnImpl("pnpm", ["dev"], {
      cwd: desktopDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
      // pnpm on Windows is a .cmd shim; the shell resolves it.
      shell: platform === "win32",
    });
    child.on("error", (err) => log(`respawn error: ${String(err)}`));
    child.unref();
    fs.closeSync(out);
  } catch (err) {
    return finish("respawn-failed", `spawn failed: ${String(err)}`);
  }

  const up = await waitFor(
    () => probe(port),
    deps.respawnConfirmMs ?? RESPAWN_CONFIRM_MS,
    sleep,
    2000,
  );
  return up
    ? finish("respawned", `fresh UI listening on ${port}`)
    : finish(
        "respawn-failed",
        `spawned pnpm dev but ${port} never opened — see logs/control-ui.log`,
      );
}

/**
 * Spawn the detached restarter (the spawnBootWatchdog shape). Called from the
 * two code-change paths: a successful update.run, and after an auto-rollback.
 * No-ops when disabled or in tests; a spawn failure degrades to the old
 * behavior (stale UI until manually restarted) rather than harming anything.
 */
export function spawnUiRestarter(params: {
  root: string;
  reason: string;
  enabled: boolean;
}): boolean {
  if (!params.enabled) return false;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  try {
    const child = spawn(
      process.execPath,
      [
        path.join(params.root, "bitterbot.mjs"),
        "ui-restart",
        "--root",
        params.root,
        "--reason",
        params.reason,
      ],
      {
        detached: true,
        stdio: "ignore",
        cwd: params.root,
        env: process.env,
      },
    );
    child.on("error", (err) => log(`restarter spawn error: ${String(err)}`));
    child.unref();
    log(`spawned ui-restarter pid=${child.pid ?? "?"} (${params.reason})`);
    return true;
  } catch (err) {
    log(`failed to spawn ui-restarter: ${String(err)}`);
    return false;
  }
}
