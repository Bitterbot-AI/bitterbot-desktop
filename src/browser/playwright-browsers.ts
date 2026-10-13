/**
 * Which Chromium build the installed playwright-core expects, whether it is
 * downloaded, and the exact command that downloads it, for `bitterbot doctor`
 * and the browser tool's launch errors.
 *
 * The browser tool itself starts a system Chrome/Brave/Edge/Chromium, or
 * Playwright's downloaded Chromium of any revision, and attaches over CDP
 * (src/browser/chrome.ts, chrome.executables.ts). Code that calls
 * `chromium.launch()` instead (an agent-written script, a skill) needs the
 * exact `chromium-<rev>` / `chromium_headless_shell-<rev>` build the
 * installed playwright-core pins, and fails with a raw "Executable doesn't
 * exist" stack after a Playwright bump until it is downloaded. Both surfaces
 * print the same version-matched fix, never a bare `npx playwright install`
 * (which installs whatever Playwright npm has today, not the pinned one).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveBitterbotPackageRootSync } from "../infra/bitterbot-root.js";
import { detectInstallKind, type InstallKind } from "../infra/install-kind.js";

export type PlaywrightBrowserRevisions = {
  /** playwright-core's own version, e.g. "1.63.0". */
  version: string | null;
  /** Revision of the full Chromium (`chromium-<rev>`). */
  chromium: string | null;
  /** Revision of Chrome Headless Shell (`chromium_headless_shell-<rev>`). */
  headlessShell: string | null;
};

export type PlaywrightBrowserState = {
  revisions: PlaywrightBrowserRevisions;
  browsersDir: string;
  chromiumInstalled: boolean;
  headlessShellInstalled: boolean;
  /** Revisions present on disk for either Chromium flavour, newest first. */
  installedRevisions: string[];
};

type FsProbe = {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
};

