/**
 * On-disk layout of a release-tarball install (PLAN-56 Phase 3), shared by
 * the in-place updater, the boot watchdog and doctor. scripts/install.sh
 * writes the same layout:
 *
 *   <appDir>/                      default ~/.bitterbot/app
 *     <X.Y.Z>/                     one unpacked release (bin/, dist/, runtime/, manifest.json)
 *       .pids/<pid>                in-use markers written by bin/bitterbot (exec keeps the pid)
 *     current  -> <X.Y.Z>          relative symlink, what ~/.local/bin/bitterbot runs
 *     previous -> <X.Y.Z>          the version `current` pointed at before, kept for rollback
 *
 * A version directory is never removed while it is `current`, `previous`,
 * or in use by a live process (a `.pids` marker, or on Linux any process
 * whose executable or cwd is inside it).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$(?![\s\S])/;
export const CURRENT_LINK = "current";
export const PREVIOUS_LINK = "previous";

export type TarballLayout = {
  /** The install root holding the version directories (default ~/.bitterbot/app). */
  appDir: string;
  /** The version directory this process runs from. */
  versionDir: string;
  version: string;
};

/** ~/.bitterbot/app: install.sh's default `--dir`. */
export function defaultTarballAppDir(homedir: string = os.homedir()): string {
  return path.join(homedir, ".bitterbot", "app");
}

/** ~/.local/bin/bitterbot: the command link install.sh creates. */
export function tarballCommandLinkPath(homedir: string = os.homedir()): string {
  return path.join(homedir, ".local", "bin", "bitterbot");
}

/**
 * The layout around `root` (a version directory such as
 * ~/.bitterbot/app/1.5.0): its parent is the app dir. Null when `root` is
 * not named like a version (a package or source install).
 */
export function resolveTarballLayout(root: string | null | undefined): TarballLayout | null {
  if (!root) {
    return null;
  }
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // keep the given path
  }
  const version = path.basename(real);
  if (!VERSION_DIR_RE.test(version)) {
    return null;
  }
  return { appDir: path.dirname(real), versionDir: real, version };
}

/** The version a `current`/`previous` link names, or null when absent or not a version. */
export function readVersionLink(appDir: string, name: string): string | null {
  try {
    const target = fs.readlinkSync(path.join(appDir, name));
    const base = path.basename(target);
    if (!VERSION_DIR_RE.test(base)) {
      return null;
    }
    // install.sh writes relative links; an absolute one must still point inside appDir.
    if (path.isAbsolute(target) && path.dirname(path.resolve(target)) !== path.resolve(appDir)) {
      return null;
    }
    return base;
  } catch {
    return null;
  }
}

/**
 * Point `<appDir>/<name>` at `<version>` atomically: a fresh temporary
 * symlink renamed over the old one. rename(2) replaces a symlink in one step
 * on Linux and macOS (unlike `mv`/`ln -sfn`, which follow a link to a
 * directory on BSD).
 */
export function swapVersionLink(appDir: string, name: string, version: string): void {
  if (!VERSION_DIR_RE.test(version)) {
    throw new Error(`refusing to point ${name} at "${version}" (not a version)`);
  }
  const tmp = path.join(appDir, `.${name}.${process.pid}.${Date.now().toString(36)}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(version, tmp);
  try {
    fs.renameSync(tmp, path.join(appDir, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Version directories in `appDir` (real directories named X.Y.Z), unsorted. */
export function listVersionDirs(appDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && VERSION_DIR_RE.test(e.name)).map((e) => e.name);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}${path.sep}`);
}

/**
 * Is version directory `dir` in use? Returns a live pid, or null. Same rule
 * as install.sh's bb_version_in_use: a `.pids/<pid>` marker whose process is
 * alive (dead markers are removed), or on Linux any visible process whose
 * executable or cwd is inside `dir`. `excludePids` skips this process (the
 * CLI doing the update runs from the old version directory itself).
 */
export function versionInUse(
  dir: string,
  opts: { excludePids?: number[]; procRoot?: string | null } = {},
): number | null {
  const exclude = new Set(opts.excludePids ?? [process.pid]);
  const pidsDir = path.join(dir, ".pids");
  let markers: string[] = [];
  try {
    markers = fs.readdirSync(pidsDir);
  } catch {
    markers = [];
  }
  for (const name of markers) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (exclude.has(pid)) {
      continue;
    }
    if (pidAlive(pid)) {
      return pid;
    }
    fs.rmSync(path.join(pidsDir, name), { force: true });
  }
  const procRoot = opts.procRoot === undefined ? "/proc" : opts.procRoot;
  if (!procRoot || !fs.existsSync(path.join(procRoot, "self"))) {
    return null;
  }
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // keep dir
  }
  let pids: string[] = [];
  try {
    pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const name of pids) {
    const pid = Number(name);
    if (exclude.has(pid)) {
      continue;
    }
    for (const link of ["exe", "cwd"]) {
      try {
        const target = fs.readlinkSync(path.join(procRoot, name, link));
        if (isInside(target, real) || isInside(target, dir)) {
          return pid;
        }
      } catch {
        // gone, or not ours to read
      }
    }
  }
  return null;
}

