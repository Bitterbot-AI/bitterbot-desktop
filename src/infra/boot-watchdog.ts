/**
 * Post-update boot watchdog: the ACTOR half of the boot-verify beacon.
 *
 * The failure mode nothing else covers: an update restarts the gateway and
 * the fresh build crash-loops (or never binds). The gateway cannot heal
 * itself — it is the thing that is dead — and doctor is pull-only. So the
 * update flow spawns this small DETACHED process right after arming the
 * beacon; it outlives its parent and watches the beacon file:
 *
 *   - beacon disappears  → healthy boot confirmed (the gateway deletes it at
 *     bind) → exit silently. This is the overwhelmingly common path.
 *   - beacon re-armed    → a newer update owns the boot (it spawned its own
 *     watchdog) → stand down.
 *   - beacon still armed past its deadline → ONE guarded rollback:
 *       claim the once-only latch → refuse if the worktree is dirty →
 *       `git reset --hard <prevSha>` → install → build → best-effort
 *       service restart → write rollback-performed.json for doctor.
 *
 * Guard rails (the blast-radius decisions, resolved):
 *   - Executor: detached watchdog (D1) — the only design that covers
 *     crash-loop-on-boot in every respawn mode. Under systemd the unit's
 *     Restart=always simply picks up the restored build on its next tick.
 *   - Schema: migrations are FORWARD-ONLY with an N-1 compatibility policy
 *     (D4, see src/memory/migrations.ts) — rolled-back code runs against the
 *     already-migrated DB, so the watchdog never touches data.
 *   - Trigger: the beacon's own deadlineAt (single source of truth for
 *     "boot never confirmed"; default 30min — generous because a cold boot
 *     is slow, and a healthy bind clears the beacon long before).
 *   - Once only: the rollbackAttempted latch is persisted BEFORE acting; a
 *     rollback that itself fails to boot goes loud (stale beacon → doctor
 *     error) instead of looping resets.
 *   - Dirty tree: refuse and go loud. Same precedent as the update flow's
 *     skip-on-dirty — uncommitted work must never be destroyed.
 *   - Config and databases are never touched. Git mode only (no sha, no
 *     watchdog).
 *   - Kill switch: `update.autoRollback.enabled = false`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BootVerifyRecord } from "./boot-verify.js";
import { resolveStateDir } from "../config/paths.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { claimRollbackAttempt, readBootVerify, writeRollbackRecord } from "./boot-verify.js";

const POLL_INTERVAL_MS = 5_000;
// Past the beacon deadline, give the gateway one more grace period before
// acting — the deadline is doctor's "go loud" line; the watchdog's reset is
// strictly more destructive, so it waits a beat longer.
const TRIGGER_GRACE_MS = 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const RESTART_TIMEOUT_MS = 2 * 60_000;
// Absolute lifetime cap: a watchdog that somehow never resolves must not
// linger for days.
const MAX_LIFETIME_MS = 4 * 60 * 60_000;

export type WatchdogAction =
  | "wait"
  | "exit-healthy"
  | "exit-superseded"
  | "exit-already-attempted"
  | "rollback";

/**
 * Pure decision core — exported for tests. `beacon` is the current on-disk
 * record (null = cleared).
 */
export function decideWatchdogAction(params: {
  beacon: BootVerifyRecord | null;
  expectedArmedAt: number;
  now: number;
}): WatchdogAction {
  const { beacon, expectedArmedAt, now } = params;
  if (!beacon) return "exit-healthy";
  if (beacon.armedAt !== expectedArmedAt) return "exit-superseded";
  if (beacon.rollbackAttempted) return "exit-already-attempted";
  if (now < beacon.deadlineAt + TRIGGER_GRACE_MS) return "wait";
  return "rollback";
}

type RunCommand = (
  argv: string[],
  opts: { timeoutMs: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunCommand: RunCommand = async (argv, opts) => {
  const res = await runCommandWithTimeout(argv, { timeoutMs: opts.timeoutMs, cwd: opts.cwd });
  // A null code (killed / no exit status) is a failure for our purposes.
  return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 1 };
};

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(path.join(resolveStateDir(), "boot-watchdog.log"), line, "utf-8");
  } catch {
    /* logging is best-effort */
  }
}

