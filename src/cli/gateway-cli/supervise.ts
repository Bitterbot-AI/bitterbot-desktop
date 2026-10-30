/**
 * `bitterbot gateway supervise`: the process the WSL logon task runs. It
 * spawns the recorded gateway command, relaunches it after crashes with a
 * backoff, logs child output to ~/.bitterbot/logs/gateway-<YYYYMMDD>.log and
 * one line per exit to gateway-exits.log, and adopts a gateway that is already
 * running (started by hand, or the child of a SIGUSR1 full-process restart)
 * instead of fighting it for the lock. Decisions live in
 * src/daemon/wsl-supervisor-policy.ts; this file is the I/O around them.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fsSync from "node:fs";
import type { Readable } from "node:stream";
import {
  decideAdoptionPoll,
  resolveLauncherFromProgramArguments,
  resolveSupervisedPort,
  decideAfterExit,
  decideAfterHandoffGrace,
  describeExit,
  formatExitLogLine,
  initialSupervisorState,
  SUPERVISOR_ADOPTION_POLL_MS,
  type SupervisorState,
} from "../../daemon/wsl-supervisor-policy.js";
import {
  acquireSupervisorLock,
  appendExitLogLine,
  DailyGatewayLog,
  isPortOpen,
  readWslSupervisorRecord,
  removeStaleOrchestratorSocket,
  resolveWslSupervisorPaths,
  type SupervisorLockHandle,
  type WslSupervisorRecord,
} from "../../daemon/wsl-supervisor-record.js";
import { readGatewayLockOwner } from "../../infra/gateway-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { isPidAlive } from "../../shared/pid-alive.js";

const log = createSubsystemLogger("gateway/supervisor");
const CHILD_STOP_TIMEOUT_MS = 45_000;

export type SupervisedChild = {
  pid?: number;
  stdout?: Readable | null;
  stderr?: Readable | null;
  once: (
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => unknown;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type SupervisedCommand = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
};

export type SuperviseDeps = {
  env: Record<string, string | undefined>;
  spawn: (cmd: SupervisedCommand) => SupervisedChild;
  readRecord: () => Promise<WslSupervisorRecord | null>;
  acquireLock: () => Promise<SupervisorLockHandle | { held: true; pid: number | null }>;
  probeGateway: () => Promise<{ lockHeld: boolean; portOpen: boolean; pid: number | null }>;
  removeStaleOrchestratorSocket: () => Promise<boolean>;
  appendExitLine: (line: string) => Promise<void>;
  logger: {
    write: (chunk: string | Buffer) => void;
    line: (text: string) => void;
    close: () => void;
  };
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  /** Resolves after ms, or earlier when `cancel` resolves. */
  sleep: (ms: number, cancel: Promise<void>) => Promise<void>;
  pollMs?: number;
  /** Override for tests (default from the policy). */
  graceMs?: number;
  resolveCommand: (record: WslSupervisorRecord) => SupervisedCommand;
};

/** The program to spawn: the recorded launcher when it still exists, else a fallback. */
export function resolveSupervisedCommand(
  record: WslSupervisorRecord,
  opts: {
    env: Record<string, string | undefined>;
    execPath: string;
    argv1: string;
    existsSync: (p: string) => boolean;
  },
): SupervisedCommand {
  const idx = record.programArguments.indexOf("gateway");
  const gatewayArgs = idx >= 0 ? record.programArguments.slice(idx) : ["gateway"];
  const recorded = resolveLauncherFromProgramArguments(record.programArguments);
  let program = recorded;
  if (recorded.length === 0 || !opts.existsSync(recorded[0])) {
    const fromRoot = resolveLauncherFromInstallRoot(
      opts.env.BITTERBOT_INSTALL_ROOT,
      opts.existsSync,
    );
    program = fromRoot ? [fromRoot] : [opts.execPath, opts.argv1];
  }
  const env: Record<string, string | undefined> = { ...opts.env, ...record.environment };
  if (program[0].endsWith("/bin/bitterbot")) {
    // The launcher sets its own install root; entry.js re-execs itself unless
    // this marker is dropped (same as process-respawn.ts).
    delete env.BITTERBOT_INSTALL_ROOT;
    delete env.BITTERBOT_NODE_OPTIONS_READY;
  }
  return {
    command: program[0],
    args: [...program.slice(1), ...gatewayArgs],
    cwd: record.workingDirectory ?? env.HOME,
    env,
  };
}

