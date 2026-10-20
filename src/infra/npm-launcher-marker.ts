/**
 * How doctor (and anything else in the app) knows a release-tarball install
 * is driven by the npm launcher (src/launcher/) rather than install.sh:
 *
 *   - the launcher sets BITTERBOT_LAUNCHED_BY=npm and BITTERBOT_NPM_LAUNCHER
 *     (its own path) for the app it starts;
 *   - when the launcher installs a release it writes `<appDir>/.npm-launcher.json`,
 *     so a gateway started some other way later (a service, a direct run of
 *     <appDir>/current/bin/bitterbot) still knows.
 *
 * With either, npm owns the `bitterbot` command: doctor must not create
 * ~/.local/bin/bitterbot (install.sh's link), which would shadow the npm
 * launcher on PATH. Only `node:` imports (bundled into the launcher).
 */

import fs from "node:fs";
import path from "node:path";

export const LAUNCHED_BY_ENV = "BITTERBOT_LAUNCHED_BY";
export const NPM_LAUNCHER_PATH_ENV = "BITTERBOT_NPM_LAUNCHER";
export const NPM_LAUNCHER_MARKER = ".npm-launcher.json";

export type NpmLauncherInfo = {
  /** The launcher file (…/node_modules/bitterbot/bitterbot.mjs), when known. */
  launcher: string | null;
  source: "env" | "marker";
};

export function writeNpmLauncherMarker(
  appDir: string,
  info: { launcher: string | null; version: string },
): void {
  try {
    fs.writeFileSync(
      path.join(appDir, NPM_LAUNCHER_MARKER),
      `${JSON.stringify({ launcher: info.launcher, version: info.version, writtenAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Advisory only: the environment marker still covers launcher-started runs.
  }
}

/** The npm launcher that drives the install in `appDir`, or null for an install.sh install. */
export function readNpmLauncher(
  appDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NpmLauncherInfo | null {
  if (env[LAUNCHED_BY_ENV] === "npm") {
    return { launcher: env[NPM_LAUNCHER_PATH_ENV]?.trim() || null, source: "env" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appDir, NPM_LAUNCHER_MARKER), "utf8")) as {
      launcher?: unknown;
    };
    return {
      launcher: typeof parsed.launcher === "string" ? parsed.launcher : null,
      source: "marker",
    };
  } catch {
    return null;
  }
}
