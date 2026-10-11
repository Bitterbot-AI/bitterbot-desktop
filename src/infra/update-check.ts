import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { type ContainerProbe, type InstallKind, resolveInstallKind } from "./install-kind.js";

export type { InstallKind } from "./install-kind.js";
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
  /** Where `latestVersion` came from: npm for package installs, GitHub releases for containers. */
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
 * Container installs (PLAN-56 D6): the newest image is the newest GitHub
 * release, because docker-publish runs on every release-please release. The
 * releases API needs no token (60 requests/hour per IP unauthenticated); the
 * request carries no identifying data beyond the IP and a generic User-Agent.
 */
export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/Bitterbot-AI/bitterbot-desktop/releases/latest";

/** Successful answers are reused this long, so a click-happy UI never fans out. */
const GITHUB_RELEASE_CACHE_MS = 30 * 60 * 1000;
/** Failures (offline, rate-limited) are remembered too, so retries back off. */
const GITHUB_RELEASE_ERROR_CACHE_MS = 15 * 60 * 1000;

let githubReleaseCache: { at: number; status: RegistryStatus } | null = null;

/** @internal */
export function resetGithubReleaseCacheForTests(): void {
  githubReleaseCache = null;
}

/**
 * The last answer, if still fresh, WITHOUT a network request: lets the
 * Control UI's no-fetch bootstrap check show a known newer image.
 */
export function peekLatestGithubRelease(now = Date.now()): RegistryStatus | null {
  const cached = githubReleaseCache;
  if (!cached?.status.latestVersion || now - cached.at >= GITHUB_RELEASE_CACHE_MS) {
    return null;
  }
  return cached.status;
}

/** Release tags are `vX.Y.Z` (release-please); anything else is not an app release. */
function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") {
    return null;
  }
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag.trim());
  return match ? (match[1] ?? null) : null;
}

export async function fetchLatestGithubRelease(params?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<RegistryStatus> {
  const now = params?.now ?? Date.now();
  const cached = githubReleaseCache;
  if (cached) {
    const ttl = cached.status.latestVersion
      ? GITHUB_RELEASE_CACHE_MS
      : GITHUB_RELEASE_ERROR_CACHE_MS;
    if (now - cached.at < ttl) {
      return cached.status;
    }
  }
  const status = await fetchLatestGithubReleaseUncached(params);
  githubReleaseCache = { at: now, status };
  return status;
}

async function fetchLatestGithubReleaseUncached(params?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RegistryStatus> {
  const timeoutMs = Math.max(250, params?.timeoutMs ?? 3500);
  try {
    const res = await fetchWithTimeout(
      GITHUB_LATEST_RELEASE_URL,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "bitterbot-update-check",
        },
      },
      timeoutMs,
      params?.fetchImpl,
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
    const json = (await res.json()) as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };
    const version =
      json && json.draft !== true && json.prerelease !== true
        ? parseReleaseTag(json.tag_name)
        : null;
    if (!version) {
      return { latestVersion: null, source: "github-releases", error: "malformed" };
    }
    return { latestVersion: version, source: "github-releases" };
  } catch (err) {
    return { latestVersion: null, source: "github-releases", error: String(err) };
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
  const fetchRegistry = (kind: InstallKind) =>
    kind === "container"
      ? fetchLatestGithubRelease({ timeoutMs })
      : fetchNpmLatestVersion({ timeoutMs });
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

  const pm = await detectPackageManager(root);
  const gitRoot = await detectGitRoot(root);
  const isGit = Boolean(gitRoot && path.resolve(gitRoot) === root);

  const installKind = resolveInstallKind({
    isGit,
    hasRoot: true,
    probe: params.containerProbe,
  });
  if (installKind === "container") {
    // The image's node_modules are fixed at build time: a deps verdict or a
    // git status would describe the image, not anything the user can act on.
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
