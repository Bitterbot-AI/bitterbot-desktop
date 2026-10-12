/**
 * The boot watchdog for release-tarball updates (PLAN-56 Phase 3b): the
 * same beacon, latch and record as the git watchdog (boot-watchdog.ts), with
 * a symlink switch instead of `git reset`.
 *
 * It always runs from the KNOWN-GOOD (pre-update) version's code: the
 * updater (CLI or gateway) that spawns it is that version.
 *
 *   restart "service": a supervisor restarts the gateway; the watchdog only
 *     watches. Past the beacon deadline (plus a grace period) it rolls back.
 *   restart "respawn": an unsupervised gateway hands its restart to the
 *     watchdog, which launches the new version through `<appDir>/current`
 *     with the gateway's own argv and environment. If that process exits
 *     before it confirms a healthy boot, the rollback starts at once.
 *
 * Rollback (once, under the beacon's latch): stop the bad gateway, point
 * `current` back at the old version (`previous` keeps the new one), apply the
 * snapshot restore policy (update-snapshot.ts planSnapshotRestore, mode
 * "auto"), re-arm the beacon for the old version, start it again, and write
 * rollback-performed.json for doctor and `bitterbot update`.
 * `update.autoRollback.enabled = false` turns the rollback off; the beacon
 * then stays armed and doctor reports the failed boot.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  armBootVerify,
  claimRollbackAttempt,
  readBootVerify,
  writeRollbackRecord,
  type BootVerifyRecord,
  type TarballBootVerify,
} from "./boot-verify.js";
import { CURRENT_LINK, resolveTarballLayout } from "./tarball-install.js";
import { rollbackTarballInstall } from "./tarball-updater.js";

const POLL_INTERVAL_MS = 2_000;
const TRIGGER_GRACE_MS = 60_000;
const MAX_LIFETIME_MS = 4 * 60 * 60_000;
const STOP_TIMEOUT_MS = 60_000;
/** Deadline for the re-armed beacon after a rollback (the old version booting). */
const REARM_DEADLINE_MS = 30 * 60_000;

export type TarballWatchdogAction =
  | "wait"
  | "exit-healthy"
  | "exit-superseded"
  | "exit-already-attempted"
  | "rollback";

/** Pure decision core (exported for tests). */
export function decideTarballWatchdogAction(params: {
  beacon: BootVerifyRecord | null;
  expectedArmedAt: number;
  now: number;
  /** The respawned gateway exited before the beacon cleared. */
  childExited: boolean;
}): TarballWatchdogAction {
  const { beacon, expectedArmedAt, now } = params;
  if (!beacon) {
    return "exit-healthy";
  }
  if (beacon.armedAt !== expectedArmedAt) {
    return "exit-superseded";
  }
  if (beacon.rollbackAttempted) {
    return "exit-already-attempted";
  }
  if (params.childExited) {
    return "rollback";
  }
  return now < beacon.deadlineAt + TRIGGER_GRACE_MS ? "wait" : "rollback";
}

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

/** `<appDir>/current/bin/bitterbot` with the gateway's argv, detached. */
export function launchCurrentGateway(params: {
  appDir: string;
  argv: string[];
  stdio?: "inherit" | "ignore";
}): ChildProcess | null {
  const launcher = path.join(params.appDir, CURRENT_LINK, "bin", "bitterbot");
  const env = { ...process.env };
  // The launcher sets these for the version it belongs to, and entry.js
  // re-execs itself unless this marker is already set.
  delete env.BITTERBOT_INSTALL_ROOT;
  delete env.BITTERBOT_NODE_OPTIONS_READY;
  try {
    const child = spawn(launcher, params.argv, {
      detached: true,
      stdio: params.stdio ?? "inherit",
      env,
    });
    child.on("error", (err) => log(`gateway launch error: ${String(err)}`));
    child.unref();
    return child;
  } catch (err) {
    log(`gateway launch failed: ${String(err)}`);
    return null;
  }
}

