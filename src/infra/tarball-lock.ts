/**
 * The app-dir lock of a release-tarball install: `<appDir>/.update.lock`.
 * Shared by the in-place updater (tarball-updater.ts), doctor, and the npm
 * launcher (src/launcher/), so a first-run install from the launcher and a
 * `bitterbot update` never unpack into the same app dir at once. Only
 * `node:` imports (the launcher is bundled into one dependency-free file).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { versionInUse } from "./tarball-install.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock is held by someone else (`pid`, when known). */
export class TarballLockError extends Error {
  constructor(
    message: string,
    readonly pid: number | null,
  ) {
    super(message);
    this.name = "TarballLockError";
  }
}

export const UPDATE_LOCK_FILE = ".update.lock";
/**
 * A lock whose owner cannot be identified by its start time (macOS, a lock
 * written by an older version) is stale once it is older than this: an
 * update holds the lock only while it downloads, snapshots and activates,
 * never across the boot wait (whose deadline is at most 90 minutes).
 */
export const UPDATE_LOCK_MAX_AGE_MS = 6 * 60 * 60_000;

type UpdateLockPayload = {
  pid: number;
  /** Identifies the run that took the lock: only that run removes it. */
  token: string | null;
  createdAt: number | null;
  /** Linux: the owner's start time (/proc/<pid>/stat field 22), to detect pid reuse. */
  startTime: number | null;
};

/** Start time of `pid` in clock ticks since boot (Linux), or null. */
export function readProcStartTime(pid: number, procRoot: string | null = "/proc"): number | null {
  if (!procRoot) {
    return null;
  }
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const fields = raw
      .slice(raw.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const n = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readUpdateLockRaw(lockPath: string): { raw: string; mtimeMs: number } | null {
  try {
    return { raw: fs.readFileSync(lockPath, "utf8"), mtimeMs: fs.statSync(lockPath).mtimeMs };
  } catch {
    return null;
  }
}

function parseUpdateLock(raw: string, mtimeMs: number): UpdateLockPayload | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    // Written by an earlier build: the pid only.
    return { pid: Number(text), token: null, createdAt: mtimeMs, startTime: null };
  }
  try {
    const parsed = JSON.parse(text) as Partial<UpdateLockPayload>;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      token: typeof parsed.token === "string" ? parsed.token : null,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : mtimeMs,
      startTime: typeof parsed.startTime === "number" ? parsed.startTime : null,
    };
  } catch {
    return null;
  }
}

export type UpdateLockState =
  | { state: "free" }
  | { state: "held"; pid: number }
  | { state: "stale"; pid: number | null; reason: string };

/**
 * Is `<appDir>/.update.lock` held? Held when its owner is this process (a
 * concurrent run in the same gateway) or a live process with the recorded
 * start time. Stale when the owner is dead, its pid now belongs to a process
 * started later (start time differs), or, with no start time to compare, the
 * lock is older than UPDATE_LOCK_MAX_AGE_MS.
 */
