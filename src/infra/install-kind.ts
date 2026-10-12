/**
 * How this Bitterbot is installed (PLAN-56 Phase 2).
 *
 * - `git`: a source checkout; updates fetch/rebase or check out a tag.
 * - `package`: an npm/pnpm package install; updates go through the registry.
 * - `container`: the published Docker image; the code IS the image, so the
 *   only update is pulling a newer one (`docker compose pull && docker compose up -d`).
 * - `tarball`: a signed per-platform release tarball unpacked by
 *   `scripts/install.sh` into `~/.bitterbot/app/<version>` (PLAN-56 Phase 3).
 *   Its launcher (`bin/bitterbot`) sets `BITTERBOT_INSTALL_KIND=tarball` and
 *   the install root carries a `.bitterbot-install-kind` marker, so a gateway
 *   started any other way (systemd unit, `node dist/entry.js`) still knows.
 *   `bitterbot update` updates it in place (Phase 3b: verify, snapshot,
 *   stage, activate, auto-rollback; src/infra/tarball-updater.ts).
 * - `unknown`: the package root could not be resolved.
 *
 * The image declares itself with `ENV BITTERBOT_INSTALL_KIND=container`
 * (Dockerfile). Images built by someone else (or a `docker run node:22 npx ...`
 * setup) do not set it, so a heuristic backs it up. The heuristic runs only
 * when the root is NOT a git checkout: a dev container or CI job that mounts a
 * checkout is a git install and keeps updating like one.
 */

import fs from "node:fs";
import path from "node:path";

export type InstallKind = "git" | "package" | "container" | "tarball" | "unknown";

export const INSTALL_KIND_ENV = "BITTERBOT_INSTALL_KIND";

/** The shell command a container install updates with, shown by every surface. */
export const CONTAINER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

/** Escape hatch printed with every container refusal, for a misdetection. */
export const CONTAINER_FALSE_POSITIVE_HINT =
  "Not actually a container image install? Set BITTERBOT_INSTALL_KIND=package and retry.";

/** Marker file the release tarball carries at its root (content: `tarball`). */
export const TARBALL_INSTALL_MARKER = ".bitterbot-install-kind";

/**
 * The installer one-liner's URL: install.sh from main, which is always
 * available whatever state the newest release is in (it picks the newest
 * release that is completely published and signed). It embeds the pinned
 * public key, so it is as trustworthy as main. Every release also carries
 * install.sh as an asset for pinned installs.
 */
export const INSTALL_SH_URL =
  "https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh";

/** The installer one-liner (first install, or a repair when the updater cannot run). */
export const TARBALL_INSTALLER_COMMAND = `curl -fsSL ${INSTALL_SH_URL} | bash`;

/**
 * The command a tarball install updates with (PLAN-56 Phase 3b): verified,
 * snapshotted and rolled back automatically when the new version does not
 * boot.
 */
export const TARBALL_UPDATE_COMMAND = "bitterbot update";

/** Re-download and replace the running version (a damaged version directory). */
export const TARBALL_REINSTALL_COMMAND = "bitterbot update --reinstall";

/** Escape hatch printed with tarball-specific advice, for a misdetection. */
export const TARBALL_FALSE_POSITIVE_HINT =
  "Not actually a release-tarball install? Set BITTERBOT_INSTALL_KIND=package and retry.";

/**
 * Install kinds whose code cannot be updated by the gateway itself; the
 * update surfaces show this command instead of an "Update now" action.
 * Only containers since PLAN-56 Phase 3b (tarball installs update in place).
 */
export function externalUpdateCommand(kind: InstallKind): string | null {
  if (kind === "container") {
    return CONTAINER_UPDATE_COMMAND;
  }
  return null;
}

/**
 * The release-tarball platform id for this machine (`linux-x64`,
 * `linux-arm64`, `darwin-arm64`), or null where no tarball is published.
 * Must match RELEASE_PLATFORMS in scripts/release-tarball-lib.mjs.
 */
export function tarballPlatformId(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return `linux-${arch}`;
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  return null;
}

/** The release asset name of the tarball for `version` on `platformId`. */
export function tarballAssetName(version: string, platformId: string): string {
  return `bitterbot-${version}-${platformId}.tar.gz`;
}

export type ContainerProbe = {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
};

type DeclaredInstallKind = "container" | "git" | "package" | "tarball";

/** The kind the environment declares, or null when unset/unrecognised. */
export function readDeclaredInstallKind(
  env: NodeJS.ProcessEnv = process.env,
): DeclaredInstallKind | null {
  const raw = env[INSTALL_KIND_ENV]?.trim().toLowerCase();
  if (raw === "container" || raw === "git" || raw === "package" || raw === "tarball") {
    return raw;
  }
  return null;
}