type RunCommand = (
  argv: string[],
  opts: { timeoutMs: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunCommand: RunCommand = async (argv, opts) => {
  const res = await runCommandWithTimeout(argv, { timeoutMs: opts.timeoutMs, cwd: opts.cwd });
  return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 1 };
};

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 15_000).unref(),
  );
  if ((await Promise.race([exited, timer])) === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * The guarded tarball rollback. Exported for tests (inject runCommand,
 * launch). Never throws.
 */
export async function performTarballRollback(params: {
  tarball: TarballBootVerify;
  /** Package root of THIS (known-good) version, for `gateway stop/restart`. */
  watchdogRoot: string;
  respawnArgv: string[] | null;
  child: ChildProcess | null;
  stateDir?: string;
  runCommand?: RunCommand;
  launch?: typeof launchCurrentGateway;
}): Promise<{ ok: boolean; detail: string; restored: string[]; snapshotDir: string | null }> {
  const run = params.runCommand ?? defaultRunCommand;
  const launch = params.launch ?? launchCurrentGateway;
  const t = params.tarball;
  const stateDir = params.stateDir ?? resolveStateDir();
  const cli = [process.execPath, path.join(params.watchdogRoot, "bitterbot.mjs")];
  const steps: string[] = [];

  // 1. Stop the bad gateway so no process holds the databases.
  if (params.respawnArgv) {
    await stopChild(params.child);
    steps.push("stopped the new gateway process");
  } else {
    const stop = await run([...cli, "gateway", "stop"], { timeoutMs: STOP_TIMEOUT_MS }).catch(
      (err) => ({ stdout: "", stderr: String(err), code: 1 }),
    );
    steps.push(stop.code === 0 ? "`gateway stop` ran" : "`gateway stop` failed (continuing)");
  }

  // 2. Switch back and restore per the policy.
  let restored: string[] = [];
  let snapshotDir: string | null = null;
  try {
    const res = await rollbackTarballInstall({
      appDir: t.appDir,
      stateDir,
      fromVersion: t.toVersion,
      toVersion: t.fromVersion,
      mode: "auto",
      targetMemorySchemaLatest: t.fromMemorySchemaLatest,
    });
    restored = res.restore?.restored ?? [];
    snapshotDir = res.snapshotDir;
    steps.push(`current -> ${t.fromVersion}`);
    steps.push(
      restored.length > 0
        ? `restored from snapshot: ${restored.map((f) => path.basename(f)).join(", ")}`
        : "no data restored (kept as is)",
    );
  } catch (err) {
    return {
      ok: false,
      detail: `${steps.join("; ")}; switching back FAILED: ${String(err)}. Manual recovery: ln -sfn ${t.fromVersion} ${path.join(t.appDir, CURRENT_LINK)} && bitterbot gateway restart`,
      restored,
      snapshotDir,
    };
  }

  // 3. The old version is expected now; its bind clears the beacon.
  armBootVerify({
    prevSha: null,
    expectedVersion: t.fromVersion,
    deadlineMs: REARM_DEADLINE_MS,
    reason: "tarball-rollback",
    tarball: t,
    rollbackAttempted: true,
  });

  // 4. Start it again.
  if (params.respawnArgv) {
    const child = launch({ appDir: t.appDir, argv: params.respawnArgv });
    steps.push(
      child ? `relaunched v${t.fromVersion} (pid ${child.pid ?? "?"})` : "relaunch FAILED",
    );
    if (!child) {
      return { ok: false, detail: steps.join("; "), restored, snapshotDir };
    }
  } else {
    const restart = await run([...cli, "gateway", "restart"], { timeoutMs: STOP_TIMEOUT_MS }).catch(
      (err) => ({ stdout: "", stderr: String(err), code: 1 }),
    );
    steps.push(
      restart.code === 0
        ? "`gateway restart` ran"
        : "`gateway restart` failed (a supervisor may recover)",
    );
  }
  return { ok: true, detail: steps.join("; "), restored, snapshotDir };
}

/**
 * The tarball watchdog loop: launch (respawn mode), wait, roll back once.
 * Invoked by runBootWatchdog when the beacon carries `tarball`.
 */
async function waitForPidExit(pid: number, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runTarballWatchdog(params: {
  root: string;
  expectedArmedAt: number;
  respawnArgv: string[] | null;
  /** Respawn mode: the old gateway's pid; launch only after it has exited. */
  waitPid?: number | null;
}): Promise<void> {
  const startedAt = Date.now();
  const first = readBootVerify();
  const tarball = first?.tarball;
  if (!first || !tarball || first.armedAt !== params.expectedArmedAt) {
    log("tarball watchdog: no matching beacon; standing down");
    // Respawn mode: the old gateway has handed its restart to us, so start
    // `current` anyway rather than leave no gateway running.
    const appDir = first?.tarball?.appDir ?? resolveTarballLayout(params.root)?.appDir;
    if (params.respawnArgv && appDir) {
      if (params.waitPid) {
        await waitForPidExit(params.waitPid, 60_000);
      }
      launchCurrentGateway({ appDir, argv: params.respawnArgv });
    }
    return;
  }
  log(
    `tarball watchdog armed (v${tarball.fromVersion} -> v${tarball.toVersion}, restart=${tarball.restart}, autoRollback=${tarball.autoRollback})`,
  );

  let child: ChildProcess | null = null;
  let childExited = false;
  if (params.respawnArgv) {
    if (params.waitPid) {
      // The old gateway releases its port and lock as it exits.
      await waitForPidExit(params.waitPid, 60_000);
    }
    child = launchCurrentGateway({ appDir: tarball.appDir, argv: params.respawnArgv });
    if (!child) {
      childExited = true;
    } else {
      log(`launched v${tarball.toVersion} (pid ${child.pid ?? "?"})`);
      child.once("exit", (code, signal) => {
        childExited = true;
        log(`new gateway exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
      });
    }
  }

  for (;;) {
    if (Date.now() - startedAt > MAX_LIFETIME_MS) {
      log("lifetime cap reached; exiting without action");
      return;
    }
    const action = decideTarballWatchdogAction({
      beacon: readBootVerify(),
      expectedArmedAt: params.expectedArmedAt,
      now: Date.now(),
      childExited,
    });
    if (action === "wait") {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    if (action !== "rollback") {
      log(`standing down: ${action}`);
      return;
    }
    if (!tarball.autoRollback) {
      log(
        `v${tarball.toVersion} never confirmed a healthy boot; update.autoRollback.enabled is false, so nothing was rolled back. Roll back with: bitterbot update --rollback`,
      );
      return;
    }
    const claimed = claimRollbackAttempt(params.expectedArmedAt);
    if (!claimed) {
      log("could not claim the rollback latch; standing down");
      return;
    }
    if (!readBootVerify()) {
      log("beacon cleared right after the claim (gateway bound); standing down");
      return;
    }
    log(
      `v${tarball.toVersion} never confirmed a healthy boot; rolling back to v${tarball.fromVersion}`,
    );
    writeRollbackRecord({
      fromSha: null,
      toSha: `v${tarball.fromVersion}`,
      mode: "tarball",
      fromVersion: tarball.toVersion,
      toVersion: tarball.fromVersion,
      at: Date.now(),
      detail: "rollback in progress; if this persists, the watchdog crashed mid-way",
      ok: false,
    });
    const result = await performTarballRollback({
      tarball,
      watchdogRoot: params.root,
      respawnArgv: params.respawnArgv,
      child,
    });
    writeRollbackRecord({
      fromSha: null,
      toSha: `v${tarball.fromVersion}`,
      mode: "tarball",
      fromVersion: tarball.toVersion,
      toVersion: tarball.fromVersion,
      at: Date.now(),
      detail: result.detail,
      ok: result.ok,
      restored: result.restored,
      snapshotDir: result.snapshotDir,
    });
    log(`rollback ${result.ok ? "performed" : "FAILED"}: ${result.detail}`);
    return;
  }
}

export { spawnTarballBootWatchdog } from "./tarball-watchdog-spawn.js";