export function inspectUpdateLock(
  appDir: string,
  opts: { now?: number; procRoot?: string | null } = {},
): UpdateLockState {
  const read = readUpdateLockRaw(path.join(appDir, UPDATE_LOCK_FILE));
  if (!read) {
    return { state: "free" };
  }
  const lock = parseUpdateLock(read.raw, read.mtimeMs);
  if (!lock) {
    return { state: "stale", pid: null, reason: "the lock file is unreadable" };
  }
  // This process counts like any other: alive, so a lock with our pid is
  // held (a concurrent run here) unless its start time says the pid was reused.
  let alive = false;
  try {
    process.kill(lock.pid, 0);
    alive = true;
  } catch (err) {
    alive = (err as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!alive) {
    return { state: "stale", pid: lock.pid, reason: `its owner (pid ${lock.pid}) has exited` };
  }
  const procRoot = opts.procRoot === undefined ? "/proc" : opts.procRoot;
  const nowStart = lock.startTime !== null ? readProcStartTime(lock.pid, procRoot) : null;
  if (lock.startTime !== null && nowStart !== null) {
    return nowStart === lock.startTime
      ? { state: "held", pid: lock.pid }
      : {
          state: "stale",
          pid: lock.pid,
          reason: `pid ${lock.pid} now belongs to another process (its owner exited)`,
        };
  }
  const age = (opts.now ?? Date.now()) - (lock.createdAt ?? read.mtimeMs);
  if (age > UPDATE_LOCK_MAX_AGE_MS) {
    return {
      state: "stale",
      pid: lock.pid,
      reason: `it is ${Math.round(age / 3_600_000)} h old, longer than any update runs`,
    };
  }
  return { state: "held", pid: lock.pid };
}

/** Remove a stale lock (doctor --fix). Returns false when it is held or already gone. */
export function clearStaleUpdateLock(
  appDir: string,
  opts: { procRoot?: string | null } = {},
): boolean {
  const lockPath = path.join(appDir, UPDATE_LOCK_FILE);
  const before = readUpdateLockRaw(lockPath);
  if (!before || inspectUpdateLock(appDir, opts).state !== "stale") {
    return false;
  }
  // Only the lock we judged: another updater may have replaced it meanwhile.
  if (readUpdateLockRaw(lockPath)?.raw !== before.raw) {
    return false;
  }
  fs.rmSync(lockPath, { force: true });
  return true;
}

/** App dirs with an update running in THIS process (the file lock is per process). */
const updatesInProcess = new Set<string>();

/**
 * One update (or npm-launcher install) at a time per app dir: `<appDir>/.update.lock` names the owner
 * (pid, start time, a per-run token). The returned release removes the lock
 * only while it still carries this run's token.
 */
export function acquireTarballLock(
  appDir: string,
  opts: { onStale?: (reason: string) => void } = {},
): () => void {
  const key = path.resolve(appDir);
  if (updatesInProcess.has(key)) {
    throw new TarballLockError(
      "an update is already running in this process; wait for it to finish",
      process.pid,
    );
  }
  const lockPath = path.join(appDir, UPDATE_LOCK_FILE);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            token,
            createdAt: Date.now(),
            startTime: readProcStartTime(process.pid),
          }),
        );
      } finally {
        fs.closeSync(fd);
      }
      updatesInProcess.add(key);
      return () => {
        updatesInProcess.delete(key);
        const now = readUpdateLockRaw(lockPath);
        const lock = now ? parseUpdateLock(now.raw, now.mtimeMs) : null;
        if (lock?.token === token) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const state = inspectUpdateLock(appDir);
      if (state.state === "held") {
        throw new TarballLockError(
          `another update is already running (pid ${state.pid}); wait for it to finish`,
          state.pid,
        );
      }
      if (state.state === "stale") {
        opts.onStale?.(state.reason);
        clearStaleUpdateLock(appDir);
      }
    }
  }
  throw new TarballLockError(`could not take ${lockPath}`, null);
}

/**
 * Leftovers of interrupted updates (we hold the lock, so none is live):
 * staging dirs, displaced version dirs no process uses, and temporary
 * `.current.<pid>.<ts>` / `.previous.<pid>.<ts>` links of a swap that died
 * between symlink and rename.
 */
export function removeUpdateLeftovers(appDir: string, procRoot?: string | null): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(appDir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(appDir, name);
    const swapTemp = /^\.(current|previous)\.(\d+)\.[0-9a-z]+$/.exec(name);
    if (swapTemp) {
      // A temporary link from swapVersionLink that an interrupted process
      // never renamed into place; only when that process is gone.
      if (!pidAlive(Number(swapTemp[2]))) {
        fs.rmSync(full, { force: true });
      }
      continue;
    }
    if (name.startsWith(".update-")) {
      fs.rmSync(full, { recursive: true, force: true });
    } else if (
      name.startsWith(".replaced.") &&
      versionInUse(full, { excludePids: [], procRoot }) === null
    ) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}