/**
 * The guarded rollback: dirty-check → reset → install → build → best-effort
 * restart. Exported for tests with an injectable runner. Never throws.
 */
export async function performRollback(params: {
  root: string;
  prevSha: string;
  runCommand?: RunCommand;
  now?: () => number;
}): Promise<{ ok: boolean; detail: string }> {
  const run = params.runCommand ?? defaultRunCommand;
  const { root, prevSha } = params;
  const steps: string[] = [];

  // Same dirty definition as the update flow (dist/control-ui is untracked
  // noise). Uncommitted work is never destroyed — refuse and go loud.
  const status = await run(
    ["git", "-C", root, "status", "--porcelain", "--", ":!dist/control-ui/"],
    { timeoutMs: GIT_TIMEOUT_MS },
  ).catch((err) => ({ stdout: "", stderr: String(err), code: 1 }));
  if (status.code !== 0) {
    return { ok: false, detail: `git status failed: ${status.stderr.trim() || status.code}` };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      detail:
        "worktree has uncommitted changes — refusing to git reset. " +
        `Roll back manually: git reset --hard ${prevSha} && pnpm build && pnpm start gateway`,
    };
  }

  const reset = await run(["git", "-C", root, "reset", "--hard", prevSha], {
    timeoutMs: GIT_TIMEOUT_MS,
  }).catch((err) => ({ stdout: "", stderr: String(err), code: 1 }));
  if (reset.code !== 0) {
    return { ok: false, detail: `git reset --hard ${prevSha} failed: ${reset.stderr.trim()}` };
  }
  steps.push(`reset to ${prevSha}`);

  const install = await run(["pnpm", "install"], {
    timeoutMs: INSTALL_TIMEOUT_MS,
    cwd: root,
  }).catch((err) => ({ stdout: "", stderr: String(err), code: 1 }));
  if (install.code !== 0) {
    return {
      ok: false,
      detail: `${steps.join("; ")}; pnpm install FAILED: ${install.stderr.trim().slice(0, 300)}`,
    };
  }
  steps.push("install ok");

  const build = await run(["pnpm", "build"], {
    timeoutMs: BUILD_TIMEOUT_MS,
    cwd: root,
  }).catch((err) => ({ stdout: "", stderr: String(err), code: 1 }));
  if (build.code !== 0) {
    return {
      ok: false,
      detail: `${steps.join("; ")}; pnpm build FAILED: ${build.stderr.trim().slice(0, 300)}`,
    };
  }
  steps.push("build ok");

  // Best-effort restart. Under systemd, Restart=always already picks the
  // restored build up on its next tick, so a failure here is not fatal —
  // the still-armed beacon keeps doctor loud until SOME gateway binds.
  const restart = await run(
    [process.execPath, path.join(root, "bitterbot.mjs"), "gateway", "restart"],
    { timeoutMs: RESTART_TIMEOUT_MS, cwd: root },
  ).catch((err) => ({ stdout: "", stderr: String(err), code: 1 }));
  steps.push(restart.code === 0 ? "restart ok" : "restart failed (supervisor may recover)");

  return { ok: true, detail: steps.join("; ") };
}

/**
 * Long-running watchdog loop. Invoked by the hidden `boot-watchdog` CLI
 * command in the detached child. Exits the process when resolved.
 */
