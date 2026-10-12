/**
 * In-place updates for release-tarball installs (PLAN-56 Phase 3b).
 *
 *   resolve target -> verify checksums.txt (pinned minisign key, exact
 *   trusted comment) -> download + SHA-256 -> unpack into a staging dir on
 *   the same filesystem -> verify every file against manifest.json -> run
 *   the NEW launcher (`--version`, `update preflight --json`) -> snapshot
 *   user data -> rename into <appDir>/<version> -> previous := old current,
 *   current := new (atomic symlink renames) -> prune old versions
 *
 * Restarting and auto-rollback are the caller's (CLI: update-cli/tarball.ts,
 * gateway: server-methods/update.ts) together with the boot watchdog
 * (boot-watchdog.ts), which calls rollbackTarballInstall below.
 *
 * Nothing here deletes user data, and a version directory is never removed
 * while it is current, previous, or in use.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  CURRENT_LINK,
  PREVIOUS_LINK,
  pruneVersionDirs,
  readTarballManifest,
  readVersionLink,
  swapVersionLink,
  VERSION_DIR_RE,
  verifyVersionDir,
  versionInUse,
  type PruneResult,
} from "./tarball-install.js";
import { PREFLIGHT_KIND, type PreflightReport } from "./tarball-preflight.js";
import {
  downloadVerifiedTarball,
  fetchVerifiedChecksums,
  ReleaseVerificationError,
  type ReleaseSource,
} from "./tarball-release.js";
import type { UpdateStepResult } from "./update-runner.js";
import {
  applySnapshotRestore,
  createUpdateSnapshot,
  findSnapshotFor,
  planSnapshotRestore,
  type RestorePlan,
  type RestoreResult,
  type SnapshotSources,
} from "./update-snapshot.js";

const log = createSubsystemLogger("update/tarball");

export { PREFLIGHT_KIND, type PreflightReport };

export type CommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const defaultRunner: CommandRunner = async (argv, opts) => {
  const res = await runCommandWithTimeout(argv, opts);
  return { stdout: res.stdout, stderr: res.stderr, code: res.code };
};

export class TarballUpdateError extends Error {
  constructor(
    message: string,
    readonly step: string,
  ) {
    super(message);
    this.name = "TarballUpdateError";
  }
}

export type TarballUpdateOptions = {
  appDir: string;
  platformId: string;
  /** Version `current` points at now (the update's `from`). */
  fromVersion: string;
  targetVersion: string;
  source: ReleaseSource;
  snapshot: SnapshotSources;
  /** LATEST_SCHEMA_VERSION of the running (pre-update) code. */
  fromMemorySchemaLatest: number;
  /** Re-download and replace the target even when it is already installed. */
  reinstall?: boolean;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  /** Pids that do not count as "in use" (this process). */
  excludePids?: number[];
  /** The version directory this process runs from: never pruned by this update. */
  runningVersion?: string;
  procRoot?: string | null;
  onStep?: (step: UpdateStepResult) => void;
  now?: () => Date;
};

export type TarballUpdateResult = {
  from: string;
  to: string;
  appDir: string;
  /** The new version directory was already installed and intact. */
  reused: boolean;
  snapshotDir: string;
  snapshotsPruned: string[];
  pruned: PruneResult;
  preflight: PreflightReport;
  steps: UpdateStepResult[];
};

/** Environment for the NEW launcher: let it pick its own install root and kind. */
function launcherEnv(): NodeJS.ProcessEnv {
  return {
    BITTERBOT_INSTALL_ROOT: undefined,
    BITTERBOT_INSTALL_KIND: undefined,
    // entry.js re-execs itself once with this marker; the new version must
    // make its own decision.
    BITTERBOT_NODE_OPTIONS_READY: undefined,
    BITTERBOT_HIDE_BANNER: "1",
    NO_COLOR: "1",
  };
}

