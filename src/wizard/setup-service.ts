/**
 * The "Keep running" setup step's backend (PLAN-56 Phase 4): whether a
 * background gateway service can be installed here, and installing it.
 *
 * The decision mirrors the terminal QuickStart's finalize step
 * (src/wizard/onboarding.finalize.ts): no service in a container (the image
 * runs the gateway), none on Linux without systemd user services, nothing to
 * do when one is already installed for this install. When the installed one
 * runs another install (a git clone, an older release; `elsewhere`), the step
 * offers to point it at this version, the same re-install
 * `bitterbot gateway switch` does. The install itself is the same one
 * `bitterbot onboard --non-interactive --install-daemon` runs, plus systemd
 * lingering so the service survives logout.
 */

import type { BitterbotConfig } from "../config/config.js";
import { serviceLabelFor } from "../infra/gateway-switch.js";
import type { InstallKind } from "../infra/install-kind.js";

export { serviceLabelFor };

export type SetupServiceSupport =
  | { kind: "available"; label: string }
  | { kind: "installed"; label: string }
  /**
   * A service is installed but runs another install (a git clone, an older
   * release): `runsFrom` names it ("Bitterbot 1.4.0 from ~/bitterbot-desktop
   * (git clone)"). The step offers to point it at this version.
   */
  | { kind: "elsewhere"; label: string; runsFrom: string }
  | { kind: "unavailable"; reason: string };

export async function detectSetupServiceSupport(params: {
  installKind: InstallKind;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  systemdAvailable?: () => Promise<boolean>;
  isLoaded?: () => Promise<boolean>;
  /** Where the installed service runs from: null when it runs this install (or is unknown). */
  runsElsewhere?: () => Promise<string | null>;
}): Promise<SetupServiceSupport> {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  if (params.installKind === "container") {
    return { kind: "unavailable", reason: "container" };
  }
  // Never install a real service from a test run.
  if (!params.isLoaded && (env.VITEST || env.NODE_ENV === "test")) {
    return { kind: "unavailable", reason: "test" };
  }
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { kind: "unavailable", reason: "platform" };
  }
  const label = serviceLabelFor(platform);
  try {
    if (platform === "linux") {
      const available =
        params.systemdAvailable ??
        (async () => (await import("../daemon/systemd.js")).isSystemdUserServiceAvailable());
      if (!(await available())) {
        return { kind: "unavailable", reason: "no-systemd" };
      }
    }
    const isLoaded =
      params.isLoaded ??
      (async () => {
        const { resolveGatewayService } = await import("../daemon/service.js");
        return resolveGatewayService().isLoaded({ env });
      });
    if (!(await isLoaded())) {
      return { kind: "available", label };
    }
    // A test that fakes isLoaded never reaches the real service reader.
    const runsElsewhere =
      params.runsElsewhere ??
      (params.isLoaded ? async () => null : () => describeServiceElsewhere({ env }));
    const runsFrom = await runsElsewhere().catch(() => null);
    return runsFrom ? { kind: "elsewhere", label, runsFrom } : { kind: "installed", label };
  } catch {
    return { kind: "unavailable", reason: "probe-failed" };
  }
}

/**
 * When the installed gateway service runs another install, a plain-language
 * name for it (src/infra/gateway-switch-system.ts); null when it runs this
 * install, none is installed, or its definition cannot be resolved.
 */
export async function describeServiceElsewhere(params: {
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const env = params.env ?? process.env;
  const system = await import("../infra/gateway-switch-system.js");
  const self = await system.resolveSelfInstall();
  const found = await system.inspectGatewayService({ self, env });
  if (!found || found.pointsHere) {
    return null;
  }
  // A service for other settings (state dir, profile, port) is not this
  // setup's to take over.
  const { loadConfig, resolveGatewayPort } = await import("../config/config.js");
  if (await system.serviceTargetMismatch(found, env, resolveGatewayPort(loadConfig(), env))) {
    return null;
  }
  const { describeInstall } = await import("../cli/daemon-cli/switch.js");
  return describeInstall(found.runsFrom);
}

export type SetupServiceInstallResult =
  | { ok: true; label: string }
  | { ok: false; label: string; error: string };

/** Install (and start) the gateway service for `config`. Never throws. */
export async function installSetupGatewayService(params: {
  config: BitterbotConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SetupServiceInstallResult> {
  const env = params.env ?? process.env;
  const label = serviceLabelFor(process.platform);
  try {
    const { resolveGatewayService } = await import("../daemon/service.js");
    const { buildGatewayInstallPlan } = await import("../commands/daemon-install-helpers.js");
    const { DEFAULT_GATEWAY_DAEMON_RUNTIME } = await import("../commands/daemon-runtime.js");
    const { ensureSystemdUserLingerNonInteractive } = await import("../commands/systemd-linger.js");
    const { Writable } = await import("node:stream");
    const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const quiet = {
      log: () => {},
      error: () => {},
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    };
    const service = resolveGatewayService();
    const token = params.config.gateway?.auth?.token;
    // Re-pointing a service from another install keeps its environment
    // (keys set with `gateway install`, state dir, profile).
    const previous = (await service.isLoaded({ env }).catch(() => false))
      ? await service.readCommand(env).catch(() => null)
      : null;
    const { carriedServiceEnv } = await import("../infra/gateway-switch-env.js");
    const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
      env,
      port: params.port,
      token: typeof token === "string" ? token : undefined,
      runtime: DEFAULT_GATEWAY_DAEMON_RUNTIME,
      warn: () => {},
      config: params.config,
    });
    await service.install({
      env,
      stdout: sink,
      programArguments,
      workingDirectory,
      environment: { ...carriedServiceEnv(previous?.environment), ...environment },
    });
    await ensureSystemdUserLingerNonInteractive({ runtime: quiet, env });
    return { ok: true, label };
  } catch (err) {
    return { ok: false, label, error: err instanceof Error ? err.message : String(err) };
  }
}