export async function runBootWatchdog(params: {
  root: string;
  expectedArmedAt: number;
  runCommand?: RunCommand;
}): Promise<void> {
  const startedAt = Date.now();
  log(`watchdog armed (root=${params.root}, armedAt=${params.expectedArmedAt})`);

  for (;;) {
    const now = Date.now();
    if (now - startedAt > MAX_LIFETIME_MS) {
      log("lifetime cap reached — exiting without action");
      return;
    }
    const action = decideWatchdogAction({
      beacon: readBootVerify(),
      expectedArmedAt: params.expectedArmedAt,
      now,
    });
    if (action === "wait") {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    if (action !== "rollback") {
      log(`standing down: ${action}`);
      return;
    }

    // Claim the once-only latch (re-validates armedAt atomically-enough for
    // our single-writer reality; the persisted latch is the real interlock).
    const claimed = claimRollbackAttempt(params.expectedArmedAt);
    if (!claimed) {
      log("could not claim rollback latch — standing down");
      return;
    }
    if (!claimed.prevSha) {
      log("beacon has no prevSha (package-mode update) — nothing to roll back to");
      return;
    }

    // Final pre-destruction check: if the gateway bound in the instant after
    // the claim (and deleted the beacon we just latched), stand down — never
    // reset a node that just became healthy.
    if (!readBootVerify()) {
      log("beacon cleared right after claim (gateway bound) — standing down");
      return;
    }

    log(`boot never confirmed — rolling back to ${claimed.prevSha}`);
    const badSha = await (params.runCommand ?? defaultRunCommand)(
      ["git", "-C", params.root, "rev-parse", "HEAD"],
      { timeoutMs: GIT_TIMEOUT_MS },
    )
      .then((r) => (r.code === 0 ? r.stdout.trim() : null))
      .catch(() => null);

    // Provisional record BEFORE acting: if the watchdog dies mid-rollback the
    // node still surfaces in doctor instead of silently running old code.
    writeRollbackRecord({
      fromSha: badSha,
      toSha: claimed.prevSha,
      at: Date.now(),
      detail: "rollback in progress — if this persists, the watchdog crashed mid-way",
      ok: false,
    });

    const result = await performRollback({
      root: params.root,
      prevSha: claimed.prevSha,
      runCommand: params.runCommand,
    });
    writeRollbackRecord({
      fromSha: badSha,
      toSha: claimed.prevSha,
      at: Date.now(),
      detail: result.detail,
      ok: result.ok,
    });
    log(`rollback ${result.ok ? "performed" : "FAILED"}: ${result.detail}`);
    // A performed rollback changed the code under any running Control UI just
    // like an update did — bounce it the same way (this process is already
    // detached, so run the sequence inline; guarded like the spawn sites).
    if (result.ok) {
      try {
        const { loadConfig } = await import("../config/config.js");
        if (loadConfig().update?.uiRestart?.enabled !== false) {
          const { runUiRestart } = await import("./ui-restart.js");
          await runUiRestart({ root: params.root, reason: "rollback" });
        }
      } catch (err) {
        log(`ui restart after rollback failed: ${String(err)}`);
      }
    }
    // The beacon stays armed either way: a successful rollback clears it when
    // the restored gateway binds; a failed one leaves doctor's error live.
    return;
  }
}

/**
 * Spawn the detached watchdog. Called by both update paths right after
 * armBootVerify. No-ops (returns false) when auto-rollback is disabled,
 * there is no sha to return to, or the spawn fails — the beacon-only
 * behavior (loud doctor error, manual recovery) remains as the floor.
 */
export function spawnBootWatchdog(params: {
  root: string;
  prevSha: string | null;
  autoRollbackEnabled: boolean;
}): boolean {
  if (!params.autoRollbackEnabled) return false;
  if (!params.prevSha) return false;
  // Never spawn a real detached process from a test run.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  const beacon = readBootVerify();
  if (!beacon) return false;
  try {
    const child = spawn(
      process.execPath,
      [
        path.join(params.root, "bitterbot.mjs"),
        "boot-watchdog",
        "--root",
        params.root,
        "--armed-at",
        String(beacon.armedAt),
      ],
      {
        detached: true,
        stdio: "ignore",
        cwd: params.root,
        env: process.env,
      },
    );
    // Spawn failures (ENOENT etc.) arrive ASYNC on the 'error' event; without
    // a listener they become an uncaughtException in the PARENT — i.e. they
    // could crash the gateway mid-update. Degrade to beacon-only instead.
    child.on("error", (err) => {
      log(`watchdog spawn error: ${String(err)}`);
    });
    child.unref();
    log(`spawned watchdog pid=${child.pid ?? "?"} for armedAt=${beacon.armedAt}`);
    return true;
  } catch (err) {
    log(`failed to spawn watchdog: ${String(err)}`);
    return false;
  }
}
