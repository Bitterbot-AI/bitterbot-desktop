/**
 * Glue shared by the CLI (`bitterbot update`) and the gateway (`update.run`)
 * for release-tarball installs (PLAN-56 Phase 3b): where the install lives,
 * what to snapshot, and how the post-update boot is guarded.
 */

import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { BitterbotConfig } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { LATEST_SCHEMA_VERSION } from "../memory/migrations.js";
import { readLastBootDurationMs } from "./boot-duration.js";
import { armBootVerify, clearRollbackRecord, type BootVerifyRecord } from "./boot-verify.js";
import { tarballPlatformId } from "./install-kind.js";
import { resolveP2pKeyDir } from "./p2p-key-dir.js";
import { CURRENT_LINK, readVersionLink, resolveTarballLayout } from "./tarball-install.js";
import {
  resolveLatestTarballVersion,
  resolveReleaseSource,
  type ReleaseSource,
} from "./tarball-release.js";
import { runTarballUpdate, type TarballUpdateResult } from "./tarball-updater.js";
import { compareSemverStrings } from "./update-check.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner.js";
import type { SnapshotSources } from "./update-snapshot.js";

export class TarballContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarballContextError";
  }
}

export type TarballUpdateContext = {
  appDir: string;
  /** Version directory of the running code (the CLI or gateway doing the update). */
  root: string;
  /** What `current` names now: the update's `from` and the rollback target. */
  fromVersion: string;
  platformId: string;
  source: ReleaseSource;
  snapshot: SnapshotSources;
  /** update.autoRollback.enabled (default true). */
  autoRollback: boolean;
  /** LATEST_SCHEMA_VERSION of the running code. */
  memorySchemaLatest: number;
};

/**
 * Resolve everything an update needs from the running install. `root` is
 * this process's package root; BITTERBOT_INSTALL_ROOT (set by the launcher)
 * wins. Throws a TarballContextError with advice when the layout is not a
 * tarball install's.
 */
export function resolveTarballUpdateContext(params: {
  root: string | null;
  config: BitterbotConfig;
  allowTestMode: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string) => void;
}): TarballUpdateContext {
  const env = params.env ?? process.env;
  const layout = resolveTarballLayout(env.BITTERBOT_INSTALL_ROOT?.trim() || params.root);
  if (!layout) {
    throw new TarballContextError(
      `cannot find the release-tarball layout around ${params.root ?? "(unknown root)"} (expected ~/.bitterbot/app/<version>). Re-run the installer to repair it.`,
    );
  }
  const platformId = tarballPlatformId();
  if (!platformId) {
    throw new TarballContextError(
      `no release tarball is published for ${process.platform}-${process.arch}`,
    );
  }
  const source = resolveReleaseSource({
    allowTestMode: params.allowTestMode,
    env,
    warn: params.warn,
  });
  const cfg = params.config;
  const stateDir = resolveStateDir(env);
  let workspaceDir: string | null = null;
  try {
    workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  } catch {
    workspaceDir = null;
  }
  return {
    appDir: layout.appDir,
    root: layout.versionDir,
    fromVersion: readVersionLink(layout.appDir, CURRENT_LINK) ?? layout.version,
    platformId,
    source,
    snapshot: {
      stateDir,
      configPath: resolveConfigPath(env, stateDir),
      workspaceDir,
      keyDir: resolveP2pKeyDir(cfg.p2p?.keyDir),
    },
    autoRollback: cfg.update?.autoRollback?.enabled !== false,
    memorySchemaLatest: LATEST_SCHEMA_VERSION,
  };
}

/**
 * How long a tarball update's new version has to confirm a healthy boot
 * before the watchdog rolls back: three times the last measured boot, at
 * least 5 and at most 30 minutes (a tarball boot does no build, but a cold
 * boot on a slow disk was measured at ~5 minutes).
 */
