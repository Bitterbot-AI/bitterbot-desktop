/**
 * Types for scripts/release-tarball-lib.mjs (release-tarball policy, PLAN-56
 * Phase 3a). The runtime stays plain JS because the release workflow runs it
 * straight after `pnpm build`; this declaration gives the unit test and
 * type-aware lint the real shapes.
 */

export type ReleasePlatform = {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  nodeDist: string;
  orchestratorAsset: string;
};

export declare const RELEASE_PLATFORMS: Record<
  "linux-x64" | "linux-arm64" | "darwin-arm64" | "darwin-x64",
  ReleasePlatform
>;
export declare const BUNDLED_NODE_MAJOR: 22;
export declare const MIN_BUNDLED_NODE: string;
export declare const INSTALL_KIND_MARKER: ".bitterbot-install-kind";
export declare const LAUNCHER_SCRIPT: string;

export declare function platformIdFor(platform: string, arch: string): string | null;
export declare function tarballBaseName(version: string, platformId: string): string;
export declare function trustedCommentFor(version: string): string;
export declare function parseShasums(body: string, filename: string): string | null;
export declare function renderChecksums(entries: Array<{ name: string; sha256: string }>): string;
export declare function pickBundledNodeVersion(index: unknown, nodeDist: string): string | null;
export declare function nodeArchiveName(nodeVersion: string, nodeDist: string): string;

export type ManifestFile =
  | { path: string; sha256: string; size: number; mode: string }
  | { path: string; link: string };

export declare function buildManifest(input: {
  version: string;
  platformId: string;
  nodeVersion: string;
  orchestratorVersion: string;
  commit?: string | null;
  builtAt: string;
  files: ManifestFile[];
}): {
  schema: 1;
  name: "bitterbot";
  kind: "release-tarball";
  version: string;
  platform: string;
  node: string;
  orchestrator: string;
  commit: string | null;
  builtAt: string;
  files: ManifestFile[];
};