export type PruneResult = { removed: string[]; keptInUse: Array<{ version: string; pid: number }> };

/**
 * Remove version directories other than `current`, `previous` and `keep`,
 * skipping any that are in use. Never throws for a single directory.
 */
export function pruneVersionDirs(
  appDir: string,
  opts: { keep?: string[]; excludePids?: number[]; procRoot?: string | null } = {},
): PruneResult {
  const keep = new Set(
    [
      readVersionLink(appDir, CURRENT_LINK),
      readVersionLink(appDir, PREVIOUS_LINK),
      ...(opts.keep ?? []),
    ].filter((v): v is string => Boolean(v)),
  );
  const result: PruneResult = { removed: [], keptInUse: [] };
  for (const version of listVersionDirs(appDir)) {
    if (keep.has(version)) {
      continue;
    }
    const dir = path.join(appDir, version);
    const pid = versionInUse(dir, { excludePids: opts.excludePids, procRoot: opts.procRoot });
    if (pid !== null) {
      result.keptInUse.push({ version, pid });
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(version);
    } catch {
      // left for the next prune
    }
  }
  return result;
}

export type ManifestEntry =
  | { path: string; sha256: string; size: number; mode?: string }
  | { path: string; link: string };

export type TarballManifest = {
  version: string;
  platform: string;
  node?: string;
  orchestrator?: string;
  files: ManifestEntry[];
};

function isSafeRelative(p: string): boolean {
  if (!p || path.isAbsolute(p) || p.includes("\0")) {
    return false;
  }
  return !p.split(/[\\/]/).some((seg) => seg === ".." || seg === "");
}

/** manifest.json of a version directory (or null when missing / malformed). */
export function readTarballManifest(dir: string): TarballManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.version !== "string" || typeof m.platform !== "string" || !Array.isArray(m.files)) {
    return null;
  }
  const files: ManifestEntry[] = [];
  for (const raw of m.files) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.path !== "string" || !isSafeRelative(f.path)) {
      return null;
    }
    if (typeof f.link === "string") {
      files.push({ path: f.path, link: f.link });
    } else if (typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256)) {
      files.push({
        path: f.path,
        sha256: f.sha256,
        size: typeof f.size === "number" ? f.size : -1,
        mode: typeof f.mode === "string" ? f.mode : undefined,
      });
    } else {
      return null;
    }
  }
  return {
    version: m.version,
    platform: m.platform,
    node: typeof m.node === "string" ? m.node : undefined,
    orchestrator: typeof m.orchestrator === "string" ? m.orchestrator : undefined,
    files,
  };
}

/**
 * SHA-256 of a file, streamed in 1 MiB chunks: never buffers the whole file
 * (a memory database can exceed the 2 GiB a Buffer may hold) and yields to
 * the event loop between chunks (it also runs inside the gateway).
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fsp.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream({ highWaterMark: 1024 * 1024 })) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

export type ManifestCheck = {
  ok: boolean;
  /** Entries checked. */
  checked: number;
  /** The first problems found (capped), e.g. "dist/entry.js: sha256 mismatch". */
  problems: string[];
  /** Total problems (may exceed problems.length). */
  problemCount: number;
};

/**
 * Check a version directory against its manifest.json. `quick` checks that
 * every file exists with its recorded size and every symlink has its
 * recorded target (fast enough for doctor); `full` also hashes every file
 * (what the updater does before it activates a staged version).
 */
export async function verifyVersionDir(
  dir: string,
  opts: { mode: "quick" | "full"; concurrency?: number; maxProblems?: number } = { mode: "full" },
): Promise<ManifestCheck> {
  const manifest = readTarballManifest(dir);
  if (!manifest) {
    return {
      ok: false,
      checked: 0,
      problems: ["manifest.json missing or malformed"],
      problemCount: 1,
    };
  }
  const maxProblems = opts.maxProblems ?? 10;
  const problems: string[] = [];
  let problemCount = 0;
  const report = (msg: string) => {
    problemCount += 1;
    if (problems.length < maxProblems) {
      problems.push(msg);
    }
  };
  let next = 0;
  const entries = manifest.files;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= entries.length) {
        return;
      }
      const entry = entries[i]!;
      const full = path.join(dir, entry.path);
      try {
        if ("link" in entry) {
          const target = await fsp.readlink(full);
          if (target !== entry.link) {
            report(`${entry.path}: symlink points to ${target}, expected ${entry.link}`);
          }
          continue;
        }
        const st = await fsp.lstat(full);
        if (!st.isFile()) {
          report(`${entry.path}: not a regular file`);
          continue;
        }
        if (entry.size >= 0 && st.size !== entry.size) {
          report(`${entry.path}: size ${st.size}, expected ${entry.size}`);
          continue;
        }
        if (opts.mode === "full" && (await sha256File(full)) !== entry.sha256) {
          report(`${entry.path}: sha256 mismatch`);
        }
      } catch {
        report(`${entry.path}: missing`);
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, () => worker());
  await Promise.all(workers);
  return { ok: problemCount === 0, checked: entries.length, problems, problemCount };
}
