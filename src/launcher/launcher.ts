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
 *   current older than target  -> install target (npm update of the
 *                                 launcher), run it; offline: run current
 *   current same or newer      -> run current (`bitterbot update` updated
 *                                 the app itself in place)
 *
 * The app it runs is a release-tarball install in every respect (its
 * bin/bitterbot declares the kind), so `bitterbot update` updates it in
 * place with snapshot and rollback; `npm install -g bitterbot@latest` works
 * too (the next run installs the newer launcher's version).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { createLauncherOutput, type LauncherOutput, tildify } from "./progress.js";
import { runApp, type RunDeps } from "./run.js";

/** Optional override of the install root (install.sh's `--dir`). */
export const APP_DIR_ENV = "BITTERBOT_APP_DIR";

const INSTALL_SH_ONE_LINER =
  "curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash";

export type LaunchDecision =
  | { action: "run"; version: string }
  | { action: "install"; from: string | null };

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

/** Run what is installed, or install the target first. */
export function decideLaunch(params: {
  current: string | null;
  currentRunnable: boolean;
  target: string;
}): LaunchDecision {
  const { current, target } = params;
  if (!current || !params.currentRunnable) {
    return { action: "install", from: current && params.currentRunnable ? current : null };
  }
  const cmp = compareReleaseVersions(current, target);
  if (cmp !== null && cmp >= 0) {
    return { action: "run", version: current };
  }
  return { action: "install", from: current };
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
      return `Bitterbot ${version} has no signed release build for ${platformId} yet (${err.message}).\nTry again in a while, or use Docker: ${DOCKER_DOC_URL}`;
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
  const output = deps.output ?? createLauncherOutput();
  const homedir = deps.homedir ?? os.homedir();
  const target = deps.version;

  const platform = detectLauncherPlatform(deps.probe);
  if (!platform.ok) {
    output.say(platform.message);
    return 1;
  }
  const appDir = resolveAppDir(deps.env, homedir);

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
        // Another launcher (or `bitterbot update`) may have installed it meanwhile.
        const again = decideLaunch({ ...inspectCurrent(appDir), target });
        if (again.action === "run") {
          return;
        }
        const result = await installReleaseVersion({
          appDir,
          platformId: platform.platformId,
          version: target,
          fromVersion: again.from,
          source,
          output,
          runTar: deps.runTar,
          procRoot: deps.procRoot,
        });
        output.say(
          result.reused
            ? `Bitterbot ${target} is installed in ${tildify(result.versionDir, homedir)}.`
            : `Verified and installed to ${tildify(result.versionDir, homedir)}.`,
        );
      });
    } catch (raw) {
      const err = classifyInstallError(raw);
      const installed = inspectCurrent(appDir);
      // An outage never blocks a working install; a failed verification
      // always stops (it is reported, and nothing older is silently run).
      if (err.kind !== "verification" && installed.current && installed.currentRunnable) {
        output.say(
          `Bitterbot ${target} could not be installed right now (${err.message}); running the installed ${installed.current}.`,
        );
      } else {
        output.say(failureAdvice(err, target, platform.platformId));
        return 1;
      }
    }
  }

  return runApp(appBinPath(appDir), deps.argv, deps.env, deps.run);
}
