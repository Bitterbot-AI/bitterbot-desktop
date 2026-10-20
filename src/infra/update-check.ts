import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import {
  type ContainerProbe,
  type InstallKind,
  resolveInstallKind,
  tarballPlatformId,
} from "./install-kind.js";

export type { InstallKind } from "./install-kind.js";
import {
  GITHUB_RELEASES_URL,
  type GithubReleaseEntry,
  pickLatestReleaseWithAsset,
  pickLatestTarballRelease,
} from "./release-assets.js";
import { parseSemver } from "./runtime-guard.js";
import { channelToNpmTag, type UpdateChannel } from "./update-channels.js";

export type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

export type GitUpdateStatus = {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  /** Subjects of HEAD..upstream (capped) — the pending "release notes". */
  pendingCommits?: string[];
  error?: string;
};

export type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "stale" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
};

export type RegistryStatus = {
  latestVersion: string | null;
  /**
   * Where `latestVersion` came from: npm for package installs, GitHub
   * releases for containers and release-tarball installs.
   */
  source?: "npm" | "github-releases";
  error?: string;
};

export type NpmTagStatus = {
  tag: string;
  version: string | null;
  error?: string;
};

export type UpdateCheckResult = {
  root: string | null;
  installKind: InstallKind;
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
};

export function formatGitInstallLabel(update: UpdateCheckResult): string | null {
  if (update.installKind !== "git") {
    return null;
  }
  const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
  const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
  const tag = update.git?.tag ?? null;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  return (await detectPackageManagerImpl(root)) ?? "unknown";
}

/**
 * Which tool put a package install on disk, read from where it sits. The
 * package.json `packageManager` field names the repo's development tooling
 * (pnpm), so for `npm install -g bitterbot` it would wrongly say pnpm.
 * Checked on the path as given and on its realpath (pnpm's global dir is a
 * symlink into its `.pnpm` store). Null when the layout says nothing.
 */
