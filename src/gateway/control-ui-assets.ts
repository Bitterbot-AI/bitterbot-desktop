import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PLAN-39 Phase 2: locating the built Control UI on disk.
 *
 * Root resolution follows the candidate-list pattern used by
 * `src/canvas-host/a2ui.ts`, with one deliberate omission described below.
 */

// Keyed by the inputs that can change the answer. A single memoised value would
// ignore a changed `gateway.controlUi.root` (or env override) after a config
// reload and keep serving the previous directory.
//
// Negative results get a short TTL rather than being cached for the process
// lifetime. `update.run` rebuilds and stages the UI while the gateway is already
// running, so a permanently cached "nothing staged" would mean the new UI is
// never picked up without a restart, defeating the point of serving assets from
// disk per request. Positive results are stable: the directory does not move.
const rootCache = new Map<string, string>();
const negativeCache = new Map<string, number>();
const NEGATIVE_TTL_MS = 5_000;

/**
 * Candidate roots, most specific first.
 *
 * `desktop/dist-renderer` is deliberately NOT a candidate, even though it is the
 * obvious "running from a checkout" fallback and the original plan listed it.
 * That directory is the raw Vite output, and while `desktop/vite.config.ts` bakes
 * the gateway token into the bundle via `define`, serving it would publish the
 * gateway credential to any client that fetches the JS. `scripts/control-ui-copy.ts`
 * refuses to stage such a build for exactly this reason; accepting the same
 * directory here would route around that guard. The development flow serves the
 * renderer from Vite on its own port instead, so nothing needs this fallback.
 * It may be reinstated once the token define is gone (Phase 3).
 */
export function controlUiRootCandidates(params?: {
  configuredRoot?: string;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  cwd?: string;
  execPath?: string;
}): string[] {
  const env = params?.env ?? process.env;
  const here = params?.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = params?.cwd ?? process.cwd();
  const out: string[] = [];

  // An explicit root is authoritative: if an operator sets gateway.controlUi.root
  // (or the env override) and it has no index.html, that is a misconfiguration to
  // surface as "no UI", not a reason to quietly serve some other directory.
  const configured = params?.configuredRoot?.trim();
  if (configured) {
    return [path.resolve(configured)];
  }
  const envOverride = env.BITTERBOT_CONTROL_UI_DIR?.trim();
  if (envOverride) {
    return [path.resolve(envOverride)];
  }
  // Running from dist/ (the normal case): dist/gateway/... -> dist/control-ui
  out.push(path.resolve(here, "..", "control-ui"));
  // Running from a repo checkout or with a staged dist.
  out.push(path.resolve(cwd, "dist", "control-ui"));
  // SEA / Tauri sidecar: assets beside the executable.
  const execPath = params?.execPath ?? process.execPath;
  if (execPath) {
    out.push(path.resolve(path.dirname(execPath), "control-ui"));
  }
  return out;
}

/** First candidate that actually contains an index.html, or null. */
export async function resolveControlUiRoot(params?: {
  configuredRoot?: string;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  cwd?: string;
  execPath?: string;
  useCache?: boolean;
}): Promise<string | null> {
  const useCache = params?.useCache ?? true;
  const env = params?.env ?? process.env;
  const cacheKey = `${params?.configuredRoot ?? ""}\u0000${env.BITTERBOT_CONTROL_UI_DIR ?? ""}`;
  if (useCache) {
    const hit = rootCache.get(cacheKey);
    if (hit !== undefined) {
      return hit;
    }
    const missedAt = negativeCache.get(cacheKey);
    if (missedAt !== undefined && Date.now() - missedAt < NEGATIVE_TTL_MS) {
      return null;
    }
  }
  let found: string | null = null;
  for (const dir of controlUiRootCandidates(params)) {
    try {
      await fs.stat(path.join(dir, "index.html"));
      // realpath so the traversal guard compares resolved paths.
      found = await fs.realpath(dir);
      break;
    } catch {
      // try next
    }
  }
  if (useCache) {
    if (found) {
      rootCache.set(cacheKey, found);
      negativeCache.delete(cacheKey);
    } else {
      negativeCache.set(cacheKey, Date.now());
    }
  }
  return found;
}

/** Test hook: forget the memoised root. */
export function resetControlUiRootCache(): void {
  rootCache.clear();
  negativeCache.clear();
}

/**
 * Cache policy.
 *
 * Vite content-hashes everything under `assets/`, so those are immutable and can
 * be cached for a year. `index.html` and public files keep their names across
 * builds and must be revalidated, otherwise a browser would keep loading the old
 * document after an update and never discover the new hashed chunks. This split
 * is what makes "a UI update is a file copy, the next reload picks it up" true
 * without a restart.
 */
export function cacheControlFor(relPath: string): string {
  const normalized = relPath.replace(/^\/+/, "");
  return normalized.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}
