/**
 * `bitterbot update` for release-tarball installs (PLAN-56 Phase 3b).
 *
 *   bitterbot update                 newest complete release (stable)
 *   bitterbot update --check         only report current vs newest
 *   bitterbot update --tag 1.6.0     pin a release (downgrades ask first)
 *   bitterbot update --reinstall     re-download and replace this version
 *   bitterbot update --rollback      switch back to `previous`
 *                    --restore-data    ...and restore the memory databases
 *                    --restore-config  ...and restore the config file
 *   bitterbot update --json          machine output
 *
 * The heavy lifting is src/infra/tarball-updater.ts; this file decides the
 * target, prints progress, restarts the gateway and waits for the boot
 * verdict (healthy, or rolled back by the boot watchdog).
 */

import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import type { BitterbotConfig } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { callGateway } from "../../gateway/call.js";
import {
  disarmBootVerify,
  readBootVerify,
  readRollbackRecord,
  type BootVerifyRecord,
} from "../../infra/boot-verify.js";
import { checkGatewayGone, waitForGatewayGone } from "../../infra/gateway-presence.js";
import { resolveLatestTarballVersion } from "../../infra/tarball-release.js";
import {
  armTarballBootVerify,
  resolveTarballUpdateContext,
  type TarballUpdateContext,
} from "../../infra/tarball-update-flow.js";
import {
  readTarballVersions,
  rollbackTarballInstall,
  runTarballUpdate,
  type TarballUpdateResult,
} from "../../infra/tarball-updater.js";
import { spawnTarballBootWatchdog } from "../../infra/tarball-watchdog-spawn.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import type { UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import { runDaemonRestart } from "../daemon-cli.js";
import type { UpdateCommandOptions } from "./shared.js";

const POLL_MS = 2_000;
/** Wait beyond the beacon deadline: the watchdog's grace plus the old version's boot. */
const WAIT_SLACK_MS = 3 * 60_000;

type Emit = {
  json: boolean;
  log: (line: string) => void;
  out: Record<string, unknown>;
};

