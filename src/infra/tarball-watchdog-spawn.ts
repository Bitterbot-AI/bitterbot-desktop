/**
 * Spawning the tarball boot watchdog (PLAN-56 Phase 3b). Kept apart from
 * tarball-watchdog.ts so the gateway's respawn path (process-respawn.ts)
 * loads only this small module.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

function log(message: string): void {
  try {
    fs.appendFileSync(
      path.join(resolveStateDir(), "boot-watchdog.log"),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Spawn the detached tarball watchdog from THIS version's package root.
 * Returns its pid, or null (tests, spawn failure). In respawn mode it also
 * launches the gateway, so it inherits stdio and the environment.
 */
export function spawnTarballBootWatchdog(params: {
  root: string;
  armedAt: number;
  respawnArgv?: string[] | null;
  /** Respawn mode: the pid of the gateway that is about to exit. */
  waitPid?: number;
}): number | null {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return null;
  }
  const args = [
    path.join(params.root, "bitterbot.mjs"),
    "boot-watchdog",
    "--root",
    params.root,
    "--armed-at",
    String(params.armedAt),
  ];
  if (params.respawnArgv) {
    args.push("--respawn-argv", JSON.stringify(params.respawnArgv));
  }
  if (params.waitPid) {
    args.push("--wait-pid", String(params.waitPid));
  }
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: params.respawnArgv ? "inherit" : "ignore",
      cwd: params.root,
      env: process.env,
    });
    child.on("error", (err) => log(`watchdog spawn error: ${String(err)}`));
    child.unref();
    log(`spawned tarball watchdog pid=${child.pid ?? "?"} for armedAt=${params.armedAt}`);
    return child.pid ?? null;
  } catch (err) {
    log(`failed to spawn tarball watchdog: ${String(err)}`);
    return null;
  }
}
