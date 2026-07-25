/**
 * Staleness verdict for a node's install, shared by the `update.check` RPC
 * and the periodic gateway check that broadcasts the `update` event.
 *
 * We are pre-release: the whole fleet runs git checkouts of main, so the
 * drift metric that matters is commits behind upstream. Package (npm)
 * installs fall back to a semver comparison against the registry.
 */

import { VERSION } from "../version.js";
import { compareSemverStrings, type UpdateCheckResult } from "./update-check.js";

/** Default `update.promptBehindCommits`: prompt once a node drifts this far. */
export const DEFAULT_PROMPT_BEHIND_COMMITS = 20;

export type UpdateStaleness = {
  /** Commits behind upstream (git installs; null when unknown). */
  behind: number | null;
  /** The threshold that was applied (config or default). */
  threshold: number;
  /** True when the node should prompt its human to update. */
  stale: boolean;
  /** Why `stale` is what it is — for logs and the UI tooltip. */
  reason: "git-behind" | "package-version" | "fresh" | "unknown";
};

export function computeUpdateStaleness(
  check: UpdateCheckResult,
  promptBehindCommits?: number,
  opts?: {
    /**
     * Package installs: the node's own channel dist-tag version. When given
     * it replaces the registry's `latest` — a beta/dev node must not be
     * nagged toward a tag its updater would never install.
     */
    channelVersion?: string | null;
  },
): UpdateStaleness {
  const raw = promptBehindCommits ?? DEFAULT_PROMPT_BEHIND_COMMITS;
  // Guard config nonsense: a zero/negative/NaN threshold would prompt forever.
  const threshold =
    Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_PROMPT_BEHIND_COMMITS;

  if (check.installKind === "git") {
    const behind = check.git?.behind ?? null;
    if (behind == null) {
      return { behind: null, threshold, stale: false, reason: "unknown" };
    }
    return {
      behind,
      threshold,
      stale: behind >= threshold,
      reason: behind >= threshold ? "git-behind" : "fresh",
    };
  }

  if (check.installKind === "package") {
    const latest = opts?.channelVersion ?? check.registry?.latestVersion ?? null;
    const cmp = compareSemverStrings(VERSION, latest);
    if (cmp == null) {
      return { behind: null, threshold, stale: false, reason: "unknown" };
    }
    return {
      behind: null,
      threshold,
      stale: cmp < 0,
      reason: cmp < 0 ? "package-version" : "fresh",
    };
  }

  return { behind: null, threshold, stale: false, reason: "unknown" };
}
