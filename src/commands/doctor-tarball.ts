/**
 * Doctor checks for release-tarball installs (PLAN-56 Phase 3b): the
 * `current`/`previous` symlinks, the `~/.local/bin/bitterbot` command link,
 * the running version directory against its manifest.json, leftovers of an
 * interrupted update, and the pre-update snapshots.
 *
 * `doctor --fix` repairs the links (a broken `current` points back at the
 * running version, or the newest intact one; a missing or dangling command
 * link is recreated; a dangling `previous` is removed). A version directory
 * that fails its manifest is never patched in place: doctor names
 * `bitterbot update --reinstall`, which downloads and verifies it again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type InstallKind,
  TARBALL_INSTALLER_COMMAND,
  TARBALL_REINSTALL_COMMAND,
} from "../infra/install-kind.js";
import {
  CURRENT_LINK,
  listVersionDirs,
  PREVIOUS_LINK,
  readVersionLink,
  resolveTarballLayout,
  swapVersionLink,
  tarballCommandLinkPath,
  verifyVersionDir,
} from "../infra/tarball-install.js";
import { compareSemverStrings } from "../infra/update-check.js";
import { listSnapshots, snapshotsRoot } from "../infra/update-snapshot.js";
import { type CheckResult, error, info, ok, renderSection, warn } from "./doctor-check.js";

function hasLauncher(appDir: string, version: string): boolean {
  try {
    fs.accessSync(path.join(appDir, version, "bin", "bitterbot"), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function linkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

type TarballCheckParams = {
  installKind: InstallKind;
  root: string | null;
  repair: boolean;
  deep: boolean;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

/** Never throws: a failed repair (permissions, a full disk) becomes a finding. */
export async function runTarballInstallChecks(params: TarballCheckParams): Promise<CheckResult[]> {
  try {
    return await checkTarballInstall(params);
  } catch (err) {
    const results = [warn(`Install checks failed: ${String(err)}`)];
    renderSection("Install", results);
    return results;
  }
}

