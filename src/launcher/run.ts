/**
 * Run the installed app's own `bin/bitterbot` with the launcher's argv:
 * stdio inherited, signals forwarded, exit status propagated (a child killed
 * by a signal kills the launcher with the same signal, so a shell or service
 * manager sees exactly what it would have seen without the launcher).
 *
 * Node cannot replace its own process image portably (process.execve is
 * experimental and absent before Node 22.15), so this is a thin parent.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import os from "node:os";

/**
 * Forwarded to the app. SIGINT and SIGQUIT come from the terminal to the
 * whole foreground process group, so on a TTY the app already has them and
 * forwarding would deliver a second Ctrl-C (which the app may read as
 * "force quit"); they are forwarded only when stdin is not a terminal (a
 * supervisor that signals the launcher's pid alone). The launcher itself
 * never dies of them: it waits for the app to exit.
 */
export const FORWARDED_SIGNALS: NodeJS.Signals[] = [
  "SIGTERM",
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
  "SIGWINCH",
];

const TERMINAL_SIGNALS = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT", "SIGWINCH"]);

/**
 * Environment for the app. The tarball's bin/bitterbot sets the install
 * kind and root itself; values inherited from an older npm-package gateway
 * service (or the documented BITTERBOT_INSTALL_KIND=package escape hatch for
 * the old full package) would mislabel what is now a release-tarball
 * install, and entry.js's re-exec marker must not leak into a fresh app.
 */
export function appEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.BITTERBOT_INSTALL_KIND;
  delete out.BITTERBOT_INSTALL_ROOT;
  delete out.BITTERBOT_NODE_OPTIONS_READY;
  return out;
}

export type RunDeps = {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  proc?: Pick<NodeJS.Process, "on" | "off" | "kill" | "pid"> & {
    stdin: { isTTY?: boolean };
  };
};

/** Resolves with the exit code the launcher should exit with. */
export function runApp(
  bin: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: RunDeps = {},
): Promise<number> {
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const proc = deps.proc ?? process;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(bin, argv, { stdio: "inherit", env: appEnvironment(env) });
    } catch (err) {
      process.stderr.write(`bitterbot: could not start ${bin}: ${String(err)}\n`);
      resolve(1);
      return;
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        if (TERMINAL_SIGNALS.has(signal) && proc.stdin.isTTY) {
          return;
        }
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      };
      handlers.set(signal, handler);
      proc.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        proc.off(signal, handler);
      }
    };
    child.once("error", (err) => {
      cleanup();
      process.stderr.write(`bitterbot: could not start ${bin}: ${err.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        // Die of the same signal (handlers removed, so the default action
        // runs); 128 + signal number if that somehow returns.
        try {
          proc.kill(proc.pid, signal);
        } catch {
          // fall through
        }
        resolve(128 + (os.constants.signals[signal] ?? 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
