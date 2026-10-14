/**
 * The state directory (~/.bitterbot, or BITTERBOT_STATE_DIR) holds config,
 * keys, memory and logs. The gateway and `bitterbot onboard` check it on
 * start (install.sh does the same):
 *
 *   - missing: created 0700;
 *   - exactly a default-umask result (0755, 0775, 0777, no special bits):
 *     set to 0700;
 *   - anything else: only the "other users" bits are removed, so deliberate
 *     group sharing (and setgid) keeps working;
 *   - never on Windows (ACLs, not mode bits), never a directory owned by
 *     another user (a mounted volume), never your home directory, "/" or a
 *     parent of home, only the directory itself (never the files in it), and
 *     not at all with BITTERBOT_STATE_DIR_PERMS=keep;
 *   - a filesystem that ignores chmod (drvfs, some FUSE/CIFS mounts) is
 *     reported as unsupported, never as fixed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shortenHomePath } from "../utils.js";
import { looksLikeContainer } from "./install-kind.js";

export type StateDirPermsResult =
  | { action: "created" | "ok"; dir: string }
  | { action: "tightened"; dir: string; from: number; to: number }
  | {
      action: "skipped";
      dir: string;
      reason:
        | "windows"
        | "container"
        | "not-owner"
        | "opted-out"
        | "unsafe-dir"
        | "unsupported"
        | "error";
      detail?: string;
    };

const UMASK_DEFAULTS = new Set([0o755, 0o775, 0o777]);

/** True when `dir` is home, the root, or a parent of home: never chmod those. */
export function isUnsafeStateDir(dir: string, home: string): boolean {
  const d = path.resolve(dir);
  const h = path.resolve(home);
  if (d === path.parse(d).root || d === h) {
    return true;
  }
  return h.startsWith(d.endsWith(path.sep) ? d : `${d}${path.sep}`);
}

/** The mode a state dir should get, or null when it is fine as it is. */
export function targetStateDirMode(mode: number): number | null {
  const perm = mode & 0o777;
  const special = mode & 0o7000;
  if (special === 0 && UMASK_DEFAULTS.has(perm)) {
    return 0o700;
  }
  if ((perm & 0o007) !== 0) {
    return mode & 0o7777 & ~0o007;
  }
  return null;
}

export function securePrivateStateDir(params: {
  stateDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  getuid?: () => number;
  /** Defaults to detecting a container (Docker, Podman). */
  inContainer?: boolean;
  fsImpl?: Pick<typeof fs, "existsSync" | "mkdirSync" | "statSync" | "chmodSync">;
}): StateDirPermsResult {
  const dir = params.stateDir;
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const fsImpl = params.fsImpl ?? fs;
  if (platform === "win32") {
    return { action: "skipped", dir, reason: "windows" };
  }
  // In a container the state dir is usually a bind mount the host user also
  // reads (backups, `docker compose` volumes); the container is the isolation.
  if (params.inContainer ?? looksLikeContainer()) {
    return { action: "skipped", dir, reason: "container" };
  }
  if (env.BITTERBOT_STATE_DIR_PERMS?.trim().toLowerCase() === "keep") {
    return { action: "skipped", dir, reason: "opted-out" };
  }
  if (isUnsafeStateDir(dir, params.homedir ?? os.homedir())) {
    return { action: "skipped", dir, reason: "unsafe-dir" };
  }
  try {
    if (!fsImpl.existsSync(dir)) {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fsImpl.chmodSync(dir, 0o700);
      return { action: "created", dir };
    }
    const stat = fsImpl.statSync(dir);
    const mode = stat.mode & 0o7777;
    const target = targetStateDirMode(mode);
    if (target === null) {
      return { action: "ok", dir };
    }
    const uid = (params.getuid ?? process.getuid)?.();
    if (uid === undefined || stat.uid !== uid) {
      return { action: "skipped", dir, reason: "not-owner" };
    }
    fsImpl.chmodSync(dir, target);
    const after = fsImpl.statSync(dir).mode & 0o7777;
    if (after === mode) {
      return { action: "skipped", dir, reason: "unsupported" };
    }
    return { action: "tightened", dir, from: mode, to: after };
  } catch (err) {
    return { action: "skipped", dir, reason: "error", detail: String(err) };
  }
}

/** The one-line notice for a tightened directory, or null. */
export function stateDirPermsNotice(result: StateDirPermsResult): string | null {
  if (result.action !== "tightened") {
    return null;
  }
  const shown = shortenHomePath(result.dir);
  const from = result.from.toString(8);
  if ((result.to & 0o077) === 0) {
    return `Made ${shown} private (it was ${from}, readable by other users on this machine; now only you can open it). Keep it as it was with BITTERBOT_STATE_DIR_PERMS=keep.`;
  }
  return `Removed access for other users from ${shown} (it was ${from}; group access is kept). Keep it as it was with BITTERBOT_STATE_DIR_PERMS=keep.`;
}
