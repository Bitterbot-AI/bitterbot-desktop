/**
 * Release-tarball policy (PLAN-56 Phase 3a), shared by
 * scripts/build-release-tarball.mjs, the release workflow and the unit test.
 * Pure functions only: no network, no filesystem.
 *
 * Tarball layout (`bitterbot-<version>-<platform>/`):
 *   bin/bitterbot                  launcher: execs the bundled Node on dist/entry.js
 *   bin/bitterbot-orchestrator     P2P sidecar, minisign-verified at build time
 *   runtime/node/                  official Node 22 LTS build, SHASUMS256-verified
 *   dist/ extensions/ skills/ docs/ package.json bitterbot.mjs ...
 *                                  exactly the npm package file list (`npm pack`)
 *   node_modules/                  production dependencies for this platform
 *   manifest.json                  version, platform, runtime versions, sha256 per file
 *   .bitterbot-install-kind        "tarball" (install-kind marker, src/infra/install-kind.ts)
 */

/**
 * Platforms a tarball is published for, each built natively on its own
 * runner (release-tarball.yml; darwin-x64 on the Intel `macos-15-intel`
 * runner, so the x64 native prebuilds are installed and load-tested on x64).
 * Keep in step with tarballPlatformId() in src/infra/install-kind.ts and the
 * case statement in scripts/install.sh.
 */
export const RELEASE_PLATFORMS = {
  "linux-x64": {
    os: "linux",
    arch: "x64",
    nodeDist: "linux-x64",
    orchestratorAsset: "bitterbot-orchestrator-linux-x64",
  },
  "linux-arm64": {
    os: "linux",
    arch: "arm64",
    nodeDist: "linux-arm64",
    orchestratorAsset: "bitterbot-orchestrator-linux-arm64",
  },
  "darwin-arm64": {
    os: "darwin",
    arch: "arm64",
    nodeDist: "darwin-arm64",
    orchestratorAsset: "bitterbot-orchestrator-darwin-arm64",
  },
  "darwin-x64": {
    os: "darwin",
    arch: "x64",
    nodeDist: "darwin-x64",
    orchestratorAsset: "bitterbot-orchestrator-darwin-x64",
  },
};

/** Bundled runtime major. Node 22 is the supported LTS line (engines >=22.12). */
export const BUNDLED_NODE_MAJOR = 22;

/** Minimum bundled Node: node:sqlite `allowExtension` (sqlite-vec) needs 22.13. */
export const MIN_BUNDLED_NODE = "22.13.0";

/** Marker file at the install root; must match TARBALL_INSTALL_MARKER. */
export const INSTALL_KIND_MARKER = ".bitterbot-install-kind";

export function platformIdFor(platform, arch) {
  const id = `${platform}-${arch}`;
  return Object.hasOwn(RELEASE_PLATFORMS, id) ? id : null;
}

