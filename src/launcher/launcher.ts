/**
 * The `bitterbot` npm package is this launcher (and nothing else): no
 * dependencies, no install scripts. npm 12 blocks dependency install scripts
 * on global installs by default and a package cannot pre-approve itself, and
 * the old full package (1,500 packages, ~2.3 GB, a postinstall download)
 * took half an hour and printed dozens of warnings. So the package stays
 * tiny and, on first run, installs the same signed per-platform release
 * tarball that scripts/install.sh installs (bundled Node runtime,
 * node_modules, orchestrator), then runs it.
 *
 *   target  = this launcher's own version (embedded at build time)
 *   current = <appDir>/current (default ~/.bitterbot/app, like install.sh)
 *
 *   current missing or broken  -> install target, run it
 *   current installed          -> run it, whatever its version
 *
 * The launcher never replaces an installed version. Upgrades (and
 * downgrades, `bitterbot update --rollback`, `--tag <older>`) belong to the
 * app's own updater, which snapshots data, verifies the new version boots
 * and rolls back if it does not, and never swaps a version under a running
 * gateway. When the installed app is older than the launcher (after
 * `npm install -g bitterbot@latest`), an interactive run prints one line
 * suggesting `bitterbot update`; a rollback is never undone.
 *
 * The app it runs is a release-tarball install in every respect (its
 * bin/bitterbot declares the kind).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LAUNCHED_BY_ENV,
  NPM_LAUNCHER_PATH_ENV,
  writeNpmLauncherMarker,
} from "../infra/npm-launcher-marker.js";
import { compareReleaseVersions } from "../infra/release-assets.js";
import { defaultTarballAppDir, readVersionLink } from "../infra/tarball-install.js";
import { acquireTarballLock, TarballLockError } from "../infra/tarball-lock.js";
import { resolveReleaseSource, type ReleaseSource } from "../infra/tarball-release.js";
import {
  classifyInstallError,
  installReleaseVersion,
  LauncherError,
  type TarRunner,
} from "./install.js";
import { detectLauncherPlatform, DOCKER_DOC_URL, type PlatformProbe } from "./platform.js";
import { createDefaultLauncherOutput, type LauncherOutput, tildify } from "./progress.js";
import { runApp, type RunDeps } from "./run.js";

/** Optional override of the install root (install.sh's `--dir`). */
export const APP_DIR_ENV = "BITTERBOT_APP_DIR";

const INSTALL_SH_ONE_LINER =
  "curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash";

export type LaunchDecision =
  /** `newer`: the launcher's version when it is newer than the installed one. */
  { action: "run"; version: string; newer: string | null } | { action: "install" };

/** Where the npm-package docs explain installing without sudo. */
export const NO_SUDO_DOC_URL =
  "https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/start/npm.md#eacces-permission-denied";

/** Set to 1 to run as root anyway (a container, a dedicated root-only box). */
export const ALLOW_ROOT_ENV = "BITTERBOT_ALLOW_ROOT";

/** The command a version directory runs: what ~/.local/bin/bitterbot points at for install.sh. */
export function appBinPath(appDir: string, version = "current"): string {
  return path.join(appDir, version, "bin", "bitterbot");
}

function isRunnable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run what is installed; install the target only when nothing usable is
 * installed. Never replaces an installed version (see the header).
 */
export function decideLaunch(params: {
  current: string | null;
  currentRunnable: boolean;
  target: string;
}): LaunchDecision {
  const { current, target } = params;
  if (!current || !params.currentRunnable) {
    return { action: "install" };
  }
  const cmp = compareReleaseVersions(current, target);
  return { action: "run", version: current, newer: cmp !== null && cmp < 0 ? target : null };
}

/**
 * Whether to print the "newer version available" hint: only for a person at
 * a terminal, never for a gateway start (a service log), `--version`, or
 * machine-readable output.
 */
export function shouldShowUpgradeHint(argv: string[], interactive: boolean): boolean {
  if (!interactive) {
    return false;
  }
  if (argv[0] === "gateway" || argv[0] === "daemon" || argv[0] === "node") {
    return false;
  }
  return !argv.some((a) => a === "--version" || a === "-V" || a === "-v" || a === "--json");
}

/**
 * Refuse root (unless BITTERBOT_ALLOW_ROOT=1) and an app dir owned by
 * someone else (a leftover of `sudo bitterbot`): installing or updating
 * there would fail, or leave root-owned files in the user's home.
 */
export function ownershipProblem(params: {
  appDir: string;
  env: NodeJS.ProcessEnv;
  uid: number | null;
}): string | null {
  const { appDir, env, uid } = params;
  if (uid === null || env[ALLOW_ROOT_ENV] === "1") {
    return null;
  }
  if (uid === 0) {
    return [
      "Bitterbot runs as your user and keeps its data in your home directory, so it refuses to run as root (sudo).",
      "Run it again without sudo. If npm needed sudo to install it, fix npm instead:",
      `  ${NO_SUDO_DOC_URL}`,
      `(To run as root anyway, for example in a container, set ${ALLOW_ROOT_ENV}=1.)`,
    ].join("\n");
  }
  for (const dir of [appDir, path.dirname(appDir)]) {
    let owner: number | null = null;
    try {
      owner = fs.statSync(dir).uid;
    } catch {
      continue;
    }
    if (owner !== uid) {
      return [
        `${dir} belongs to another user (uid ${owner}), probably from an earlier run with sudo.`,
        `Give it back to yourself: sudo chown -R "$(whoami)" ${JSON.stringify(dir)}`,
        `Then run bitterbot again without sudo. Details: ${NO_SUDO_DOC_URL}`,
      ].join("\n");
    }
  }
  return null;
}

