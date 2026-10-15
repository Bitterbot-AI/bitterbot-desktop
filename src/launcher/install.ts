/**
 * First-run (and catch-up) install of a signed release tarball by the npm
 * launcher. The layout, the verification and the activation are exactly
 * those of scripts/install.sh and the in-place updater, through the same
 * modules:
 *
 *   tarball-release.ts  release source (GitHub + pinned key; test mode only
 *                       with BITTERBOT_INSTALL_TEST_MODE=1 and a loopback
 *                       URL), minisign over checksums.txt with the exact
 *                       `v<version> checksums` trusted comment, then the
 *                       tarball's SHA-256. Any failure refuses (fail closed);
 *                       there is no unsigned fallback.
 *   tarball-install.ts  <appDir>/<version>, `current` and `previous` links
 *                       (atomic renames), manifest check, pruning.
 *   tarball-lock.ts     <appDir>/.update.lock, the same lock `bitterbot
 *                       update` takes, so the two never race.
 *
 * The tarball carries its own `.bitterbot-install-kind` marker and
 * `bin/bitterbot`, so what this leaves behind is indistinguishable from an
 * install.sh install. Unlike install.sh it does not link
 * ~/.local/bin/bitterbot (npm owns the `bitterbot` command here) and runs no
 * onboarding of its own (the app does that on first start).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_LINK,
  PREVIOUS_LINK,
  pruneVersionDirs,
  readTarballManifest,
  swapVersionLink,
  verifyVersionDir,
  versionInUse,
} from "../infra/tarball-install.js";
import { removeUpdateLeftovers } from "../infra/tarball-lock.js";
import {
  downloadVerifiedTarball,
  fetchVerifiedChecksums,
  ReleaseVerificationError,
  type ReleaseSource,
} from "../infra/tarball-release.js";
import { formatMegabytes, type LauncherOutput, tildify } from "./progress.js";

export type LauncherErrorKind =
  /** Signature, trusted comment or SHA-256 failure: never worked around. */
  | "verification"
  /** The release (or this platform's tarball) is not published yet. */
  | "unavailable"
  /** Offline, DNS, HTTP errors, a stalled download. */
  | "network"
  /** No space left on the disk. */
  | "disk"
  /** Anything else (a broken archive, a version in use, permissions). */
  | "other";

export class LauncherError extends Error {
  constructor(
    message: string,
    readonly kind: LauncherErrorKind,
  ) {
    super(message);
    this.name = "LauncherError";
  }
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ECONNABORTED",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

/** Map anything the install throws to a LauncherError with a calm message. */
export function classifyInstallError(err: unknown): LauncherError {
  if (err instanceof LauncherError) {
    return err;
  }
  if (err instanceof ReleaseVerificationError) {
    return new LauncherError(err.message, err.code);
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOSPC" || /no space left/i.test(message)) {
    return new LauncherError("there is not enough free disk space", "disk");
  }
  if (code && NETWORK_CODES.has(code)) {
    return new LauncherError(`could not reach the download server (${code})`, "network");
  }
  return new LauncherError(message, "other");
}

export type TarRunner = (tarball: string, dest: string) => Promise<void>;

/** Unpack with the system `tar` (bsdtar on macOS, GNU tar on Linux), like install.sh. */
export const systemTar: TarRunner = (tarball, dest) =>
  new Promise((resolve, reject) => {
    execFile(
      "tar",
      ["-xzf", tarball, "-C", dest],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const detail = String(stderr || err.message).trim();
        if (/no space left/i.test(detail)) {
          reject(new LauncherError("there is not enough free disk space", "disk"));
          return;
        }
        reject(
          new LauncherError(
            `could not unpack ${path.basename(tarball)}: ${detail.slice(0, 300)}`,
            "other",
          ),
        );
      },
    );
  });

export type InstallReleaseParams = {
  appDir: string;
  platformId: string;
  version: string;
  /** The version `current` points at now (null on a first run). */
  fromVersion: string | null;
  source: ReleaseSource;
  output: LauncherOutput;
  runTar?: TarRunner;
  procRoot?: string | null;
  /** Socket idle timeout for downloads (a moving download is never cut off). */
  idleTimeoutMs?: number;
};

