import fs from "node:fs/promises";
import path from "node:path";
import type { loadConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { VERSION } from "../version.js";
import { resolveBitterbotPackageRoot } from "./bitterbot-root.js";
import { normalizeUpdateChannel, DEFAULT_PACKAGE_CHANNEL } from "./update-channels.js";
import { compareSemverStrings, resolveNpmChannelTag, checkUpdateStatus } from "./update-check.js";
import { computeUpdateStaleness, type UpdateStaleness } from "./update-staleness.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
};

const UPDATE_CHECK_FILENAME = "update-check.json";
/** Beta fleet drift control: re-evaluate staleness every 6 hours, not just at boot. */
const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The git fetch + registry probe get a longer leash than the old boot-only check. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/**
 * Floor between real checks: a node bouncing through in-process restarts
 * (config writes, update.run) must not hammer its git remote — every skipped
 * run within this window is silent, and the 6h interval paces the rest.
 */
const UPDATE_CHECK_FLOOR_MS = 30 * 60 * 1000;

/**
 * Broadcast payload for the `update` gateway event, and the response spine of
 * the `update.check` RPC's periodic sibling. Always emitted (fresh or stale)
 * so the Control UI can both raise and clear its update prompt.
 */
export type UpdateStatusEvent = {
  version: string;
  installKind: "git" | "package" | "unknown";
  sha: string | null;
  branch: string | null;
  registryLatest: string | null;
  /** False when the pre-check `git fetch` failed — behind counts are stale. */
  fetchOk: boolean | null;
  staleness: UpdateStaleness;
  checkedAt: number;
};

function shouldSkipCheck(allowInTests: boolean): boolean {
  if (allowInTests) {
    return false;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return true;
  }
  return false;
}

async function readState(statePath: string): Promise<UpdateCheckState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateCheckState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(statePath: string, state: UpdateCheckState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function runGatewayUpdateCheck(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  allowInTests?: boolean;
  /** Receives the status of every completed check (stale or fresh). */
  onStatus?: (event: UpdateStatusEvent) => void;
}): Promise<void> {
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  if (params.cfg.update?.checkOnStart === false) {
    return;
  }

  const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
  const state = await readState(statePath);
  const now = Date.now();
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  if (
    !params.allowInTests &&
    lastCheckedAt != null &&
    Number.isFinite(lastCheckedAt) &&
    now - lastCheckedAt < UPDATE_CHECK_FLOOR_MS
  ) {
    return;
  }

  const root = await resolveBitterbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const status = await checkUpdateStatus({
    root,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    fetchGit: true,
    // Package installs resolve their own channel dist-tag below; git installs
    // never use the registry, so skip the npm hit entirely.
    includeRegistry: false,
  });

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: new Date(now).toISOString(),
  };

  // Package installs: compare against the node's own channel tag (a beta node
  // must not be nagged toward `latest`), and keep the once-per-version log.
  let channelVersion: string | null = null;
  if (status.installKind === "package") {
    const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
    const resolved = await resolveNpmChannelTag({ channel, timeoutMs: 2500 });
    channelVersion = resolved.version;
    const cmp = compareSemverStrings(VERSION, resolved.version);
    if (resolved.version && cmp != null && cmp < 0) {
      const shouldNotify =
        state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== resolved.tag;
      if (shouldNotify) {
        params.log.info(
          `update available (${resolved.tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("bitterbot update")}`,
        );
        nextState.lastNotifiedVersion = resolved.version;
        nextState.lastNotifiedTag = resolved.tag;
      }
    }
  }

  const staleness = computeUpdateStaleness(status, params.cfg.update?.promptBehindCommits, {
    channelVersion,
  });
  if (status.installKind === "git" && staleness.stale) {
    params.log.info(
      `node is ${staleness.behind} commits behind upstream (prompt threshold ${staleness.threshold}). ` +
        `Update from the Control UI or run: ${formatCliCommand("bitterbot update")}`,
    );
  }
  params.onStatus?.({
    version: VERSION,
    installKind: status.installKind,
    sha: status.git?.sha ?? null,
    branch: status.git?.branch ?? null,
    registryLatest: channelVersion,
    fetchOk: status.git?.fetchOk ?? null,
    staleness,
    checkedAt: Date.now(),
  });

  await writeState(statePath, nextState);
}

/**
 * Kick off the boot-time update check and keep re-checking on an interval so
 * long-lived gateways learn they have drifted without a restart. Returns a
 * stop function (the timer is unref'd, so it never holds the process open).
 */
export function scheduleGatewayUpdateCheck(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onStatus?: (event: UpdateStatusEvent) => void;
}): () => void {
  const run = () => void runGatewayUpdateCheck(params).catch(() => {});
  run();
  const timer = setInterval(run, UPDATE_RECHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
