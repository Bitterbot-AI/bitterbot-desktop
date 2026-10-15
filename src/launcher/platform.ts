/**
 * Which release tarball this machine can run, decided before anything is
 * downloaded. Same rules as scripts/install.sh (bb_detect_platform):
 * Linux x64/arm64 with glibc 2.28 or newer, macOS on Apple silicon or Intel
 * (an x64 Node under Rosetta still gets the native arm64 build). Everything
 * else gets one message naming the install path that does work there.
 */

import { execFileSync } from "node:child_process";
import { tarballPlatformId } from "../infra/install-kind.js";

export const DOCKER_DOC_URL =
  "https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md";
export const WINDOWS_DOC_URL =
  "https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/windows.md";
export const INSTALL_PS1_ONE_LINER =
  "irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex";

/** The bundled Node 22 runtime needs glibc 2.28 (Debian 10, Ubuntu 18.10, RHEL 8). */
export const MIN_GLIBC: readonly [number, number] = [2, 28];

export type PlatformProbe = {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux: the glibc version (`2.35`), or null on musl / when unknown. */
  glibcVersion: () => string | null;
  /** Linux: true on a musl libc (Alpine). */
  isMusl: () => boolean;
  /** macOS: true when this x64 process runs under Rosetta 2. */
  isRosetta: () => boolean;
};

export type PlatformResult = { ok: true; platformId: string } | { ok: false; message: string };

type ProcessReport = { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] };

let cachedReport: ProcessReport | null | undefined;

/** process.report (how Node itself tells glibc from musl), taken once. */
function processReport(): ProcessReport | null {
  if (cachedReport !== undefined) {
    return cachedReport;
  }
  try {
    const report = process.report as
      | { excludeNetwork?: boolean; getReport: () => unknown }
      | undefined;
    if (report && "excludeNetwork" in report) {
      // Skips the slow network-interface section where Node supports it.
      report.excludeNetwork = true;
    }
    cachedReport = (report?.getReport() as ProcessReport | undefined) ?? null;
  } catch {
    cachedReport = null;
  }
  return cachedReport;
}

function glibcFromReport(): string | null {
  return processReport()?.header?.glibcVersionRuntime ?? null;
}

function muslFromReport(): boolean {
  const report = processReport();
  if (!report || report.header?.glibcVersionRuntime) {
    return false;
  }
  return (report.sharedObjects ?? []).some((so) => /musl/i.test(so));
}

function rosettaFromSysctl(): boolean {
  try {
    return (
      execFileSync("sysctl", ["-n", "sysctl.proc_translated"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim() === "1"
    );
  } catch {
    return false;
  }
}

export function systemPlatformProbe(): PlatformProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    glibcVersion: glibcFromReport,
    isMusl: muslFromReport,
    isRosetta: rosettaFromSysctl,
  };
}

function glibcTooOld(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) {
    return false;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor < MIN_GLIBC[1]);
}

export function detectLauncherPlatform(probe: PlatformProbe): PlatformResult {
  const { platform } = probe;
  let arch = probe.arch;
  if (platform === "win32") {
    return {
      ok: false,
      message: [
        "Bitterbot does not run natively on Windows yet. Install it inside WSL2 instead.",
        `In PowerShell: ${INSTALL_PS1_ONE_LINER}`,
        "Or open your WSL2 terminal and run `npm install -g bitterbot` there.",
        `Details: ${WINDOWS_DOC_URL}`,
      ].join("\n"),
    };
  }
  if (platform === "linux") {
    if (probe.isMusl()) {
      return {
        ok: false,
        message: `musl-based Linux (for example Alpine) is not supported by the release build. Use Docker: ${DOCKER_DOC_URL}`,
      };
    }
    const glibc = probe.glibcVersion();
    if (glibc && glibcTooOld(glibc)) {
      return {
        ok: false,
        message: `glibc ${glibc} is too old: Bitterbot's bundled Node needs glibc ${MIN_GLIBC.join(".")} or newer (Debian 10, Ubuntu 18.10, RHEL 8 or later). Use Docker: ${DOCKER_DOC_URL}`,
      };
    }
  }
  if (platform === "darwin" && arch === "x64" && probe.isRosetta()) {
    arch = "arm64";
  }
  const platformId = tarballPlatformId(platform, arch);
  if (!platformId) {
    return {
      ok: false,
      message: `There is no Bitterbot release build for ${platform} ${arch}. Use Docker: ${DOCKER_DOC_URL}`,
    };
  }
  return { ok: true, platformId };
}