/**
 * Best-effort "am I in a container" probe: Docker's `/.dockerenv`, Podman's
 * `/run/.containerenv`, or a container runtime named in PID 1's cgroup
 * (cgroup v1 hosts). WSL2 and GitHub-hosted runners are VMs: none of these
 * markers exist there and PID 1's cgroup is `0::/` or `0::/init.scope`.
 */
export function looksLikeContainer(probe: ContainerProbe = {}): boolean {
  const existsSync = probe.existsSync ?? ((p: string) => fs.existsSync(p));
  const readFileSync = probe.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  try {
    if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) {
      return true;
    }
  } catch {
    // fall through to the cgroup probe
  }
  try {
    const cgroup = readFileSync("/proc/1/cgroup");
    return /(^|[/:])(docker|kubepods|containerd|libpod)([/.-]|$)/m.test(cgroup);
  } catch {
    return false;
  }
}

/** True when `root` carries the release-tarball marker file. */
export function hasTarballMarker(root: string, probe: ContainerProbe = {}): boolean {
  const readFileSync = probe.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  try {
    return readFileSync(path.join(root, TARBALL_INSTALL_MARKER)).trim() === "tarball";
  } catch {
    return false;
  }
}

/**
 * Resolve the install kind. Order: an explicit `container` declaration wins
 * (the official image); then a git checkout is `git` (an inherited
 * `BITTERBOT_INSTALL_KIND=tarball` can never turn a developer checkout into a
 * tarball install); then no root is `unknown`; then a `tarball` declaration
 * or the tarball marker in the root; then an explicit `package`/`git`
 * declaration skips the container heuristic; then the heuristic; else
 * `package`.
 */
export function resolveInstallKind(params: {
  isGit: boolean;
  hasRoot: boolean;
  /** The package root, used to look for the tarball marker. */
  root?: string | null;
  probe?: ContainerProbe;
}): InstallKind {
  const declared = readDeclaredInstallKind(params.probe?.env ?? process.env);
  if (declared === "container") {
    return "container";
  }
  if (params.isGit) {
    return "git";
  }
  if (!params.hasRoot) {
    return declared === "tarball" ? "tarball" : "unknown";
  }
  if (declared === "tarball") {
    return "tarball";
  }
  if (params.root && declared === null && hasTarballMarker(params.root, params.probe)) {
    return "tarball";
  }
  if (declared === null && looksLikeContainer(params.probe)) {
    return "container";
  }
  return "package";
}

/**
 * Cheap synchronous install-kind detection for advice text (onboarding
 * wizard, doctor): a `.git` entry at the package root marks a checkout (a
 * linked worktree's `.git` file counts). The update path keeps its own
 * `git rev-parse` check; this only decides which commands to print.
 */
export function detectInstallKind(root: string | null, probe: ContainerProbe = {}): InstallKind {
  const existsSync = probe.existsSync ?? ((p: string) => fs.existsSync(p));
  let isGit = false;
  if (root) {
    try {
      isGit = existsSync(path.join(root, ".git"));
    } catch {
      isGit = false;
    }
  }
  return resolveInstallKind({ isGit, hasRoot: Boolean(root), root, probe });
}

/**
 * The command that starts the gateway for this install kind, for advice
 * text. Containers start with the compose project on the Docker host; a
 * source checkout runs the pnpm script; the installer and package installs
 * have `bitterbot` on PATH.
 */
export function gatewayStartCommand(kind: InstallKind): string {
  if (kind === "container") {
    return "docker compose up -d";
  }
  if (kind === "git") {
    return "pnpm start gateway";
  }
  return "bitterbot gateway";
}

/** Human label for an install kind, as `bitterbot update status` names it. */
export function installKindLabel(kind: InstallKind): string {
  switch (kind) {
    case "git":
      return "source checkout (git)";
    case "package":
      return "package install";
    case "container":
      return "container image";
    case "tarball":
      return "release tarball (install.sh)";
    case "unknown":
      return "unknown (package root not found)";
  }
}

/**
 * True for a source tree the pnpm stack scripts can run in: a git checkout,
 * or a non-git copy of the repository (a ZIP download) that still carries
 * the scripts the `start:all` / `dev:all` package scripts run. A release
 * tarball or package has `package.json` with those scripts but not
 * `scripts/start-all.mjs`.
 */
export function isSourceTree(
  root: string | null,
  kind: InstallKind,
  probe: ContainerProbe = {},
): boolean {
  if (kind === "git") {
    return true;
  }
  if (!root || kind !== "package") {
    return false;
  }
  const existsSync = probe.existsSync ?? ((p: string) => fs.existsSync(p));
  try {
    return (
      existsSync(path.join(root, "pnpm-workspace.yaml")) &&
      existsSync(path.join(root, "scripts", "start-all.mjs"))
    );
  } catch {
    return false;
  }
}