/** `bitterbot-<version>-<platform>`: the top directory and the asset stem. */
export function tarballBaseName(version, platformId) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release version must be X.Y.Z, got "${version}"`);
  }
  if (!Object.hasOwn(RELEASE_PLATFORMS, platformId)) {
    throw new Error(`no release tarball is built for platform "${platformId}"`);
  }
  return `bitterbot-${version}-${platformId}`;
}

/**
 * The minisign trusted comment that signs a release's checksums.txt. Same
 * convention as the orchestrator release (`<tag> checksums`); install.sh
 * requires an exact match, so a signature from another release (or from an
 * orchestrator release signed by the same key) is refused.
 */
export function trustedCommentFor(version) {
  return `v${version} checksums`;
}

/**
 * Parse sha256sum-formatted text (`<hex>  <name>` or `<hex> *<name>`) and
 * return the hash for `filename`, or null. Same grammar as
 * fetch-orchestrator.mjs and nodejs.org's SHASUMS256.txt.
 */
export function parseShasums(body, filename) {
  for (const rawLine of String(body).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2] === filename) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

/** sha256sum-compatible text, sorted by name, one trailing newline. */
export function renderChecksums(entries) {
  const lines = [...entries]
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => {
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(`bad sha256 for ${name}`);
      }
      if (/[\s/]/.test(name)) {
        throw new Error(`checksums entry must be a bare file name: "${name}"`);
      }
      return `${sha256}  ${name}`;
    });
  return `${lines.join("\n")}\n`;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return null;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Newest Node `BUNDLED_NODE_MAJOR`.x LTS from nodejs.org/dist/index.json
 * that ships a tarball for `nodeDist`, as "vX.Y.Z"; null when none qualifies.
 */
export function pickBundledNodeVersion(index, nodeDist) {
  let best = null;
  for (const entry of Array.isArray(index) ? index : []) {
    const version = entry?.version;
    const parsed = parseVersion(version);
    if (!parsed || parsed[0] !== BUNDLED_NODE_MAJOR || !entry.lts) {
      continue;
    }
    if (compareVersions(version, MIN_BUNDLED_NODE) < 0) {
      continue;
    }
    const files = Array.isArray(entry.files) ? entry.files : [];
    const distKey = nodeDist.startsWith("darwin-") ? `osx-${nodeDist.slice(7)}-tar` : nodeDist;
    if (!files.includes(distKey)) {
      continue;
    }
    if (best === null || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
}

/** The official archive name for a Node version on a platform. */
export function nodeArchiveName(nodeVersion, nodeDist) {
  return `node-${nodeVersion}-${nodeDist}.tar.gz`;
}

/**
 * manifest.json content. `files` is [{ path, sha256, size, mode }] or
 * [{ path, link }] for symlinks (pnpm's node_modules layout); paths are
 * relative to the tarball's top directory and sorted for stable diffs.
 */
export function buildManifest({
  version,
  platformId,
  nodeVersion,
  orchestratorVersion,
  commit,
  builtAt,
  files,
}) {
  const sorted = [...files].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema: 1,
    name: "bitterbot",
    kind: "release-tarball",
    version,
    platform: platformId,
    node: nodeVersion,
    orchestrator: orchestratorVersion,
    commit: commit ?? null,
    builtAt,
    files: sorted,
  };
}

/**
 * bin/bitterbot. POSIX sh so it runs before anything else is known about
 * the machine. Resolves its own symlinks (~/.local/bin/bitterbot ->
 * <dir>/current/bin/bitterbot), then `pwd -P` pins the REAL version
 * directory, so a running gateway keeps its own files when install.sh
 * later switches `current` to a newer version.
 */
export const LAUNCHER_SCRIPT = `#!/bin/sh
# Bitterbot release-tarball launcher (PLAN-56 Phase 3). Generated by
# scripts/build-release-tarball.mjs; do not edit in place.
set -e
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
# Install kind for the update surfaces; an explicit value (the documented
# BITTERBOT_INSTALL_KIND=package escape hatch) is respected.
BITTERBOT_INSTALL_KIND=\${BITTERBOT_INSTALL_KIND:-tarball}
BITTERBOT_INSTALL_ROOT=$root
export BITTERBOT_INSTALL_KIND BITTERBOT_INSTALL_ROOT
# A browser pre-staged by \`install.sh --with-browser\` lives here.
if [ -z "\${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$HOME/.bitterbot/browsers" ]; then
  PLAYWRIGHT_BROWSERS_PATH=$HOME/.bitterbot/browsers
  export PLAYWRIGHT_BROWSERS_PATH
fi
# The bundled runtime is a fallback for tools that call \`node\`/\`npm\` by
# name (plugin installs); a Node already on PATH keeps precedence. Bundled
# runtimes of any version in this install dir (inherited by a restarted or
# updated gateway) are dropped first, so PATH does not grow with every
# restart and names this version's runtime only.
appdir=$(dirname "$root")
newpath=
set -f
IFS=:
for entry in $PATH; do
  case $entry in
    "$appdir"/*/runtime/node/bin | "$appdir"/*/runtime/node/bin/) ;;
    *) newpath=\${newpath:+$newpath:}$entry ;;
  esac
done
unset IFS
set +f
PATH=\${newpath:+$newpath:}$root/runtime/node/bin
export PATH
# In-use marker: exec keeps this pid, so install.sh never prunes or replaces
# a version directory while a process started from it is alive.
if mkdir -p "$root/.pids" 2>/dev/null; then
  : >"$root/.pids/$$" 2>/dev/null || true
fi
# --disable-warning: Node's "SQLite is an experimental feature" notice is not
# for users (the CLI would otherwise respawn itself just to add this flag).
exec "$root/runtime/node/bin/node" --disable-warning=ExperimentalWarning "$root/dist/entry.js" "$@"
`;
