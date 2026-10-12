import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readBootVerify } from "./boot-verify.js";
import { CURRENT_LINK, resolveTarballLayout } from "./tarball-install.js";
import { spawnTarballBootWatchdog } from "./tarball-watchdog-spawn.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

export type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

const SUPERVISOR_HINT_ENV_VARS = [
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  "INVOCATION_ID",
  "SYSTEMD_EXEC_PID",
  "JOURNAL_STREAM",
];

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isLikelySupervisedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return SUPERVISOR_HINT_ENV_VARS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * A release-tarball gateway (PLAN-56 Phase 3b) restarts through
 * `<appDir>/current/bin/bitterbot`, not its own node/entry.js: after an
 * in-place update `current` names the new version, and the version
 * directory this process runs from is the old one.
 */
function resolveTarballRespawn(
  env: NodeJS.ProcessEnv,
): { appDir: string; root: string; launcher: string } | null {
  if (env.BITTERBOT_INSTALL_KIND !== "tarball" || !env.BITTERBOT_INSTALL_ROOT) {
    return null;
  }
  const layout = resolveTarballLayout(env.BITTERBOT_INSTALL_ROOT);
  if (!layout) {
    return null;
  }
  const launcher = path.join(layout.appDir, CURRENT_LINK, "bin", "bitterbot");
  if (!fs.existsSync(launcher)) {
    return null;
  }
  return { appDir: layout.appDir, root: layout.versionDir, launcher };
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd): caller should exit and let supervisor restart
 * - BITTERBOT_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - release-tarball install with an update pending (boot-verify beacon with
 *   `tarball.restart === "respawn"`): hand the restart to the tarball boot
 *   watchdog, which launches `current` and rolls back if it never boots
 * - release-tarball install otherwise: spawn `<appDir>/current/bin/bitterbot`
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(): GatewayRespawnResult {
  if (isTruthy(process.env.BITTERBOT_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const tarball = resolveTarballRespawn(process.env);
  const beacon = tarball ? readBootVerify() : null;
  const pendingUpdate =
    tarball &&
    beacon?.tarball?.restart === "respawn" &&
    !beacon.rollbackAttempted &&
    beacon.tarball.appDir === tarball.appDir
      ? beacon
      : null;
  if (isLikelySupervisedProcess(process.env)) {
    if (pendingUpdate && tarball) {
      // A supervisor this updater did not know about restarts us: the
      // watchdog only watches (and switches back if the new version fails).
      spawnTarballBootWatchdog({ root: tarball.root, armedAt: pendingUpdate.armedAt });
    }
    return { mode: "supervised" };
  }
  const argv = process.argv.slice(2);
  if (pendingUpdate && tarball) {
    const pid = spawnTarballBootWatchdog({
      root: tarball.root,
      armedAt: pendingUpdate.armedAt,
      respawnArgv: argv,
      waitPid: process.pid,
    });
    if (pid !== null) {
      return { mode: "spawned", pid, detail: "tarball update watchdog" };
    }
  }
  if (tarball) {
    try {
      const env = { ...process.env };
      // The new launcher sets its own root, and its entry.js re-execs itself
      // (warning flags) unless this marker is inherited.
      delete env.BITTERBOT_INSTALL_ROOT;
      delete env.BITTERBOT_NODE_OPTIONS_READY;
      const child = spawn(tarball.launcher, argv, { env, detached: true, stdio: "inherit" });
      child.unref();
      return { mode: "spawned", pid: child.pid ?? undefined, detail: tarball.launcher };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { mode: "failed", detail };
    }
  }

  try {
    const args = [...process.execArgv, ...process.argv.slice(1)];
    const child = spawn(process.execPath, args, {
      env: process.env,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mode: "failed", detail };
  }
}