export type InstallReleaseResult = { versionDir: string; reused: boolean };

/**
 * Download, verify, unpack and activate `version` in `appDir`. The caller
 * holds the app-dir lock. Throws a LauncherError; nothing is activated
 * unless every check passed, and staging leftovers are removed.
 */
export async function installReleaseVersion(
  params: InstallReleaseParams,
): Promise<InstallReleaseResult> {
  const { appDir, platformId, version, source, output } = params;
  const runTar = params.runTar ?? systemTar;
  const idle = params.idleTimeoutMs ?? 120_000;
  removeUpdateLeftovers(appDir, params.procRoot);

  let work: string | null = null;
  try {
    const verified = await fetchVerifiedChecksums(source, version, platformId, 60_000);
    work = await fsp.mkdtemp(path.join(appDir, ".update-"));
    let announced = false;
    const tarball = await downloadVerifiedTarball(
      source,
      verified,
      work,
      idle,
      (received, total) => {
        if (!announced) {
          announced = true;
          const size = total ? ` (${formatMegabytes(total)})` : "";
          output.say(
            params.fromVersion
              ? `Bitterbot ${version}: updating from ${params.fromVersion}, downloading the signed release${size}...`
              : `Bitterbot ${version}: first run, downloading the signed release${size}...`,
          );
        }
        output.progress(received, total);
      },
    );
    output.endProgress();

    const stage = path.join(work, "stage");
    await fsp.mkdir(stage);
    await runTar(tarball, stage);
    await fsp.rm(tarball, { force: true });
    const top = verified.asset.replace(/\.tar\.gz$/, "");
    const staged = path.join(stage, top);
    const manifest = readTarballManifest(staged);
    if (!manifest || manifest.version !== version || manifest.platform !== platformId) {
      throw new LauncherError(
        `${verified.asset} does not describe Bitterbot ${version} for ${platformId}`,
        "verification",
      );
    }
    if (!fs.existsSync(path.join(staged, "bin", "bitterbot"))) {
      throw new LauncherError(`${verified.asset} has no bin/bitterbot`, "verification");
    }
    // Every byte was already covered by the signed SHA-256 of the tarball;
    // this catches a truncated or mis-extracted unpack without re-hashing
    // the whole tree (the in-place updater does the full hash).
    const check = await verifyVersionDir(staged, { mode: "quick" });
    if (!check.ok) {
      throw new LauncherError(
        `the unpacked release does not match its manifest (${check.problems.join("; ")})`,
        "other",
      );
    }

    const finalDir = path.join(appDir, version);
    let reused = false;
    if (fs.existsSync(finalDir)) {
      const same =
        fs.existsSync(path.join(finalDir, "manifest.json")) &&
        fs.readFileSync(path.join(finalDir, "manifest.json"), "utf8") ===
          fs.readFileSync(path.join(staged, "manifest.json"), "utf8");
      if (same && (await verifyVersionDir(finalDir, { mode: "quick" })).ok) {
        reused = true;
      } else {
        const pid = versionInUse(finalDir, {
          excludePids: [process.pid],
          procRoot: params.procRoot,
        });
        if (pid !== null) {
          throw new LauncherError(
            `${tildify(finalDir)} must be replaced but a running Bitterbot (pid ${pid}) uses it. Stop it (bitterbot gateway stop) and try again.`,
            "other",
          );
        }
        const displaced = path.join(appDir, `.replaced.${version}.${process.pid}`);
        await fsp.rm(displaced, { recursive: true, force: true });
        await fsp.rename(finalDir, displaced);
        await fsp.rm(displaced, { recursive: true, force: true });
      }
    }
    if (!reused) {
      await fsp.rename(staged, finalDir);
    }

    if (params.fromVersion && params.fromVersion !== version) {
      swapVersionLink(appDir, PREVIOUS_LINK, params.fromVersion);
    }
    swapVersionLink(appDir, CURRENT_LINK, version);
    pruneVersionDirs(appDir, { excludePids: [process.pid], procRoot: params.procRoot });
    return { versionDir: finalDir, reused };
  } catch (err) {
    output.endProgress();
    throw classifyInstallError(err);
  } finally {
    if (work) {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
