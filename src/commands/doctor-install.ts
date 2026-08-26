import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { note } from "../terminal/note.js";

/**
 * Filesystem type of the checkout, or null when it cannot be determined.
 * Linux-only by design: the mount-type problem this feeds exists on WSL2.
 */
export function detectCheckoutFilesystem(root: string): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    // `stat -f -c %T` prints the filesystem type name ("ext4", "v9fs", ...).
    return execFileSync("stat", ["-f", "-c", "%T", root], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

/** Windows-drive filesystems as seen from inside WSL. */
const SLOW_WSL_FILESYSTEMS = new Set(["v9fs", "9p", "drvfs"]);

/**
 * Warn when the checkout lives on a Windows drive mounted into WSL. Measured
 * on the reference node (2026-08-24): gateway boot 1757s on /mnt/d (9p) vs
 * 40.8s after moving the same checkout to ~ (ext4) — 43x — and the jiti
 * module-load path alone was 75x slower. This is the single biggest
 * performance lever a WSL user has, and it is invisible without a probe.
 */
export function checkCheckoutFilesystem(
  root: string,
  fsType: string | null = detectCheckoutFilesystem(root),
): string | null {
  if (!fsType || !SLOW_WSL_FILESYSTEMS.has(fsType.toLowerCase())) {
    return null;
  }
  return (
    `- checkout is on a Windows drive mount (${fsType}). Everything here is ` +
    "10-75x slower than the Linux filesystem: boots that take seconds on ext4 " +
    "take minutes on /mnt/*. Move the checkout, e.g.:\n" +
    "    rsync -a " +
    root +
    "/ ~/bitterbot-desktop/ && cd ~/bitterbot-desktop"
  );
}

export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");
  const srcEntry = path.join(root, "src", "entry.ts");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install");
  }

  const fsWarning = checkCheckoutFilesystem(root);
  if (fsWarning) {
    warnings.push(fsWarning);
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}
