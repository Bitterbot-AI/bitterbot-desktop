import { loadConfig } from "../../config/config.js";
import { resolveBitterbotPackageRoot } from "../../infra/bitterbot-root.js";
import { armBootVerify, clearRollbackRecord } from "../../infra/boot-verify.js";
import { spawnBootWatchdog } from "../../infra/boot-watchdog.js";
import {
  CONTAINER_FALSE_POSITIVE_HINT,
  CONTAINER_UPDATE_COMMAND,
  externalUpdateCommand,
  readDeclaredInstallKind,
  TARBALL_UPDATE_REFUSAL,
} from "../../infra/install-kind.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  fetchLatestGithubRelease,
  githubReleaseTargetFor,
  peekLatestGithubRelease,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { computeUpdateStaleness } from "../../infra/update-staleness.js";
import { VERSION } from "../../version.js";
import {
  ErrorCodes,
  errorShape,
  validateUpdateCheckParams,
  validateUpdateRunParams,
} from "../protocol/index.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Single-flight: concurrent update.check calls share one underlying probe so
// a click-happy client cannot fan out parallel `git fetch` subprocesses.
let inflightCheck: Promise<Record<string, unknown>> | null = null;

async function performUpdateCheck(fetch: boolean, timeoutMs: number) {
  const config = loadConfig();
  const channel = normalizeUpdateChannel(config.update?.channel) ?? null;
  const root =
    (await resolveBitterbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();
  const check = await checkUpdateStatus({
    root,
    timeoutMs,
    fetchGit: fetch,
    includeRegistry: false,
  });
  // Package installs compare against their own channel's dist-tag, not
  // `latest` — a beta node must not be nagged toward a tag it won't install.
  let channelVersion: string | null = null;
  if (check.installKind === "package" && fetch) {
    const resolved = await resolveNpmChannelTag({
      channel: channel ?? DEFAULT_PACKAGE_CHANNEL,
      timeoutMs: 2500,
    });
    channelVersion = resolved.version;
  }
  // Containers and release-tarball installs compare against the newest
  // GitHub release carrying their asset (cached for 30 min inside
  // fetchLatestGithubRelease, so repeated UI checks do not hit the API).
  const releaseTarget = githubReleaseTargetFor(check.installKind);
  if (releaseTarget) {
    const release = fetch
      ? await fetchLatestGithubRelease({ timeoutMs: 2500, target: releaseTarget })
      : peekLatestGithubRelease(Date.now(), releaseTarget);
    channelVersion = release?.latestVersion ?? null;
  }
  const staleness = computeUpdateStaleness(check, config.update?.promptBehindCommits, {
    channelVersion,
  });
  return {
    ok: true,
    version: VERSION,
    channel,
    check,
    registryLatest: channelVersion,
    updateCommand: externalUpdateCommand(check.installKind),
    staleness,
    checkedAt: Date.now(),
  };
}

/** The shared refusal text for update.run inside a container. */
export const CONTAINER_UPDATE_REFUSAL =
  `This gateway runs in a container, so it cannot update itself: its code is the image. ` +
  `Pull a newer image instead: ${CONTAINER_UPDATE_COMMAND} ` +
  `(on a VPS from the template: /opt/bitterbot/update.sh; on Fly.io: fly deploy). ` +
  CONTAINER_FALSE_POSITIVE_HINT;

export const updateHandlers: GatewayRequestHandlers = {
  "update.check": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateCheckParams, "update.check", respond)) {
      return;
    }
    const fetch = (params as { fetch?: boolean }).fetch !== false;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.min(120_000, Math.max(1000, Math.floor(timeoutMsRaw)))
        : 15_000;
    try {
      if (!inflightCheck) {
        inflightCheck = performUpdateCheck(fetch, timeoutMs).finally(() => {
          inflightCheck = null;
        });
      }
      respond(true, await inflightCheck);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `update check failed: ${String(err)}`),
      );
    }
  },

  "update.run": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const root =
      (await resolveBitterbotPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      }).catch(() => null)) ?? process.cwd();
    // One probe for both the container refusal and the default channel. No
    // fetch and no registry: this only reads the local install.
    const local = await checkUpdateStatus({
      root,
      timeoutMs: 4000,
      fetchGit: false,
      includeRegistry: false,
    }).catch(() => null);
    // A container cannot update itself in place: its code is the image, and
    // the next restart would bring the old one back (PLAN-53 F1). Detected
    // from BITTERBOT_INSTALL_KIND or, for images that do not set it, the
    // container heuristic (never for a git checkout).
    if (process.env.BITTERBOT_INSTALL_KIND === "container" || local?.installKind === "container") {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, CONTAINER_UPDATE_REFUSAL));
      return;
    }
    // A release-tarball install (PLAN-56 Phase 3a) has no in-place updater
    // yet: re-running install.sh is the update. Phase 3b replaces this
    // refusal with snapshot/stage/activate/rollback.
    if (
      local?.installKind === "tarball" ||
      (local === null && readDeclaredInstallKind() === "tarball")
    ) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, TARBALL_UPDATE_REFUSAL));
      return;
    }
    const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      const config = loadConfig();
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      // A git checkout sitting on a release tag follows `stable` (or `beta`
      // for a beta tag) when no channel is configured (PLAN-56 §3.5); the
      // runner's own default stays `dev` for checkouts on a branch.
      const effective =
        local && !configChannel
          ? resolveEffectiveUpdateChannel({
              configChannel: null,
              installKind: local.installKind,
              git: local.git ? { tag: local.git.tag, branch: local.git.branch } : undefined,
            })
          : null;
      const channel =
        configChannel ?? (effective?.source === "git-tag" ? effective.channel : undefined);
      result = await runGatewayUpdate({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
        channel,
      });
    } catch (err) {
      result = {
        status: "error",
        mode: "unknown",
        reason: String(err),
        steps: [],
        durationMs: 0,
      };
    }

    const payload: RestartSentinelPayload = {
      kind: "update",
      status: result.status,
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: result.mode,
        root: result.root ?? undefined,
        before: result.before ?? null,
        after: result.after ?? null,
        steps: result.steps.map((step) => ({
          name: step.name,
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            stdoutTail: step.stdoutTail ?? null,
            stderrTail: step.stderrTail ?? null,
            exitCode: step.exitCode ?? null,
          },
        })),
        reason: result.reason ?? null,
        durationMs: result.durationMs,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Only restart when the update actually applied: a `skipped` (dirty tree,
    // no upstream) or `error` run changed nothing, and bouncing the gateway
    // for a no-op would kill live chat/agent sessions for nothing.
    let restart = null;
    if (result.status === "ok") {
      // Arm the boot-health beacon BEFORE the restart: if the freshly-built
      // gateway never comes up, doctor will surface it with this rollback sha.
      // The new gateway clears the beacon the moment it is listening.
      armBootVerify({ prevSha: result.before?.sha ?? null, reason: "update.run" });
      // A clean update supersedes any earlier rollback state.
      clearRollbackRecord();
      // The beacon is the signal; the watchdog is the actor. Spawned detached
      // so it survives this process's restart and can perform ONE guarded
      // rollback if the fresh build never confirms a healthy boot.
      if (result.root) {
        spawnBootWatchdog({
          root: result.root,
          prevSha: result.before?.sha ?? null,
          autoRollbackEnabled: loadConfig().update?.autoRollback?.enabled !== false,
        });
      }
      restart = scheduleGatewaySigusr1Restart({
        delayMs: restartDelayMs,
        reason: "update.run",
      });
      // No UI process to bounce any more (PLAN-39 Phase 4): the gateway serves
      // the Control UI from dist/control-ui per request, so after ui:build
      // restages the assets, the next browser reload simply gets the new code.
    }

    respond(
      true,
      {
        ok: true,
        result,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