/** Parse the preflight JSON from mixed stdout (the last line that parses wins). */
export function parsePreflightOutput(stdout: string): PreflightReport | null {
  const lines = stdout.split("\n").map((l) => l.trim());
  const start = stdout.indexOf("{");
  const candidates = start >= 0 ? [stdout.slice(start), ...lines.toReversed()] : [];
  for (const text of candidates) {
    if (!text.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as Partial<PreflightReport>;
      if (
        parsed?.kind === PREFLIGHT_KIND &&
        typeof parsed.version === "string" &&
        typeof parsed.ok === "boolean" &&
        Array.isArray(parsed.blocking)
      ) {
        return {
          kind: PREFLIGHT_KIND,
          version: parsed.version,
          ok: parsed.ok,
          blocking: parsed.blocking.map(String),
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
          memorySchemaLatest:
            typeof parsed.memorySchemaLatest === "number" ? parsed.memorySchemaLatest : 0,
        };
      }
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * What blocks activation, run with the NEW version's own launcher:
 *   1. `bin/bitterbot --version` must print exactly the target version;
 *   2. `bin/bitterbot update preflight --json` must exit 0 and report
 *      ok:true for the target version. The new code reports a block when the
 *      config file fails ITS schema (it would refuse to start) or a memory
 *      database carries a schema_version newer than it knows (data from a
 *      newer release: a downgrade past a migration). A target too old to
 *      have the preflight command cannot be validated and is refused.
 * Deprecated keys and databases that still need forward migrations are
 * warnings: the new version handles them on boot.
 */
export async function validateStagedVersion(params: {
  versionDir: string;
  targetVersion: string;
  runCommand?: CommandRunner;
  timeoutMs?: number;
}): Promise<PreflightReport> {
  const run = params.runCommand ?? defaultRunner;
  const launcher = path.join(params.versionDir, "bin", "bitterbot");
  const timeoutMs = params.timeoutMs ?? 120_000;
  const v = await run([launcher, "--version"], { timeoutMs, env: launcherEnv() });
  const printed = v.stdout.trim().split(/\s+/);
  if (v.code !== 0 || !printed.includes(params.targetVersion)) {
    throw new TarballUpdateError(
      `the new launcher printed "${v.stdout.trim() || v.stderr.trim()}" (exit ${v.code}), expected ${params.targetVersion}`,
      "validate",
    );
  }
  const pf = await run([launcher, "update", "preflight", "--json"], {
    timeoutMs,
    env: launcherEnv(),
  });
  const report = parsePreflightOutput(pf.stdout);
  if (!report) {
    throw new TarballUpdateError(
      `v${params.targetVersion} cannot run the activation check (\`bitterbot update preflight\`; exit ${pf.code}${pf.stderr.trim() ? `: ${pf.stderr.trim().slice(0, 300)}` : ""}). Versions older than the in-place updater cannot be activated this way; install them with install.sh --version instead.`,
      "validate",
    );
  }
  if (report.version !== params.targetVersion) {
    throw new TarballUpdateError(
      `the activation check ran as v${report.version}, expected v${params.targetVersion}`,
      "validate",
    );
  }
  if (!report.ok || pf.code !== 0) {
    throw new TarballUpdateError(
      `v${params.targetVersion} refuses this machine's data: ${report.blocking.join("; ") || `exit ${pf.code}`}`,
      "validate",
    );
  }
  return report;
}

async function extractTarball(params: {
  tarball: string;
  dest: string;
  runCommand: CommandRunner;
  timeoutMs: number;
}): Promise<void> {
  const res = await params.runCommand(["tar", "-xzf", params.tarball, "-C", params.dest], {
    timeoutMs: params.timeoutMs,
  });
  if (res.code !== 0) {
    throw new TarballUpdateError(
      `could not unpack ${path.basename(params.tarball)}: ${res.stderr.trim().slice(0, 300)}`,
      "unpack",
    );
  }
}

const LOCK_FILE = ".update.lock";

/** One update at a time per app dir: `<appDir>/.update.lock` holds the owner's pid. */
function acquireUpdateLock(appDir: string): () => void {
  const lockPath = path.join(appDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const owner = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      let alive = false;
      if (Number.isFinite(owner) && owner > 0 && owner !== process.pid) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch (killErr) {
          alive = (killErr as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) {
        throw new TarballUpdateError(
          `another update is already running (pid ${owner}); wait for it to finish`,
          "lock",
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new TarballUpdateError(`could not take ${lockPath}`, "lock");
}

/** Leftovers of interrupted updates (we hold the lock, so none is live). */
function removeUpdateLeftovers(appDir: string, procRoot?: string | null): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(appDir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(appDir, name);
    if (name.startsWith(".update-")) {
      fs.rmSync(full, { recursive: true, force: true });
    } else if (
      name.startsWith(".replaced.") &&
      versionInUse(full, { excludePids: [], procRoot }) === null
    ) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

/**
 * Download, verify, stage, validate, snapshot and activate `targetVersion`.
 * Throws a TarballUpdateError (or ReleaseVerificationError / SnapshotError)
 * with nothing activated when any step fails; staging leftovers are removed.
 */
export async function runTarballUpdate(opts: TarballUpdateOptions): Promise<TarballUpdateResult> {
  const run = opts.runCommand ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const steps: UpdateStepResult[] = [];
  // This process and its parent: bin/bitterbot execs node on entry.js, which
  // re-execs itself once, so the pid in the `.pids` marker is our parent.
  const excludePids = opts.excludePids ?? [process.pid, process.ppid];
  const appDir = opts.appDir;
  const target = opts.targetVersion;
  if (!VERSION_DIR_RE.test(target) || !VERSION_DIR_RE.test(opts.fromVersion)) {
    throw new TarballUpdateError(`bad version ${target}`, "resolve");
  }

  const step = async <T>(name: string, command: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await fn();
      const s: UpdateStepResult = {
        name,
        command,
        cwd: appDir,
        durationMs: Date.now() - started,
        exitCode: 0,
      };
      steps.push(s);
      opts.onStep?.(s);
      return value;
    } catch (err) {
      const s: UpdateStepResult = {
        name,
        command,
        cwd: appDir,
        durationMs: Date.now() - started,
        exitCode: 1,
        stderrTail: err instanceof Error ? err.message : String(err),
      };
      steps.push(s);
      opts.onStep?.(s);
      throw err;
    }
  };

  const runLocked = async (): Promise<TarballUpdateResult> => {
    const verified = await step(
      "verify signature",
      `checksums.txt + .minisig for v${target} (${opts.source.testMode ? "TEST key" : "pinned key"})`,
      () => fetchVerifiedChecksums(opts.source, target, opts.platformId, 60_000),
    );

    const work = await fsp.mkdtemp(path.join(appDir, ".update-"));
    try {
      const tarball = await step("download", verified.asset, () =>
        downloadVerifiedTarball(opts.source, verified, work, timeoutMs),
      );
      const stage = path.join(work, "stage");
      await fsp.mkdir(stage);
      const top = verified.asset.replace(/\.tar\.gz$/, "");
      const staged = path.join(stage, top);
      await step("unpack", `tar -xzf ${verified.asset}`, async () => {
        await extractTarball({ tarball, dest: stage, runCommand: run, timeoutMs });
        await fsp.rm(tarball, { force: true });
        const manifest = readTarballManifest(staged);
        if (!manifest || manifest.version !== target || manifest.platform !== opts.platformId) {
          throw new TarballUpdateError(
            `${verified.asset} manifest.json does not describe ${target} for ${opts.platformId}`,
            "unpack",
          );
        }
        if (!fs.existsSync(path.join(staged, "bin", "bitterbot"))) {
          throw new TarballUpdateError(`${verified.asset} has no bin/bitterbot`, "unpack");
        }
      });
      await step("verify files", "sha256 of every file in manifest.json", async () => {
        const check = await verifyVersionDir(staged, { mode: "full" });
        if (!check.ok) {
          throw new TarballUpdateError(
            `the unpacked release does not match its manifest (${check.problemCount} problem(s): ${check.problems.join("; ")})`,
            "verify",
          );
        }
      });
      const preflight = await step(
        "validate",
        `${top}/bin/bitterbot --version && update preflight --json`,
        () => validateStagedVersion({ versionDir: staged, targetVersion: target, runCommand: run }),
      );

      const snapshot = await step(
        "snapshot",
        "~/.bitterbot config, memory DBs, GENOME/MEMORY, keys",
        () =>
          createUpdateSnapshot({
            sources: opts.snapshot,
            from: opts.fromVersion,
            to: target,
            fromMemorySchemaLatest: opts.fromMemorySchemaLatest,
            now: opts.now?.(),
          }),
      );

      const finalDir = path.join(appDir, target);
      let reused = false;
      await step("install", finalDir, async () => {
        const stagedManifest = await fsp.readFile(path.join(staged, "manifest.json"), "utf8");
        if (fs.existsSync(finalDir) && !opts.reinstall) {
          let existing: string | null = null;
          try {
            existing = await fsp.readFile(path.join(finalDir, "manifest.json"), "utf8");
          } catch {
            existing = null;
          }
          if (
            existing === stagedManifest &&
            (await verifyVersionDir(finalDir, { mode: "full" })).ok
          ) {
            reused = true;
            return;
          }
        }
        let displaced: string | null = null;
        if (fs.existsSync(finalDir)) {
          const pid = versionInUse(finalDir, { excludePids, procRoot: opts.procRoot });
          if (pid !== null) {
            throw new TarballUpdateError(
              `${finalDir} must be replaced but is in use by a running Bitterbot (pid ${pid}). Stop it (bitterbot gateway stop) and retry.`,
              "install",
            );
          }
          displaced = path.join(appDir, `.replaced.${target}.${process.pid}`);
          await fsp.rm(displaced, { recursive: true, force: true });
          await fsp.rename(finalDir, displaced);
        }
        // Validation ran the staged launcher, which left an in-use marker.
        await fsp.rm(path.join(staged, ".pids"), { recursive: true, force: true });
        await fsp.rename(staged, finalDir);
        // A displaced directory this very process runs from (a --reinstall of
        // the running version) stays until a later update: code still loading
        // from it must not vanish mid-run.
        if (
          displaced &&
          versionInUse(displaced, { excludePids: [], procRoot: opts.procRoot }) === null
        ) {
          await fsp.rm(displaced, { recursive: true, force: true });
        }
      });

      await step("activate", `current -> ${target}, previous -> ${opts.fromVersion}`, async () => {
        if (opts.fromVersion !== target) {
          swapVersionLink(appDir, PREVIOUS_LINK, opts.fromVersion);
        }
        swapVersionLink(appDir, CURRENT_LINK, target);
      });

      const pruned = pruneVersionDirs(appDir, {
        excludePids,
        procRoot: opts.procRoot,
        keep: opts.runningVersion ? [opts.runningVersion] : [],
      });
      log.info(
        `activated v${target} (from v${opts.fromVersion}); snapshot ${snapshot.dir}; pruned ${pruned.removed.join(", ") || "nothing"}`,
      );
      return {
        from: opts.fromVersion,
        to: target,
        appDir,
        reused,
        snapshotDir: snapshot.dir,
        snapshotsPruned: snapshot.pruned,
        pruned,
        preflight,
        steps,
      };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  };

  const releaseLock = acquireUpdateLock(appDir);
  try {
    removeUpdateLeftovers(appDir, opts.procRoot);
    return await runLocked();
  } finally {
    releaseLock();
  }
}

export type TarballRollbackResult = {
  from: string;
  to: string;
  plan: RestorePlan | null;
  restore: RestoreResult | null;
  snapshotDir: string | null;
};

/**
 * Point `current` back at `toVersion` (keeping `fromVersion` as previous)
 * and restore from the snapshot taken for the update toVersion -> fromVersion
 * according to planSnapshotRestore's policy. The caller stops the gateway
 * first when the plan may touch databases (auto mode, or includeData).
 */
export async function rollbackTarballInstall(params: {
  appDir: string;
  stateDir: string;
  fromVersion: string;
  toVersion: string;
  mode: "auto" | "manual";
  targetMemorySchemaLatest: number;
  includeData?: boolean;
  /** Only plan, do not touch anything (for a dry run / the prompt). */
  dryRun?: boolean;
  readSchemaVersion?: (file: string) => Promise<number | null>;
}): Promise<TarballRollbackResult> {
  const { appDir, fromVersion, toVersion } = params;
  if (
    !VERSION_DIR_RE.test(toVersion) ||
    !fs.existsSync(path.join(appDir, toVersion, "bin", "bitterbot"))
  ) {
    throw new TarballUpdateError(
      `cannot roll back: ${path.join(appDir, toVersion)} is missing or incomplete`,
      "rollback",
    );
  }
  const snapshot = findSnapshotFor(params.stateDir, toVersion, fromVersion);
  const plan = snapshot
    ? await planSnapshotRestore({
        manifest: snapshot.manifest,
        snapshotDir: snapshot.dir,
        mode: params.mode,
        // The snapshot records what the rollback target itself knows (it
        // took the snapshot); the caller's value is the fallback.
        targetMemorySchemaLatest:
          snapshot.manifest.fromMemorySchemaLatest > 0
            ? snapshot.manifest.fromMemorySchemaLatest
            : params.targetMemorySchemaLatest,
        includeData: params.includeData,
        readSchemaVersion: params.readSchemaVersion,
      })
    : null;
  if (params.dryRun) {
    return {
      from: fromVersion,
      to: toVersion,
      plan,
      restore: null,
      snapshotDir: snapshot?.dir ?? null,
    };
  }
  swapVersionLink(appDir, CURRENT_LINK, toVersion);
  if (fromVersion !== toVersion && fs.existsSync(path.join(appDir, fromVersion))) {
    swapVersionLink(appDir, PREVIOUS_LINK, fromVersion);
  }
  const restore =
    plan && snapshot ? applySnapshotRestore({ plan, snapshotDir: snapshot.dir }) : null;
  log.info(
    `rolled back v${fromVersion} -> v${toVersion} (${params.mode}); restored ${restore?.restored.length ?? 0} file(s)`,
  );
  return { from: fromVersion, to: toVersion, plan, restore, snapshotDir: snapshot?.dir ?? null };
}

/** current/previous as the links name them. */
export function readTarballVersions(appDir: string): {
  current: string | null;
  previous: string | null;
} {
  return {
    current: readVersionLink(appDir, CURRENT_LINK),
    previous: readVersionLink(appDir, PREVIOUS_LINK),
  };
}

export { ReleaseVerificationError };
