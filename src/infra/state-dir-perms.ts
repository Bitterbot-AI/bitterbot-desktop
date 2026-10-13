/**
 * The state directory (~/.bitterbot, or BITTERBOT_STATE_DIR) holds config,
 * keys, memory and logs: only its owner may open it. A directory created
 * before (or by a tool that ignored this) can be 0755, which lets every
 * local user list its file names. The gateway and `bitterbot onboard` create
 * it 0700 and tighten an existing one once, with a one-line notice:
 *
 *   - never on Windows (ACLs, not mode bits);
 *   - never a directory owned by another user (a mounted container volume,
 *     a shared state dir): changing it could lock that owner out;
 *   - only the directory itself, never what is inside it.
 */

import fs from "node:fs";
import { shortenHomePath } from "../utils.js";

export type StateDirPermsResult =
  | { action: "created" | "tightened" | "ok"; dir: string; from?: number }
  | { action: "skipped"; dir: string; reason: "windows" | "not-owner" | "error"; detail?: string };

export function securePrivateStateDir(params: {
  stateDir: string;
  platform?: NodeJS.Platform;
  getuid?: () => number;
  fsImpl?: Pick<typeof fs, "existsSync" | "mkdirSync" | "statSync" | "chmodSync">;
}): StateDirPermsResult {
  const dir = params.stateDir;
  const platform = params.platform ?? process.platform;
  const fsImpl = params.fsImpl ?? fs;
  if (platform === "win32") {
    return { action: "skipped", dir, reason: "windows" };
  }
  try {
    if (!fsImpl.existsSync(dir)) {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The umask can only remove bits, but be exact.
      fsImpl.chmodSync(dir, 0o700);
      return { action: "created", dir };
    }
    const stat = fsImpl.statSync(dir);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) {
      return { action: "ok", dir };
    }
    const uid = (params.getuid ?? process.getuid)?.();
    if (uid === undefined || stat.uid !== uid) {
      return { action: "skipped", dir, reason: "not-owner" };
    }
    fsImpl.chmodSync(dir, 0o700);
    return { action: "tightened", dir, from: mode };
  } catch (err) {
    return { action: "skipped", dir, reason: "error", detail: String(err) };
  }
}

/** The notice for a tightened directory, or null. */
export function stateDirPermsNotice(result: StateDirPermsResult): string | null {
  if (result.action !== "tightened") {
    return null;
  }
  return `Made ${shortenHomePath(result.dir)} private (it was ${(result.from ?? 0).toString(8)}, readable by other users on this machine; now only you can open it).`;
}