/** The playwright-core package directory Bitterbot resolves, or null. */
export function resolvePlaywrightCoreDir(packageRoot?: string | null): string | null {
  try {
    const req = createRequire(
      packageRoot ? path.join(packageRoot, "package.json") : import.meta.url,
    );
    return path.dirname(req.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

/** The Chromium revisions playwright-core pins (its browsers.json). */
export function readPlaywrightBrowserRevisions(
  pwDir: string,
  probe: FsProbe = {},
): PlaywrightBrowserRevisions | null {
  const readFile = probe.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  let version: string | null = null;
  try {
    const pkg = JSON.parse(readFile(path.join(pwDir, "package.json"))) as { version?: unknown };
    version = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    version = null;
  }
  try {
    const parsed = JSON.parse(readFile(path.join(pwDir, "browsers.json"))) as {
      browsers?: Array<{ name?: unknown; revision?: unknown }>;
    };
    const revisionOf = (name: string) => {
      const entry = parsed.browsers?.find((b) => b?.name === name);
      return typeof entry?.revision === "string" ? entry.revision : null;
    };
    return {
      version,
      chromium: revisionOf("chromium"),
      headlessShell: revisionOf("chromium-headless-shell"),
    };
  } catch {
    return null;
  }
}

/** Where Playwright keeps downloaded browsers (its registryDirectory rules). */
export function resolvePlaywrightBrowsersDir(
  params: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homedir?: string;
    pwDir?: string | null;
  } = {},
): string {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const home = params.homedir ?? os.homedir();
  const override = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override === "0" && params.pwDir) {
    return path.join(params.pwDir, ".local-browsers");
  }
  if (override && override !== "0") {
    return path.resolve(override);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  if (platform === "win32") {
    return path.join(
      env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return path.join(env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"), "ms-playwright");
}

/** Is the Chromium build this playwright-core pins downloaded? */
export function inspectPlaywrightBrowsers(params: {
  pwDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  probe?: FsProbe;
}): PlaywrightBrowserState | null {
  const revisions = readPlaywrightBrowserRevisions(params.pwDir, params.probe);
  if (!revisions || (!revisions.chromium && !revisions.headlessShell)) {
    return null;
  }
  const browsersDir = resolvePlaywrightBrowsersDir({ ...params });
  const exists = params.probe?.exists ?? ((p: string) => fs.existsSync(p));
  const listDir =
    params.probe?.listDir ??
    ((p: string) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    });
  const installedRevisions = [
    ...new Set(
      listDir(browsersDir)
        .map((name) => /^chromium(?:_headless_shell)?-(\d+)$/.exec(name)?.[1])
        .filter((rev): rev is string => Boolean(rev)),
    ),
  ].toSorted((a, b) => Number(b) - Number(a));
  return {
    revisions,
    browsersDir,
    chromiumInstalled: revisions.chromium
      ? exists(path.join(browsersDir, `chromium-${revisions.chromium}`))
      : true,
    headlessShellInstalled: revisions.headlessShell
      ? exists(path.join(browsersDir, `chromium_headless_shell-${revisions.headlessShell}`))
      : true,
    installedRevisions,
  };
}

function quoteArg(value: string): string {
  return /[\s"'$`\\]/.test(value) ? `"${value.replace(/(["$`\\])/g, "\\$1")}"` : value;
}

/**
 * The exact command that downloads the Chromium build this playwright-core
 * pins (`install chromium` brings the headless shell too). A source checkout
 * uses its own pinned binary through pnpm; every other install runs the
 * bundled playwright-core CLI with the Node that runs Bitterbot, so no
 * system Node or npm download is involved. A release-tarball install keeps
 * browsers in ~/.bitterbot/browsers, where its launcher points Playwright.
 */
export function playwrightInstallCommand(params: {
  installKind: InstallKind;
  pwDir: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  execPath?: string;
}): string {
  if (params.installKind === "git") {
    return "pnpm exec playwright-core install chromium";
  }
  if (!params.pwDir) {
    return "npx playwright-core install chromium";
  }
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const execPath = params.execPath ?? process.execPath;
  const cli = `${quoteArg(execPath)} ${quoteArg(path.join(params.pwDir, "cli.js"))} install chromium`;
  if (platform === "win32") {
    return cli;
  }
  const explicit = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const browsersPath =
    explicit ||
    (params.installKind === "tarball"
      ? path.join(params.homedir ?? os.homedir(), ".bitterbot", "browsers")
      : "");
  return browsersPath ? `PLAYWRIGHT_BROWSERS_PATH=${quoteArg(browsersPath)} ${cli}` : cli;
}

/** The fix command for this process, detecting the install kind and playwright-core. */
export function resolvePlaywrightInstallCommand(): string {
  let root: string | null = null;
  try {
    root = resolveBitterbotPackageRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  } catch {
    root = null;
  }
  let installKind: InstallKind = "unknown";
  try {
    installKind = detectInstallKind(root);
  } catch {
    installKind = "unknown";
  }
  return playwrightInstallCommand({ installKind, pwDir: resolvePlaywrightCoreDir(root) });
}

/** Playwright's "the browser build is not downloaded" launch failure. */
export function looksLikeMissingPlaywrightBrowser(message: string): boolean {
  return (
    /Executable doesn't exist at/i.test(message) ||
    /chromium_headless_shell-\d+/.test(message) ||
    /Looks like Playwright .* was just installed or updated/i.test(message) ||
    /Please run the following command to download new browsers/i.test(message)
  );
}

/** A short, actionable replacement for Playwright's missing-browser stack. */
export function describeMissingPlaywrightBrowser(fixCommand: string, rawMessage?: string): string {
  const missing = rawMessage
    ? /(chromium(?:_headless_shell)?-\d+)/.exec(rawMessage)?.[1]
    : undefined;
  return (
    `The browser could not start: Playwright's Chromium build${missing ? ` (${missing})` : ""} ` +
    `for the installed Playwright version is not downloaded. Fix: run \`${fixCommand}\`, then try again. ` +
    "Run `bitterbot doctor` to check the browser setup."
  );
}