export function resolveAppDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const override = env[APP_DIR_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  return defaultTarballAppDir(homedir);
}

function inspectCurrent(appDir: string): { current: string | null; currentRunnable: boolean } {
  const current = readVersionLink(appDir, "current");
  return { current, currentRunnable: current !== null && isRunnable(appBinPath(appDir)) };
}

export type LauncherDeps = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** This launcher's version (the release it installs). */
  version: string;
  homedir?: string;
  probe: PlatformProbe;
  output?: LauncherOutput;
  runTar?: TarRunner;
  run?: RunDeps;
  procRoot?: string | null;
  /** How long to wait for another install holding the lock (default 30 min). */
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** This launcher's own file, passed to the app and the app-dir marker. */
  launcherPath?: string | null;
  /** A person at a terminal (default: stdin and stderr are TTYs). */
  interactive?: boolean;
  /** The effective uid (default process.getuid(); null where there is none). */
  uid?: number | null;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withAppLock<T>(
  appDir: string,
  deps: LauncherDeps,
  output: LauncherOutput,
  fn: () => Promise<T>,
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + (deps.lockWaitMs ?? 30 * 60_000);
  let told = false;
  for (;;) {
    let release: (() => void) | null = null;
    try {
      release = acquireTarballLock(appDir);
    } catch (err) {
      if (!(err instanceof TarballLockError)) {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new LauncherError(
          `another Bitterbot install or update is still running${err.pid ? ` (pid ${err.pid})` : ""}; try again when it finishes`,
          "other",
        );
      }
      if (!told) {
        told = true;
        output.say(
          `Waiting for another Bitterbot install or update to finish${err.pid ? ` (pid ${err.pid})` : ""}...`,
        );
      }
      await sleep(1000);
      continue;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function failureAdvice(err: LauncherError, version: string, platformId: string): string {
  switch (err.kind) {
    case "verification":
      return `Refusing to install Bitterbot ${version}: ${err.message}\nNothing was changed. Please report this at https://github.com/Bitterbot-AI/bitterbot-desktop/issues`;
    case "unavailable":
      return err.missing === "release"
        ? `Bitterbot ${version} was not found on GitHub Releases yet (${err.message}).\nTry again in a while, or install with: ${INSTALL_SH_ONE_LINER}`
        : `Bitterbot ${version} has no release build for ${platformId} yet (${err.message}).\nTry again in a while, or use Docker: ${DOCKER_DOC_URL}`;
    case "network":
      return `Could not download Bitterbot ${version}: ${err.message}.\nCheck your internet connection and run bitterbot again.`;
    case "disk":
      return `Could not install Bitterbot ${version}: ${err.message} (it needs about 1.5 GB).\nFree some space and run bitterbot again.`;
    case "other":
      return `Could not install Bitterbot ${version}: ${err.message}\nYou can also install with: ${INSTALL_SH_ONE_LINER}`;
  }
}

/** The whole launcher. Resolves with the process exit code. */
export async function runLauncher(deps: LauncherDeps): Promise<number> {
  const output = deps.output ?? createDefaultLauncherOutput();
  const homedir = deps.homedir ?? os.homedir();
  const target = deps.version;

  const platform = detectLauncherPlatform(deps.probe);
  if (!platform.ok) {
    output.say(platform.message);
    return 1;
  }
  const appDir = resolveAppDir(deps.env, homedir);
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  const ownership = ownershipProblem({ appDir, env: deps.env, uid });
  if (ownership) {
    output.say(ownership);
    return 1;
  }
  const launcherPath = deps.launcherPath ?? null;

  const decision = decideLaunch({ ...inspectCurrent(appDir), target });
  if (decision.action === "install") {
    let source: ReleaseSource;
    try {
      // allowTestMode: the base-URL / key overrides are honoured only with
      // BITTERBOT_INSTALL_TEST_MODE=1 AND a loopback or file:/// URL (CI);
      // otherwise this is always GitHub Releases + the pinned key.
      source = resolveReleaseSource({ allowTestMode: true, env: deps.env });
    } catch (err) {
      output.say(`bitterbot: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    try {
      // ~/.bitterbot holds keys and memory: created private, like the app does.
      fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
      await withAppLock(appDir, deps, output, async () => {
        // Another launcher (or install.sh) may have installed one meanwhile.
        if (decideLaunch({ ...inspectCurrent(appDir), target }).action === "run") {
          return;
        }
        const result = await installReleaseVersion({
          appDir,
          platformId: platform.platformId,
          version: target,
          fromVersion: null,
          source,
          output,
          runTar: deps.runTar,
          procRoot: deps.procRoot,
        });
        writeNpmLauncherMarker(appDir, { launcher: launcherPath, version: target });
        output.say(
          result.reused
            ? `Bitterbot ${target} is installed in ${tildify(result.versionDir, homedir)}.`
            : `Verified and installed to ${tildify(result.versionDir, homedir)}.`,
        );
      });
    } catch (raw) {
      output.say(failureAdvice(classifyInstallError(raw), target, platform.platformId));
      return 1;
    }
  } else if (decision.newer) {
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (shouldShowUpgradeHint(deps.argv, interactive)) {
      output.say(
        `Bitterbot ${decision.newer} is available (you have ${decision.version}). Run \`bitterbot update\` to upgrade safely.`,
      );
    }
  }

  const env: NodeJS.ProcessEnv = { ...deps.env, [LAUNCHED_BY_ENV]: "npm" };
  if (launcherPath) {
    env[NPM_LAUNCHER_PATH_ENV] = launcherPath;
  }
  return runApp(appBinPath(appDir), deps.argv, env, deps.run);
}
