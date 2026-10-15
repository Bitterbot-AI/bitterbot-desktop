/**
 * Entry point of the published `bitterbot` npm package (bitterbot.mjs),
 * bundled by scripts/npm-package.ts into one file with only `node:` imports.
 * The version is the release this launcher installs, embedded at build time.
 *
 * Expected failures (unsupported platform, offline, disk full, a refused
 * signature) are reported in a sentence or two by runLauncher; only a bug
 * reaches the catch below, and even then without a stack trace unless
 * BITTERBOT_LAUNCHER_DEBUG=1.
 */

import { fileURLToPath } from "node:url";
import { runLauncher } from "./launcher.js";
import { systemPlatformProbe } from "./platform.js";

declare const __BITTERBOT_LAUNCHER_VERSION__: string;

/** This bundle's own file (also when started through a dist/ compat shim). */
function launcherFile(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

const version =
  typeof __BITTERBOT_LAUNCHER_VERSION__ === "string" ? __BITTERBOT_LAUNCHER_VERSION__ : "0.0.0";

runLauncher({
  argv: process.argv.slice(2),
  env: process.env,
  version,
  probe: systemPlatformProbe(),
  launcherPath: launcherFile(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const debug = process.env.BITTERBOT_LAUNCHER_DEBUG === "1";
    const detail =
      err instanceof Error ? (debug ? (err.stack ?? err.message) : err.message) : String(err);
    process.stderr.write(`bitterbot: the launcher failed unexpectedly: ${detail}\n`);
    process.exitCode = 1;
  },
);