async function checkTarballInstall(params: {
  installKind: InstallKind;
  root: string | null;
  repair: boolean;
  deep: boolean;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<CheckResult[]> {
  if (params.installKind !== "tarball") {
    return [];
  }
  const env = params.env ?? process.env;
  const results: CheckResult[] = [];
  const layout = resolveTarballLayout(env.BITTERBOT_INSTALL_ROOT?.trim() || params.root);
  if (!layout) {
    results.push(
      warn(
        `Release-tarball install, but ${params.root ?? "the package root"} is not an <app>/<version> directory. Re-run the installer: ${TARBALL_INSTALLER_COMMAND}`,
      ),
    );
    renderSection("Install", results);
    return results;
  }
  const { appDir } = layout;

  // current -> <version>
  const current = readVersionLink(appDir, CURRENT_LINK);
  if (current && hasLauncher(appDir, current)) {
    results.push(ok(`current -> ${current} (${appDir})`));
  } else {
    const candidates = [
      layout.version,
      ...listVersionDirs(appDir).toSorted((a, b) => compareSemverStrings(b, a) ?? 0),
    ].filter((v) => hasLauncher(appDir, v));
    const fixTo = candidates[0] ?? null;
    const what = current ? `current -> ${current} has no launcher` : "current is missing";
    if (params.repair && fixTo) {
      swapVersionLink(appDir, CURRENT_LINK, fixTo);
      results.push(ok(`${what}; repaired: current -> ${fixTo}`));
    } else if (fixTo) {
      results.push(warn(`${what}. Run "bitterbot doctor --fix" to point it at ${fixTo}.`));
    } else {
      results.push(
        error(
          `${what} and no intact version is installed. Re-run the installer: ${TARBALL_INSTALLER_COMMAND}`,
        ),
      );
    }
  }

  // previous -> <version> (rollback target)
  const prevLink = path.join(appDir, PREVIOUS_LINK);
  const previous = readVersionLink(appDir, PREVIOUS_LINK);
  if (previous && hasLauncher(appDir, previous)) {
    results.push(info(`previous -> ${previous} (bitterbot update --rollback switches to it)`));
  } else if (linkTarget(prevLink) !== null) {
    if (params.repair) {
      fs.rmSync(prevLink, { force: true });
      results.push(ok("previous pointed at a missing version; removed the dangling link"));
    } else {
      results.push(
        warn(
          'previous points at a missing version. Run "bitterbot doctor --fix" to remove the link.',
        ),
      );
    }
  }

  // ~/.local/bin/bitterbot -> <appDir>/current/bin/bitterbot
  const commandLink = tarballCommandLinkPath(params.homedir ?? os.homedir());
  const expected = path.join(appDir, CURRENT_LINK, "bin", "bitterbot");
  const target = linkTarget(commandLink);
  let lst: fs.Stats | null = null;
  try {
    lst = fs.lstatSync(commandLink);
  } catch {
    lst = null;
  }
  if (target === expected) {
    results.push(ok(`${commandLink} -> ${expected}`));
  } else if (lst && !lst.isSymbolicLink()) {
    results.push(
      warn(
        `${commandLink} is a file, not the installer's link; left alone. Remove it to let doctor --fix relink it.`,
      ),
    );
  } else {
    const dangling =
      target !== null && !fs.existsSync(path.resolve(path.dirname(commandLink), target));
    if (target === null || dangling) {
      if (params.repair) {
        fs.mkdirSync(path.dirname(commandLink), { recursive: true });
        fs.rmSync(commandLink, { force: true });
        fs.symlinkSync(expected, commandLink);
        results.push(
          ok(`${target === null ? "Created" : "Repaired"} ${commandLink} -> ${expected}`),
        );
      } else {
        results.push(
          warn(
            `${commandLink} is ${target === null ? "missing" : `dangling (-> ${target})`}. Run "bitterbot doctor --fix" to link it to ${expected}.`,
          ),
        );
      }
    } else {
      results.push(
        warn(
          `${commandLink} points at ${target}, another install; left alone (the installer replaces it after asking).`,
        ),
      );
    }
  }

  // The running version against its manifest.
  const check = await verifyVersionDir(layout.versionDir, { mode: params.deep ? "full" : "quick" });
  if (check.ok) {
    results.push(
      ok(
        `v${layout.version}: ${check.checked} files match manifest.json (${params.deep ? "sha256" : "size; --deep checks sha256"})`,
      ),
    );
  } else {
    results.push(
      warn(
        [
          `v${layout.version} does not match its manifest.json (${check.problemCount} problem(s)):`,
          ...check.problems.map((p) => `  - ${p}`),
          `Reinstall it from the signed release (stop the gateway first): ${TARBALL_REINSTALL_COMMAND}`,
        ].join("\n"),
      ),
    );
  }

  // Leftovers of an interrupted update.
  let leftovers: string[] = [];
  try {
    leftovers = fs
      .readdirSync(appDir)
      .filter((n) => n.startsWith(".update-") || n.startsWith(".replaced."));
  } catch {
    leftovers = [];
  }
  if (leftovers.length > 0) {
    const locked = fs.existsSync(path.join(appDir, ".update.lock"));
    if (params.repair && !locked) {
      for (const name of leftovers) {
        fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
      }
      results.push(ok(`Removed ${leftovers.length} leftover(s) of an interrupted update`));
    } else {
      results.push(
        info(
          `${leftovers.length} leftover(s) of an ${locked ? "update in progress" : "interrupted update"} in ${appDir}${locked ? "" : '; "bitterbot doctor --fix" removes them'}`,
        ),
      );
    }
  }

  // Pre-update snapshots.
  const stateDir = params.stateDir ?? resolveStateDir(env);
  const snaps = listSnapshots(stateDir);
  const newest = snaps[0]?.manifest;
  results.push(
    info(
      newest
        ? `${snaps.length} pre-update snapshot(s) in ${snapshotsRoot(stateDir)} (newest: v${newest.from} -> v${newest.to}, ${newest.createdAt})`
        : `No pre-update snapshots yet (bitterbot update writes them to ${snapshotsRoot(stateDir)})`,
    ),
  );

  renderSection("Install", results);
  return results;
}
