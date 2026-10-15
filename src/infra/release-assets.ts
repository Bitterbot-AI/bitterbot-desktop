/**
 * GitHub release asset names and the "newest complete release" rule for
 * release-tarball installs, kept free of any import beyond install-kind.ts so
 * the npm launcher (src/launcher/, bundled into one file with only `node:`
 * imports) can share them with the in-app updater and update check.
 * update-check.ts re-exports everything here.
 */

import { tarballAssetName } from "./install-kind.js";

/**
 * The releases list endpoint (not /releases/latest, so a desktop or
 * orchestrator release marked "latest" can never mask the app release).
 */
export const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Bitterbot-AI/bitterbot-desktop/releases?per_page=30";

/** Release-level checksums and their minisign signature (release-tarball.yml). */
export const TARBALL_CHECKSUMS_ASSET = "checksums.txt";
export const TARBALL_SIGNATURE_ASSET = "checksums.txt.minisig";

const RELEASE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Compare two `X.Y.Z` release versions: negative, 0 or positive; null when
 * either is not exactly `X.Y.Z`. Same CalVer guard as compareSemverStrings
 * (update-check.ts): a date-shaped major (>= 2000) is OLDER than any real
 * SemVer major, so 2026.2.15 sorts below 1.0.0.
 */
export function compareReleaseVersions(a: string | null, b: string | null): number | null {
  const pa = a ? RELEASE_VERSION_RE.exec(a.trim()) : null;
  const pb = b ? RELEASE_VERSION_RE.exec(b.trim()) : null;
  if (!pa || !pb) {
    return null;
  }
  const na = [Number(pa[1]), Number(pa[2]), Number(pa[3])] as const;
  const nb = [Number(pb[1]), Number(pb[2]), Number(pb[3])] as const;
  const aIsCalver = na[0] >= 2000;
  const bIsCalver = nb[0] >= 2000;
  if (aIsCalver !== bIsCalver) {
    return aIsCalver ? -1 : 1;
  }
  for (let i = 0; i < 3; i += 1) {
    if (na[i] !== nb[i]) {
      return na[i]! < nb[i]! ? -1 : 1;
    }
  }
  return 0;
}

/** Release tags are `vX.Y.Z` (release-please); anything else is not an app release. */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") {
    return null;
  }
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return match ? (match[1] ?? null) : null;
}

export type GithubReleaseEntry = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

function releaseAssetNames(release: GithubReleaseEntry): Set<string> {
  const names = new Set<string>();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  for (const asset of assets) {
    const name =
      asset && typeof asset === "object" ? (asset as { name?: unknown }).name : undefined;
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

/**
 * The highest `vX.Y.Z` among published, non-prerelease releases that carry
 * every asset `requiredAssets(version)` names; null when there is none.
 */
export function pickLatestReleaseWithAsset(
  releases: GithubReleaseEntry[],
  requiredAssets: (version: string) => string[],
): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (!release || release.draft === true || release.prerelease === true) {
      continue;
    }
    const version = parseReleaseTag(release.tag_name);
    if (!version) {
      continue;
    }
    const names = releaseAssetNames(release);
    if (!requiredAssets(version).every((name) => names.has(name))) {
      continue;
    }
    const cmp = compareReleaseVersions(version, best);
    if (best === null || (cmp != null && cmp > 0)) {
      best = version;
    }
  }
  return best;
}

/**
 * Release-tarball installs (PLAN-56 Phase 3): the highest release that
 * carries `bitterbot-<version>-<platformId>.tar.gz` AND `checksums.txt` AND
 * `checksums.txt.minisig`, i.e. one install.sh can actually install. A
 * release whose tarball job has not finished, is waiting for the signing
 * approval, or failed verification (and so uploaded nothing) is never
 * offered. scripts/install.sh applies the same rule (bb_pick_latest).
 */
export function pickLatestTarballRelease(
  releases: GithubReleaseEntry[],
  platformId: string,
): string | null {
  return pickLatestReleaseWithAsset(releases, (version) => [
    tarballAssetName(version, platformId),
    TARBALL_CHECKSUMS_ASSET,
    TARBALL_SIGNATURE_ASSET,
  ]);
}
