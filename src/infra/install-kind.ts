/**
 * How this Bitterbot is installed (PLAN-56 Phase 2).
 *
 * - `git`: a source checkout; updates fetch/rebase or check out a tag.
 * - `package`: an npm/pnpm package install; updates go through the registry.
 * - `container`: the published Docker image; the code IS the image, so the
 *   only update is pulling a newer one (`docker compose pull && docker compose up -d`).
 * - `unknown`: the package root could not be resolved.
 *
 * The image declares itself with `ENV BITTERBOT_INSTALL_KIND=container`
 * (Dockerfile). Images built by someone else (or a `docker run node:22 npx ...`
 * setup) do not set it, so a heuristic backs it up. The heuristic runs only
 * when the root is NOT a git checkout: a dev container or CI job that mounts a
 * checkout is a git install and keeps updating like one.
 */

import fs from "node:fs";

export type InstallKind = "git" | "package" | "container" | "unknown";

export const INSTALL_KIND_ENV = "BITTERBOT_INSTALL_KIND";

/** The shell command a container install updates with, shown by every surface. */
export const CONTAINER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export type ContainerProbe = {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
};

type DeclaredInstallKind = "container" | "git" | "package";

/** The kind the environment declares, or null when unset/unrecognised. */
export function readDeclaredInstallKind(
  env: NodeJS.ProcessEnv = process.env,
): DeclaredInstallKind | null {
  const raw = env[INSTALL_KIND_ENV]?.trim().toLowerCase();
  if (raw === "container" || raw === "git" || raw === "package") {
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

/**
 * Resolve the install kind. Order: an explicit `container` declaration wins
 * (the official image); then a git checkout is `git`; then no root is
 * `unknown`; then an explicit `package`/`git` declaration skips the heuristic;
 * then the container heuristic; else `package`.
 */
export function resolveInstallKind(params: {
  isGit: boolean;
  hasRoot: boolean;
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
    return "unknown";
  }
  if (declared === null && looksLikeContainer(params.probe)) {
    return "container";
  }
  return "package";
}