/** <root>/../current/bin/bitterbot (release install) or <root>/bin/bitterbot. */
function resolveLauncherFromInstallRoot(
  root: string | undefined,
  existsSync: (p: string) => boolean,
): string | null {
  const trimmed = root?.trim();
  if (!trimmed) {
    return null;
  }
  const parent = trimmed.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  for (const candidate of [`${parent}/current/bin/bitterbot`, `${trimmed}/bin/bitterbot`]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForExit(
  child: SupervisedChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * The supervisor loop. Returns the process exit code. SIGTERM/SIGINT forward
 * a graceful stop to the child (or the adopted gateway) and end the loop
 * without a relaunch.
 */
export async function runGatewaySupervisor(deps: SuperviseDeps): Promise<number> {
  const lock = await deps.acquireLock();
  if ("held" in lock) {
    deps.logger.line(
      `another supervisor is already running (pid ${lock.pid ?? "unknown"}); exiting`,
    );
    return 0;
  }
  const pollMs = deps.pollMs ?? SUPERVISOR_ADOPTION_POLL_MS;
  let state: SupervisorState = initialSupervisorState();
  let child: SupervisedChild | null = null;
  let adoptedPid: number | null = null;
  let stopRequested = false;
  let cancelSleep: () => void = () => undefined;
  // Resolved by the signal handler so backoff and grace waits end at once.
  const cancel = new Promise<void>((resolve) => {
    cancelSleep = resolve;
  });
  const wait = (ms: number) => deps.sleep(ms, cancel);

  const detachSignals = deps.onSignal((signal) => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    state = { ...state, stopping: true };
    deps.logger.line(`received ${signal}; stopping the gateway and exiting without relaunch`);
    if (child) {
      child.kill("SIGTERM");
    } else if (adoptedPid) {
      try {
        deps.kill(adoptedPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    cancelSleep();
  });

  let waitingLogged = false;
  try {
    while (!stopRequested) {
      const probe = await deps.probeGateway();
      const adoption = decideAdoptionPoll(probe, state);
      if (adoption.action === "keep-waiting") {
        adoptedPid = probe.pid;
        if (!waitingLogged) {
          deps.logger.line(
            `waiting on an externally started gateway (pid ${probe.pid ?? "unknown"}, lock ${probe.lockHeld ? "held" : "free"}, port ${probe.portOpen ? "open" : "closed"}); will take over when it exits`,
          );
          waitingLogged = true;
        }
        await wait(pollMs);
        continue;
      }
      if (waitingLogged) {
        deps.logger.line(adoption.reason);
        waitingLogged = false;
        adoptedPid = null;
        state = adoption.state;
      }

      const record = await deps.readRecord();
      if (!record) {
        deps.logger.line(
          "no recorded gateway command; run `bitterbot gateway install` first; exiting",
        );
        return 1;
      }
      if (await deps.removeStaleOrchestratorSocket()) {
        deps.logger.line("removed a stale orchestrator socket nobody was holding");
      }
      const command = deps.resolveCommand(record);
      const startedAt = deps.now();
      child = deps.spawn(command);
      const pid = child.pid ?? null;
      child.stdout?.on("data", (chunk: Buffer | string) => deps.logger.write(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => deps.logger.write(chunk));
      deps.logger.line(
        `started gateway pid ${pid ?? "unknown"}: ${command.command} ${command.args.join(" ")}`,
      );
      // `exit`, not `close`: a SIGUSR1 restart child inherits our pipes and
      // keeps them open after the parent exits.
      const exit = await waitForExit(child);
      child = null;
      const uptimeMs = deps.now() - startedAt;
      const decision = decideAfterExit(
        { exitCode: exit.code, signal: exit.signal, uptimeMs },
        state,
      );
      state = decision.state;
      await deps.appendExitLine(
        formatExitLogLine({
          time: new Date(deps.now()),
          pid,
          exitCode: exit.code,
          signal: exit.signal,
          uptimeMs,
          decision: decision.reason,
        }),
      );
      deps.logger.line(
        `gateway pid ${pid ?? "unknown"} ${describeExit({ exitCode: exit.code, signal: exit.signal })}: ${decision.reason}`,
      );
      if (decision.action === "stop") {
        break;
      }
      if (decision.action === "relaunch") {
        await wait(decision.delayMs);
        continue;
      }
      await wait(deps.graceMs ?? decision.graceMs);
      if (stopRequested) {
        break;
      }
      const afterGrace = await deps.probeGateway();
      const handoff = decideAfterHandoffGrace(afterGrace, state);
      state = handoff.state;
      deps.logger.line(handoff.reason);
      if (handoff.action === "stop") {
        break;
      }
      if (handoff.action === "wait-external") {
        // The loop top logs the waiting line (with the pid) and polls.
        adoptedPid = afterGrace.pid;
        continue;
      }
      await wait(handoff.delayMs);
    }
  } finally {
    detachSignals();
    if (child) {
      // The signal handler already sent SIGTERM; give the gateway its drain window.
      const pending = child;
      const exited = waitForExit(pending);
      const timer = new Promise<void>((resolve) => setTimeout(resolve, CHILD_STOP_TIMEOUT_MS));
      const result = await Promise.race([
        exited.then(() => "exited" as const),
        timer.then(() => "timeout" as const),
      ]);
      if (result === "timeout") {
        deps.logger.line("gateway did not exit within 45s after SIGTERM; sending SIGKILL");
        pending.kill("SIGKILL");
      }
    }
    await lock.release().catch(() => undefined);
    deps.logger.close();
  }
  return 0;
}

export function createSuperviseDeps(env: Record<string, string | undefined>): SuperviseDeps {
  const paths = resolveWslSupervisorPaths(env);
  const logger = new DailyGatewayLog(paths.logDir);
  let cachedRecord: WslSupervisorRecord | null = null;
  const probeGateway = async () => {
    const record = cachedRecord;
    const gatewayEnv = { ...env, ...record?.environment };
    const owner = await readGatewayLockOwner({ env: gatewayEnv as NodeJS.ProcessEnv }).catch(
      () => null,
    );
    const lockHeld = owner !== null && (owner.status === "alive" || owner.status === "unknown");
    const port = resolveSupervisedPort(record?.programArguments, gatewayEnv.BITTERBOT_GATEWAY_PORT);
    const portOpen = await isPortOpen(port).catch(() => false);
    return { lockHeld, portOpen, pid: lockHeld ? (owner?.pid ?? null) : null };
  };
  return {
    env,
    spawn: (cmd) => {
      const child: ChildProcess = spawn(cmd.command, cmd.args, {
        cwd: cmd.cwd,
        env: cmd.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return child;
    },
    readRecord: async () => {
      cachedRecord = await readWslSupervisorRecord(env);
      return cachedRecord;
    },
    acquireLock: () => acquireSupervisorLock(env, { isPidAlive }),
    probeGateway,
    removeStaleOrchestratorSocket: () =>
      removeStaleOrchestratorSocket(env.BITTERBOT_ORCHESTRATOR_IPC_PATH?.trim() || undefined),
    appendExitLine: (line) => appendExitLogLine(env, line),
    logger,
    onSignal: (handler) => {
      const onTerm = () => handler("SIGTERM");
      const onInt = () => handler("SIGINT");
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);
      return () => {
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
      };
    },
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    sleep: (ms, cancel) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        void cancel.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    resolveCommand: (record) =>
      resolveSupervisedCommand(record, {
        env,
        execPath: process.execPath,
        argv1: process.argv[1] ?? "",
        existsSync: fsSync.existsSync,
      }),
  };
}

export async function runGatewaySuperviseCommand(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  // Prime the record so the first adoption probe knows the port and env.
  const deps = createSuperviseDeps(env);
  await deps.readRecord();
  log.info("gateway supervisor starting");
  const code = await runGatewaySupervisor(deps);
  defaultRuntime.exit(code);
}