export function tarballBootDeadlineMs(stateDir?: string): number {
  const last = readLastBootDurationMs(stateDir);
  return Math.min(30 * 60_000, Math.max(5 * 60_000, last * 3));
}

/** Arm the boot-verify beacon for a tarball update that is about to restart. */
export function armTarballBootVerify(params: {
  ctx: Pick<TarballUpdateContext, "appDir" | "fromVersion" | "autoRollback" | "memorySchemaLatest">;
  toVersion: string;
  snapshotDir: string | null;
  restart: "service" | "respawn";
  reason: string;
}): BootVerifyRecord | null {
  // A clean update supersedes any earlier rollback notice.
  clearRollbackRecord();
  return armBootVerify({
    prevSha: null,
    expectedVersion: params.toVersion,
    deadlineMs: tarballBootDeadlineMs(),
    reason: params.reason,
    tarball: {
      appDir: params.ctx.appDir,
      fromVersion: params.ctx.fromVersion,
      toVersion: params.toVersion,
      restart: params.restart,
      snapshotDir: params.snapshotDir,
      fromMemorySchemaLatest: params.ctx.memorySchemaLatest,
      autoRollback: params.ctx.autoRollback,
    },
  });
}

/**
 * update.run for a release-tarball install (the Control UI's Update
 * button). Production rules only: `allowTestMode: false` ignores the
 * test-mode environment, so no RPC caller can change the key or origin.
 * Updates to the newest complete release; returns an UpdateRunResult for
 * the restart sentinel and the UI, plus what the restart needs.
 */
export async function runTarballUpdateForGateway(params: {
  root: string | null;
  config: BitterbotConfig;
  timeoutMs?: number;
  warn?: (msg: string) => void;
}): Promise<{
  result: UpdateRunResult;
  ctx: TarballUpdateContext | null;
  update: TarballUpdateResult | null;
}> {
  const started = Date.now();
  const steps: UpdateStepResult[] = [];
  let ctx: TarballUpdateContext | null = null;
  const base = (): Pick<UpdateRunResult, "mode" | "root" | "steps"> => ({
    mode: "tarball",
    root: ctx?.root ?? params.root ?? undefined,
    steps,
  });
  try {
    ctx = resolveTarballUpdateContext({
      root: params.root,
      config: params.config,
      allowTestMode: false,
      warn: params.warn,
    });
    const latest = await resolveLatestTarballVersion(
      ctx.source,
      ctx.platformId,
      Math.min(params.timeoutMs ?? 15_000, 30_000),
    );
    if (!latest) {
      return {
        result: {
          ...base(),
          status: "skipped",
          reason: "no-tarball-release",
          durationMs: Date.now() - started,
        },
        ctx,
        update: null,
      };
    }
    const cmp = compareSemverStrings(ctx.fromVersion, latest);
    if (cmp === null || cmp >= 0) {
      return {
        result: {
          ...base(),
          status: "skipped",
          reason: cmp === 0 ? "up-to-date" : "local-newer",
          before: { version: ctx.fromVersion },
          after: { version: ctx.fromVersion },
          durationMs: Date.now() - started,
        },
        ctx,
        update: null,
      };
    }
    const update = await runTarballUpdate({
      appDir: ctx.appDir,
      platformId: ctx.platformId,
      fromVersion: ctx.fromVersion,
      targetVersion: latest,
      source: ctx.source,
      snapshot: ctx.snapshot,
      fromMemorySchemaLatest: ctx.memorySchemaLatest,
      runningVersion: path.basename(ctx.root),
      timeoutMs: params.timeoutMs,
      onStep: (s) => steps.push(s),
    });
    return {
      result: {
        ...base(),
        status: "ok",
        before: { version: update.from },
        after: { version: update.to },
        durationMs: Date.now() - started,
      },
      ctx,
      update,
    };
  } catch (err) {
    return {
      result: {
        ...base(),
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
        before: ctx ? { version: ctx.fromVersion } : undefined,
        durationMs: Date.now() - started,
      },
      ctx,
      update: null,
    };
  }
}