function fail(emit: Emit, message: string, extra: Record<string, unknown> = {}): void {
  if (emit.json) {
    defaultRuntime.log(JSON.stringify({ ...emit.out, ...extra, status: "error", reason: message }));
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
}

function finish(emit: Emit, extra: Record<string, unknown>, code = 0): void {
  if (emit.json) {
    defaultRuntime.log(JSON.stringify({ ...emit.out, ...extra }));
  }
  defaultRuntime.exit(code);
}

function describeStep(step: UpdateStepResult): string {
  const secs = (step.durationMs / 1000).toFixed(1);
  return step.exitCode === 0
    ? `${theme.success("ok")}  ${step.name} ${theme.muted(`(${secs}s) ${step.command}`)}`
    : `${theme.error("FAILED")}  ${step.name}: ${step.stderrTail ?? ""}`;
}

async function serviceLoaded(): Promise<boolean> {
  try {
    return await resolveGatewayService().isLoaded({ env: process.env });
  } catch {
    return false;
  }
}

/** The local gateway's version over RPC, or null when none answers. */
async function localGatewayVersion(cfg: BitterbotConfig): Promise<string | null> {
  if (cfg.gateway?.mode === "remote") {
    return null;
  }
  try {
    const res = await callGateway<{ version?: unknown }>({
      method: "update.check",
      params: { fetch: false },
      timeoutMs: 5_000,
      config: cfg,
    });
    return typeof res.version === "string" ? res.version : "unknown";
  } catch {
    return null;
  }
}

export type TarballBootOutcome =
  | { status: "healthy"; version: string }
  | { status: "rolled-back"; version: string; healthy: boolean; detail: string }
  | { status: "rollback-failed"; detail: string }
  | { status: "timeout"; detail: string };

/**
 * Wait for the verdict on a restart into `toVersion`: the beacon clears
 * (healthy), or the watchdog writes a tarball rollback record.
 */
export async function waitForTarballBoot(params: {
  beacon: BootVerifyRecord;
  toVersion: string;
  fromVersion: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TarballBootOutcome> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = params.beacon.deadlineAt + WAIT_SLACK_MS;
  let rolledBack: { detail: string } | null = null;
  // The watchdog writes "rollback in progress" before it acts and the final
  // record after. The old version can come up (clearing the re-armed beacon)
  // before the final record lands: a cleared beacon then is NOT a healthy
  // update.
  let rollbackPending = false;
  while (now() < until) {
    const record = readRollbackRecord();
    if (record?.mode === "tarball" && record.at >= params.beacon.armedAt) {
      const inProgress = !record.ok && record.detail.startsWith("rollback in progress");
      if (!record.ok && !inProgress) {
        return { status: "rollback-failed", detail: record.detail };
      }
      rollbackPending = inProgress;
      if (record.ok) {
        rolledBack = { detail: record.detail };
      }
    }
    const beacon = readBootVerify();
    if (!beacon && rolledBack) {
      return { status: "rolled-back", version: params.fromVersion, healthy: true, ...rolledBack };
    }
    if (!beacon && !rollbackPending) {
      return { status: "healthy", version: params.toVersion };
    }
    await sleep(POLL_MS);
  }
  if (rolledBack || rollbackPending) {
    return {
      status: "rolled-back",
      version: params.fromVersion,
      healthy: false,
      detail: rolledBack?.detail ?? "the boot watchdog is rolling back (not finished yet)",
    };
  }
  return {
    status: "timeout",
    detail: `v${params.toVersion} has not confirmed a healthy boot yet. The boot watchdog keeps watching and rolls back automatically (unless update.autoRollback.enabled is false); \`${formatCliCommand("bitterbot doctor")}\` shows the state, \`${formatCliCommand("bitterbot update --rollback")}\` switches back by hand.`,
  };
}

type RestartPlan = { kind: "service" } | { kind: "respawn" } | { kind: "none"; reason: string };

async function decideRestart(cfg: BitterbotConfig): Promise<RestartPlan> {
  if (await serviceLoaded()) {
    return { kind: "service" };
  }
  if ((await localGatewayVersion(cfg)) !== null) {
    return { kind: "respawn" };
  }
  return { kind: "none", reason: "no gateway service is installed and no local gateway answered" };
}

/** Restart into the new version and wait for the verdict. */
async function restartAndVerify(params: {
  ctx: TarballUpdateContext;
  result: TarballUpdateResult;
  cfg: BitterbotConfig;
  emit: Emit;
}): Promise<{ code: number; extra: Record<string, unknown> }> {
  const { ctx, result, cfg, emit } = params;
  const plan = await decideRestart(cfg);
  if (plan.kind === "none") {
    emit.log(
      theme.muted(
        `No running gateway to restart (${plan.reason}). Start v${result.to} with: ${formatCliCommand("bitterbot gateway")}`,
      ),
    );
    return { code: 0, extra: { restart: { kind: "none" } } };
  }
  const beacon = armTarballBootVerify({
    ctx,
    toVersion: result.to,
    snapshotDir: result.snapshotDir,
    restart: plan.kind,
    reason: "cli-update",
    preflight: result.preflight,
  });
  if (!beacon) {
    emit.log(theme.warn("Could not arm the boot check; restart the gateway yourself."));
    return { code: 1, extra: { restart: { kind: plan.kind, armed: false } } };
  }
  if (plan.kind === "service") {
    if (ctx.autoRollback) {
      spawnTarballBootWatchdog({ root: ctx.root, armedAt: beacon.armedAt });
    }
    emit.log(theme.heading("Restarting the gateway service..."));
    const restarted = await runDaemonRestart({ json: emit.json }).catch(() => false);
    if (!restarted) {
      disarmBootVerify();
      emit.log(
        theme.warn(
          `The service did not restart. Restart it with: ${formatCliCommand("bitterbot gateway restart")}`,
        ),
      );
      return { code: 1, extra: { restart: { kind: "service", restarted: false } } };
    }
  } else {
    emit.log(theme.heading("Restarting the running gateway into the new version..."));
    try {
      await callGateway({ method: "system.restart", timeoutMs: 10_000, config: cfg });
    } catch (err) {
      disarmBootVerify();
      emit.log(theme.warn(`The gateway did not accept the restart: ${String(err)}`));
      emit.log(theme.muted(`Restart it yourself to run v${result.to}.`));
      return { code: 1, extra: { restart: { kind: "respawn", restarted: false } } };
    }
  }
  emit.log(theme.muted(`Waiting for v${result.to} to confirm a healthy boot...`));
  const outcome = await waitForTarballBoot({
    beacon,
    toVersion: result.to,
    fromVersion: result.from,
  });
  switch (outcome.status) {
    case "healthy": {
      // An older gateway (one without the version-checked boot beacon) that
      // restarted itself instead of the new version would also clear it:
      // ask the gateway which version answers.
      const answered = await localGatewayVersion(cfg);
      if (answered && answered !== "unknown" && answered !== result.to) {
        emit.log(
          theme.error(
            `The gateway answers as v${answered}, not v${result.to}: it restarted its old code. Stop it and start it again (${formatCliCommand("bitterbot gateway")}).`,
          ),
        );
        return {
          code: 1,
          extra: {
            restart: { kind: plan.kind },
            boot: { status: "unexpected-version", version: answered },
          },
        };
      }
      emit.log(theme.success(`Gateway is healthy on v${outcome.version}.`));
      return { code: 0, extra: { restart: { kind: plan.kind }, boot: outcome } };
    }
    case "rolled-back":
      emit.log(
        theme.error(
          `v${result.to} did not boot; the watchdog rolled back to v${outcome.version}${outcome.healthy ? ", which is healthy again" : ""}. (${outcome.detail})`,
        ),
      );
      return { code: 1, extra: { restart: { kind: plan.kind }, boot: outcome } };
    default:
      emit.log(theme.error(outcome.detail));
      return { code: 1, extra: { restart: { kind: plan.kind }, boot: outcome } };
  }
}

async function confirmOrExit(
  message: string,
  opts: UpdateCommandOptions,
  emit: Emit,
): Promise<boolean> {
  if (opts.yes) {
    return true;
  }
  if (!process.stdin.isTTY || opts.json) {
    fail(emit, `${message} Re-run with --yes to confirm non-interactively.`);
    return false;
  }
  const ok = await confirm({ message: stylePromptMessage(message), initialValue: false });
  if (isCancel(ok) || !ok) {
    emit.log(theme.muted("Cancelled."));
    defaultRuntime.exit(0);
    return false;
  }
  return true;
}

export type TarballCliOptions = UpdateCommandOptions & {
  check?: boolean;
  rollback?: boolean;
  reinstall?: boolean;
  restoreData?: boolean;
  restoreConfig?: boolean;
};

/**
 * Order two release versions. `compareSemverStrings` applies the SemVer
 * pre-release tie-break, so `1.10.1-beta.2` sorts behind `1.10.1` and an
 * install left on a beta still moves forward to the release it preceded.
 * Kept as a named helper for the call sites and tests that read as
 * "release order".
 */
export function releaseOrder(from: string, target: string): number | null {
  return compareSemverStrings(from, target);
}

export async function runTarballUpdateCommand(params: {
  root: string;
  opts: TarballCliOptions;
}): Promise<void> {
  const { opts } = params;
  const json = Boolean(opts.json);
  const emit: Emit = {
    json,
    log: (line) => {
      if (!json) {
        defaultRuntime.log(line);
      }
    },
    out: { installKind: "tarball" },
  };
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;

  const configSnapshot = await readConfigFileSnapshot();
  const cfg: BitterbotConfig = configSnapshot.valid ? configSnapshot.config : {};
  let ctx: TarballUpdateContext;
  try {
    ctx = resolveTarballUpdateContext({
      root: params.root,
      config: cfg,
      allowTestMode: true,
      warn: (msg) => emit.log(theme.warn(msg)),
    });
  } catch (err) {
    fail(emit, String(err instanceof Error ? err.message : err));
    return;
  }
  emit.out.current = ctx.fromVersion;
  if (ctx.source.testMode) {
    emit.log(
      theme.warn(
        `TEST MODE: releases from ${ctx.source.baseUrl} with a test signing key. This is not a production update.`,
      ),
    );
  }

  if (opts.rollback) {
    await runTarballRollback({ ctx, cfg, opts, emit });
    return;
  }

  const requested = normalizeUpdateChannel(opts.channel);
  if (opts.channel && requested !== "stable") {
    fail(
      emit,
      `Release-tarball installs follow the stable channel (got "${opts.channel}"). Pin a release with --tag X.Y.Z instead.`,
    );
    return;
  }
  if (requested === "stable" && configSnapshot.valid && cfg.update?.channel !== "stable") {
    await writeConfigFile({ ...cfg, update: { ...cfg.update, channel: "stable" } });
    emit.log(theme.muted("Update channel set to stable."));
  }

  let target: string | null;
  let latest: string | null = null;
  if (opts.reinstall) {
    target = ctx.fromVersion;
  } else if (opts.tag) {
    const pinned = opts.tag
      .trim()
      .replace(/^v/, "")
      .replace(/^bitterbot@/, "");
    if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
      fail(
        emit,
        `--tag must be a release version like 1.6.0 for a tarball install (got "${opts.tag}")`,
      );
      return;
    }
    target = pinned;
  } else {
    try {
      latest = await resolveLatestTarballVersion(ctx.source, ctx.platformId, timeoutMs ?? 15_000);
    } catch (err) {
      fail(
        emit,
        `Could not look up the newest release: ${String(err instanceof Error ? err.message : err)}`,
      );
      return;
    }
    if (!latest) {
      fail(emit, `No published release carries a signed tarball for ${ctx.platformId} yet.`);
      return;
    }
    target = latest;
  }
  emit.out.target = target;
  const cmp = releaseOrder(ctx.fromVersion, target);

  if (opts.check) {
    const available = cmp != null && cmp < 0;
    emit.log(
      available
        ? theme.warn(
            `Update available: v${ctx.fromVersion} -> v${target}. Run: ${formatCliCommand("bitterbot update")}`,
          )
        : `v${ctx.fromVersion} is current (newest release v${target}).`,
    );
    finish(emit, { status: "checked", updateAvailable: available });
    return;
  }
  if (cmp === 0 && !opts.reinstall) {
    emit.log(`Already on v${target}, the ${opts.tag ? "requested" : "newest"} release.`);
    finish(emit, { status: "skipped", reason: "up-to-date" });
    return;
  }
  if (cmp != null && cmp > 0) {
    const ok = await confirmOrExit(
      `Downgrading from v${ctx.fromVersion} to v${target} can break configuration. Continue?`,
      opts,
      emit,
    );
    if (!ok) {
      return;
    }
  }

  emit.log(
    theme.heading(
      opts.reinstall
        ? `Reinstalling v${target}...`
        : `Updating Bitterbot v${ctx.fromVersion} -> v${target}...`,
    ),
  );
  let result: TarballUpdateResult;
  try {
    result = await runTarballUpdate({
      appDir: ctx.appDir,
      platformId: ctx.platformId,
      fromVersion: ctx.fromVersion,
      targetVersion: target,
      source: ctx.source,
      snapshot: ctx.snapshot,
      fromMemorySchemaLatest: ctx.memorySchemaLatest,
      reinstall: opts.reinstall,
      runningVersion: path.basename(ctx.root),
      timeoutMs,
      onStep: (step) => emit.log(describeStep(step)),
    });
  } catch (err) {
    fail(
      emit,
      `Update failed, nothing was activated: ${String(err instanceof Error ? err.message : err)}`,
    );
    return;
  }
  emit.out.result = {
    from: result.from,
    to: result.to,
    snapshotDir: result.snapshotDir,
    reused: result.reused,
    pruned: result.pruned.removed,
    warnings: result.preflight.warnings,
  };
  emit.log("");
  emit.log(`Activated v${result.to} (previous: v${result.from}).`);
  emit.log(theme.muted(`Snapshot of your data: ${result.snapshotDir}`));
  for (const w of result.preflight.warnings) {
    emit.log(theme.muted(`  note: ${w}`));
  }
  if (result.pruned.removed.length > 0) {
    emit.log(theme.muted(`Removed old versions: ${result.pruned.removed.join(", ")}`));
  }

  if (opts.restart === false || opts.reinstall) {
    emit.log(
      theme.muted(
        `Restart the gateway to run v${result.to}: ${formatCliCommand("bitterbot gateway restart")}`,
      ),
    );
    finish(emit, { status: "ok", restart: { kind: "skipped" } });
    return;
  }
  const verdict = await restartAndVerify({ ctx, result, cfg, emit });
  finish(emit, { status: verdict.code === 0 ? "ok" : "error", ...verdict.extra }, verdict.code);
}

async function runTarballRollback(params: {
  ctx: TarballUpdateContext;
  cfg: BitterbotConfig;
  opts: TarballCliOptions;
  emit: Emit;
}): Promise<void> {
  const { ctx, cfg, opts, emit } = params;
  const { current, previous } = readTarballVersions(ctx.appDir);
  const from = current ?? ctx.fromVersion;
  if (!previous || previous === from) {
    fail(emit, "There is no previous version to roll back to.");
    return;
  }
  const preview = await rollbackTarballInstall({
    appDir: ctx.appDir,
    stateDir: ctx.snapshot.stateDir,
    fromVersion: from,
    toVersion: previous,
    mode: "manual",
    targetMemorySchemaLatest: ctx.memorySchemaLatest,
    includeData: opts.restoreData,
    restoreConfig: opts.restoreConfig,
    dryRun: true,
  }).catch((err: unknown) => {
    fail(emit, String(err instanceof Error ? err.message : err));
    return null;
  });
  if (!preview) {
    return;
  }
  emit.log(theme.heading(`Rolling back v${from} -> v${previous}`));
  if (!preview.plan) {
    emit.log(theme.muted("No snapshot for this update was found; only the version switches."));
  } else {
    for (const r of preview.plan.restore) {
      emit.log(`  restore ${r.entry.source} (${r.reason})`);
    }
    for (const k of preview.plan.kept) {
      emit.log(theme.muted(`  keep    ${k.source}: ${k.reason}`));
    }
  }
  const touchesDatabases = preview.plan?.restore.some((r) => r.entry.kind === "database") ?? false;
  const loaded = await serviceLoaded();
  // A database is never replaced under a live gateway. "No RPC answer" proves
  // nothing (remote mode, auth, a hung gateway): gateway-presence.ts checks
  // the gateway lock and the configured port instead.
  if (touchesDatabases && !loaded) {
    const presence = await checkGatewayGone({ port: ctx.gatewayPort });
    if (!presence.gone) {
      fail(
        emit,
        `Restoring databases needs the gateway stopped (${presence.detail}). Stop it (${formatCliCommand("bitterbot gateway stop")} or Ctrl-C), then re-run this command.`,
      );
      return;
    }
  }
  if (!(await confirmOrExit(`Switch back to v${previous}?`, opts, emit))) {
    return;
  }
  if (touchesDatabases && loaded) {
    try {
      await resolveGatewayService().stop({ env: process.env, stdout: process.stdout });
    } catch (err) {
      emit.log(theme.warn(`Stopping the gateway service failed: ${String(err)}`));
    }
  }
  const res = await rollbackTarballInstall({
    appDir: ctx.appDir,
    stateDir: ctx.snapshot.stateDir,
    fromVersion: from,
    toVersion: previous,
    mode: "manual",
    targetMemorySchemaLatest: ctx.memorySchemaLatest,
    includeData: opts.restoreData,
    restoreConfig: opts.restoreConfig,
    gatewayCheck: () => waitForGatewayGone({ port: ctx.gatewayPort, timeoutMs: 30_000 }),
  });
  emit.out.rollback = {
    from: res.from,
    to: res.to,
    restored: res.restore?.restored ?? [],
    displacedDir: res.restore?.displacedDir ?? null,
    snapshotDir: res.snapshotDir,
    databasesSkipped: res.databasesSkipped,
  };
  emit.log(`current -> v${previous}, previous -> v${from}.`);
  if (res.disarmedBeacon) {
    emit.log(
      theme.muted("The pending update's boot check was cancelled (its watchdog stands down)."),
    );
  }
  if (res.restore && res.restore.restored.length > 0) {
    emit.log(
      theme.muted(
        `Restored ${res.restore.restored.length} file(s); the replaced ones are kept in ${res.restore.displacedDir}`,
      ),
    );
  }
  // The databases were asked for and not restored: say so loudly, and how to
  // finish by hand (re-running --rollback would now switch the other way).
  const code = res.databasesSkipped ? 1 : 0;
  if (res.databasesSkipped) {
    emit.log(
      theme.error(
        `The databases were NOT restored: ${res.databasesSkipped}. The version switch is done. To restore them, stop every gateway, then copy the files from ${res.snapshotDir ?? "the snapshot"}/memory over ${path.join(ctx.snapshot.stateDir, "memory")} (move the current ones aside first).`,
      ),
    );
  }
  const status = code === 0 ? "ok" : "partial";
  if (opts.restart === false) {
    finish(emit, { status, restart: { kind: "skipped" } }, code);
    return;
  }
  let restarted = false;
  if (loaded) {
    restarted = await runDaemonRestart({ json: emit.json }).catch(() => false);
  } else if ((await localGatewayVersion(cfg)) !== null) {
    restarted = await callGateway({ method: "system.restart", timeoutMs: 10_000, config: cfg })
      .then(() => true)
      .catch(() => false);
  }
  if (!restarted) {
    emit.log(
      theme.muted(
        `Start the gateway to run v${previous}: ${formatCliCommand("bitterbot gateway")}`,
      ),
    );
    finish(emit, { status, restart: { kind: "none" } }, code);
    return;
  }
  // Best effort: the old version answering over RPC.
  const deadline = Date.now() + 5 * 60_000;
  let answered: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    answered = await localGatewayVersion(cfg);
    if (answered === previous) {
      break;
    }
  }
  if (answered === previous) {
    emit.log(theme.success(`Gateway is healthy on v${previous}.`));
    finish(emit, { status, boot: { status: "healthy", version: previous } }, code);
  } else {
    emit.log(
      theme.warn(
        `The gateway has not answered as v${previous} yet; check ${formatCliCommand("bitterbot gateway status")}.`,
      ),
    );
    finish(emit, { status, boot: { status: "unconfirmed", answered } }, code);
  }
}
