import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveBitterbotPackageRoot } from "../../infra/bitterbot-root.js";
import { armBootVerify, clearRollbackRecord } from "../../infra/boot-verify.js";
import { spawnBootWatchdog } from "../../infra/boot-watchdog.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { DEFAULT_PACKAGE_CHANNEL, normalizeUpdateChannel } from "../../infra/update-channels.js";
import { checkUpdateStatus, resolveNpmChannelTag } from "../../infra/update-check.js";
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
  const staleness = computeUpdateStaleness(check, config.update?.promptBehindCommits, {
    channelVersion,
  });
  return {
    ok: true,
    version: VERSION,
    channel,
    check,
    registryLatest: channelVersion,
    staleness,
    checkedAt: Date.now(),
  };
}

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
      const root =
        (await resolveBitterbotPackageRoot({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        })) ?? process.cwd();
      result = await runGatewayUpdate({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
        channel: configChannel ?? undefined,
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