export function detectPackageInstallLayout(paths: Array<string | null>): PackageManager | null {
  const normalized = paths
    .filter((p): p is string => Boolean(p))
    .map((p) => p.split(path.sep).join("/").replaceAll("\\", "/"));
  if (normalized.some((p) => /\/\.bun\/install\/global\/node_modules\//.test(p))) {
    return "bun";
  }
  if (normalized.some((p) => /\/\.pnpm\/|\/pnpm\/global\/[^/]+\/node_modules\//.test(p))) {
    return "pnpm";
  }
  if (normalized.some((p) => path.posix.basename(path.posix.dirname(p)) === "node_modules")) {
    return "npm";
  }
  return null;
}

async function detectGitRoot(root: string): Promise<string | null> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 4000,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const top = res.stdout.trim();
  return top ? path.resolve(top) : null;
}

export async function checkGitUpdateStatus(params: {
  root: string;
  timeoutMs?: number;
  fetch?: boolean;
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = path.resolve(params.root);

  const base: GitUpdateStatus = {
    root,
    sha: null,
    tag: null,
    branch: null,
    upstream: null,
    dirty: null,
    ahead: null,
    behind: null,
    fetchOk: null,
    pendingCommits: [],
  };

  const branchRes = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    { timeoutMs },
  ).catch(() => null);
  if (!branchRes || branchRes.code !== 0) {
    return { ...base, error: branchRes?.stderr?.trim() || "git unavailable" };
  }
  const branch = branchRes.stdout.trim() || null;

  const shaRes = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;

  const tagRes = await runCommandWithTimeout(
    ["git", "-C", root, "describe", "--tags", "--exact-match"],
    { timeoutMs },
  ).catch(() => null);
  const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;

  const upstreamRes = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"],
    { timeoutMs },
  ).catch(() => null);
  const upstream = upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  const dirtyRes = await runCommandWithTimeout(
    ["git", "-C", root, "status", "--porcelain", "--", ":!dist/control-ui/"],
    { timeoutMs },
  ).catch(() => null);
  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchOk = params.fetch
    ? await runCommandWithTimeout(["git", "-C", root, "fetch", "--quiet", "--prune"], { timeoutMs })
        .then((r) => r.code === 0)
        .catch(() => false)
    : null;

  const counts =
    upstream && upstream.length > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstream}`],
          { timeoutMs },
        ).catch(() => null)
      : null;

  const parseCounts = (raw: string): { ahead: number; behind: number } | null => {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }
    const ahead = Number.parseInt(parts[0] ?? "", 10);
    const behind = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return null;
    }
    return { ahead, behind };
  };
  const parsed = counts && counts.code === 0 ? parseCounts(counts.stdout) : null;

  // PLAN-41 (sota-bar rec 2): the pending commits ARE the release notes for a
  // git install — surface their subjects so the UI can show what an update
  // brings BEFORE it is installed. Capped; empty when up to date.
  const pendingCommits =
    upstream && (parsed?.behind ?? 0) > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "log", "--pretty=%s", "-n", "15", `HEAD..${upstream}`],
          { timeoutMs },
        )
          .then((r) => (r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []))
          .catch(() => [])
      : [];

  return {
    root,
    sha,
    tag,
    branch,
    upstream,
    dirty,
    ahead: parsed?.ahead ?? null,
    behind: parsed?.behind ?? null,
    fetchOk,
    pendingCommits,
  };
}

async function statMtimeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function resolveDepsMarker(params: { root: string; manager: PackageManager }): {
  lockfilePath: string | null;
  markerPath: string | null;
} {
  const root = params.root;
  if (params.manager === "pnpm") {
    return {
      lockfilePath: path.join(root, "pnpm-lock.yaml"),
      markerPath: path.join(root, "node_modules", ".modules.yaml"),
    };
  }
  if (params.manager === "bun") {
    return {
      lockfilePath: path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    return {
      lockfilePath: path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

export async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = resolveDepsMarker({
    root,
    manager: params.manager,
  });

  if (!lockfilePath || !markerPath) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "unknown package manager",
    };
  }

  const lockExists = await exists(lockfilePath);
  const markerExists = await exists(markerPath);
  if (!lockExists) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "lockfile missing",
    };
  }
  if (!markerExists) {
    return {
      manager: params.manager,
      status: "missing",
      lockfilePath,
      markerPath,
      reason: "node_modules marker missing",
    };
  }

  const lockMtime = await statMtimeMs(lockfilePath);
  const markerMtime = await statMtimeMs(markerPath);
  if (!lockMtime || !markerMtime) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
    };
  }
  if (lockMtime > markerMtime + 1000) {
    return {
      manager: params.manager,
      status: "stale",
      lockfilePath,
      markerPath,
      reason: "lockfile newer than install marker",
    };
  }
  return {
    manager: params.manager,
    status: "ok",
    lockfilePath,
    markerPath,
  };
}

export async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params?.timeoutMs });
  return {
    latestVersion: res.version,
    source: "npm",
    error: res.error,
  };
}

/**
 * Container installs (PLAN-56 D6): the newest image is the newest app release
 * that carries the `docker-compose.yml` asset. docker-publish attaches that
 * asset as its LAST step, after the multi-arch image is pushed and tagged, so
 * a release without it ("published, image still building") never prompts.
 * The list endpoint (not /releases/latest) is used so a desktop or
 * orchestrator release marked "latest" can never mask the app release. The
 * releases API needs no token (60 requests/hour per IP unauthenticated); the
 * request carries no identifying data beyond the IP and a generic User-Agent.
 */
export {
  GITHUB_RELEASES_URL,
  pickLatestTarballRelease,
  TARBALL_CHECKSUMS_ASSET,
  TARBALL_SIGNATURE_ASSET,
} from "./release-assets.js";

/** The release asset whose presence means "the image for this release is on GHCR". */
export const COMPOSE_RELEASE_ASSET = "docker-compose.yml";

/** Successful answers are reused this long, so a click-happy UI never fans out. */
const GITHUB_RELEASE_CACHE_MS = 30 * 60 * 1000;
/** A rate-limit answer is remembered long enough to let the hourly quota recover. */
const GITHUB_RELEASE_RATE_LIMIT_CACHE_MS = 15 * 60 * 1000;
/** Other failures (timeout, offline) are remembered briefly, so "Check" can retry soon. */
const GITHUB_RELEASE_ERROR_CACHE_MS = 2 * 60 * 1000;
/**
 * How long one release-list request may take. The list is ~300 KB, and a
 * freshly booted gateway can stall its event loop for several seconds, so a
 * short budget turned a reachable GitHub into "unreachable".
 */
export const GITHUB_RELEASE_TIMEOUT_MS = 10_000;

function githubReleaseCacheTtl(status: RegistryStatus): number {
  if (status.latestVersion) {
    return GITHUB_RELEASE_CACHE_MS;
  }
  return status.error === "rate-limited"
    ? GITHUB_RELEASE_RATE_LIMIT_CACHE_MS
    : GITHUB_RELEASE_ERROR_CACHE_MS;
}

/**
 * Which release asset proves a release is installable for this install kind:
 * the compose file for containers (attached after the image is on GHCR), the
 * platform tarball for release-tarball installs (attached only after the
 * whole set is signed, see .github/workflows/release-tarball.yml).
 */
export type GithubReleaseTarget = { kind: "image" } | { kind: "tarball"; platformId: string };

const IMAGE_TARGET: GithubReleaseTarget = { kind: "image" };

function releaseTargetKey(target: GithubReleaseTarget): string {
  return target.kind === "image" ? "image" : `tarball:${target.platformId}`;
}

const githubReleaseCache = new Map<string, { at: number; status: RegistryStatus }>();

/** @internal */
export function resetGithubReleaseCacheForTests(): void {
  githubReleaseCache.clear();
}

/**
 * The last answer (a version or an error), if still fresh, WITHOUT a network
 * request; null means GitHub has not been asked yet. Lets a no-fetch check
 * tell "not checked" apart from "checked and failed".
 */
export function peekGithubReleaseStatus(
  now = Date.now(),
  target: GithubReleaseTarget = IMAGE_TARGET,
): RegistryStatus | null {
  const cached = githubReleaseCache.get(releaseTargetKey(target));
  if (!cached || now - cached.at >= githubReleaseCacheTtl(cached.status)) {
    return null;
  }
  return cached.status;
}

/**
 * The last answer, if still fresh, WITHOUT a network request: lets the
 * Control UI's no-fetch bootstrap check show a known newer release.
 */
export function peekLatestGithubRelease(
  now = Date.now(),
  target: GithubReleaseTarget = IMAGE_TARGET,
): RegistryStatus | null {
  const cached = githubReleaseCache.get(releaseTargetKey(target));
  if (!cached?.status.latestVersion || now - cached.at >= GITHUB_RELEASE_CACHE_MS) {
    return null;
  }
  return cached.status;
}

/**
 * The highest `vX.Y.Z` among published, non-prerelease releases that carry
 * the compose asset; null when there is none.
 */
export function pickLatestImageRelease(releases: GithubReleaseEntry[]): string | null {
  return pickLatestReleaseWithAsset(releases, () => [COMPOSE_RELEASE_ASSET]);
}

/**
 * The GitHub release target for an install kind on this machine, or null
 * when the kind does not follow GitHub releases (or no tarball is published
 * for this platform).
 */
export function githubReleaseTargetFor(
  kind: InstallKind,
  platformId: string | null = tarballPlatformId(),
): GithubReleaseTarget | null {
  if (kind === "container") {
    return IMAGE_TARGET;
  }
  if (kind === "tarball") {
    return platformId ? { kind: "tarball", platformId } : null;
  }
  return null;
}

export async function fetchLatestGithubRelease(params?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
  target?: GithubReleaseTarget;
}): Promise<RegistryStatus> {
  const now = params?.now ?? Date.now();
  const target = params?.target ?? IMAGE_TARGET;
  const key = releaseTargetKey(target);
  const cached = githubReleaseCache.get(key);
  if (cached && now - cached.at < githubReleaseCacheTtl(cached.status)) {
    return cached.status;
  }
  const status = await fetchLatestGithubReleaseUncached({ ...params, target });
  githubReleaseCache.set(key, { at: now, status });
  return status;
}

async function fetchLatestGithubReleaseUncached(params: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  target: GithubReleaseTarget;
}): Promise<RegistryStatus> {
  const timeoutMs = Math.max(250, params.timeoutMs ?? GITHUB_RELEASE_TIMEOUT_MS);
  try {
    const res = await fetchWithTimeout(
      GITHUB_RELEASES_URL,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "bitterbot-update-check",
        },
      },
      timeoutMs,
      params.fetchImpl,
    );
    if (!res.ok) {
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      return {
        latestVersion: null,
        source: "github-releases",
        error: rateLimited ? "rate-limited" : `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      return { latestVersion: null, source: "github-releases", error: "malformed" };
    }
    const releases = json as GithubReleaseEntry[];
    const target = params.target;
    const version =
      target.kind === "image"
        ? pickLatestImageRelease(releases)
        : pickLatestTarballRelease(releases, target.platformId);
    if (!version) {
      // Releases exist but none carries a published image / platform
      // tarball yet (or the list is junk): no prompt.
      return {
        latestVersion: null,
        source: "github-releases",
        error: target.kind === "image" ? "no-image-release" : "no-tarball-release",
      };
    }
    return { latestVersion: version, source: "github-releases" };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      latestVersion: null,
      source: "github-releases",
      error: timedOut ? "timeout" : String(err),
    };
  }
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<NpmTagStatus> {
  const timeoutMs = params?.timeoutMs ?? 3500;
  const tag = params.tag;
  try {
    const res = await fetchWithTimeout(
      `https://registry.npmjs.org/bitterbot/${encodeURIComponent(tag)}`,
      {},
      Math.max(250, timeoutMs),
    );
    if (!res.ok) {
      // 404 on the tag = the package (or channel) has never been published —
      // a durable state worth naming, not a transient lookup failure (D-J:
      // status/update must say "no npm releases yet", not a silent unknown).
      return {
        tag,
        version: null,
        error: res.status === 404 ? "not-published" : `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as { version?: unknown };
    const version = typeof json?.version === "string" ? json.version : null;
    return { tag, version };
  } catch (err) {
    return { tag, version: null, error: String(err) };
  }
}

export async function resolveNpmChannelTag(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<{ tag: string; version: string | null }> {
  const channelTag = channelToNpmTag(params.channel);
  const channelStatus = await fetchNpmTagVersion({ tag: channelTag, timeoutMs: params.timeoutMs });
  if (params.channel !== "beta") {
    return { tag: channelTag, version: channelStatus.version };
  }

  const latestStatus = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params.timeoutMs });
  if (!latestStatus.version) {
    return { tag: channelTag, version: channelStatus.version };
  }
  if (!channelStatus.version) {
    return { tag: "latest", version: latestStatus.version };
  }
  const cmp = compareSemverStrings(channelStatus.version, latestStatus.version);
  if (cmp != null && cmp < 0) {
    return { tag: "latest", version: latestStatus.version };
  }
  return { tag: channelTag, version: channelStatus.version };
}

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return null;
  }
  // CalVer-to-SemVer guard (PLAN-41 D-A, mirrors compareBitterbotVersions):
  // a date-shaped major (>= 2000) is OLDER than any real SemVer major, so
  // 2026.2.15 installs see 1.0.0 as the upgrade it is.
  const aIsCalver = pa.major >= 2000;
  const bIsCalver = pb.major >= 2000;
  if (aIsCalver !== bIsCalver) {
    return aIsCalver ? -1 : 1;
  }
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return 0;
}

export async function checkUpdateStatus(params: {
  root: string | null;
  timeoutMs?: number;
  fetchGit?: boolean;
  includeRegistry?: boolean;
  /** Test seam for the container heuristic (env, /.dockerenv, cgroup). */
  containerProbe?: ContainerProbe;
}): Promise<UpdateCheckResult> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = params.root ? path.resolve(params.root) : null;
  const fetchRegistry = async (kind: InstallKind): Promise<RegistryStatus> => {
    if (kind === "container" || kind === "tarball") {
      const target = githubReleaseTargetFor(kind);
      return target
        ? await fetchLatestGithubRelease({ timeoutMs, target })
        : { latestVersion: null, source: "github-releases", error: "unsupported-platform" };
    }
    return await fetchNpmLatestVersion({ timeoutMs });
  };
  if (!root) {
    const installKind = resolveInstallKind({
      isGit: false,
      hasRoot: false,
      probe: params.containerProbe,
    });
    return {
      root: null,
      installKind,
      packageManager: "unknown",
      registry: params.includeRegistry ? await fetchRegistry(installKind) : undefined,
    };
  }

  const gitRoot = await detectGitRoot(root);
  const isGit = Boolean(gitRoot && path.resolve(gitRoot) === root);
  const realRoot = isGit ? root : await fs.realpath(root).catch(() => root);
  const pm =
    (isGit ? null : detectPackageInstallLayout([root, realRoot])) ??
    (await detectPackageManager(root));

  const installKind = resolveInstallKind({
    isGit,
    hasRoot: true,
    root,
    probe: params.containerProbe,
  });
  if (installKind === "container" || installKind === "tarball") {
    // The image's (or the release tarball's) node_modules are fixed at build
    // time: a deps verdict or a git status would describe the artifact, not
    // anything the user can act on.
    return {
      root,
      installKind,
      packageManager: pm,
      registry: params.includeRegistry ? await fetchRegistry(installKind) : undefined,
    };
  }
  const git = isGit
    ? await checkGitUpdateStatus({
        root,
        timeoutMs,
        fetch: Boolean(params.fetchGit),
      })
    : undefined;
  const deps = await checkDepsStatus({ root, manager: pm });
  const registry = params.includeRegistry ? await fetchRegistry(installKind) : undefined;

  return {
    root,
    installKind,
    packageManager: pm,
    git,
    deps,
    registry,
  };
}
