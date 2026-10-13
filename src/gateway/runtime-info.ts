/**
 * The gateway process's own facts for the Overview cards and `status` RPC:
 * the real package version (src/version.ts, the same source the Control UI
 * footer is built from), process uptime, platform/arch, and the install kind.
 *
 * Before this, the hello frame reported `npm_package_version`, which is only
 * set under `pnpm start`, so installer and package installs said "dev", and
 * the Overview cards read fields no RPC returned and always showed a dash.
 */

import { resolveBitterbotPackageRootSync } from "../infra/bitterbot-root.js";
import { detectInstallKind, type InstallKind } from "../infra/install-kind.js";
import { VERSION } from "../version.js";
import type { GatewayRuntime } from "./protocol/index.js";

/** The version the gateway reports: an explicit override, else the package version. */
export function resolveGatewayVersion(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BITTERBOT_VERSION?.trim();
  if (override) {
    return override;
  }
  return VERSION && VERSION !== "0.0.0" ? VERSION : (env.npm_package_version ?? "dev");
}

let cachedInstallKind: InstallKind | null = null;

function resolveInstallKindCached(): InstallKind {
  if (cachedInstallKind) {
    return cachedInstallKind;
  }
  let root: string | null = null;
  try {
    root = resolveBitterbotPackageRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  } catch {
    root = null;
  }
  cachedInstallKind = detectInstallKind(root);
  return cachedInstallKind;
}

/** Test hook: forget the cached install kind. */
export function resetGatewayRuntimeInfoCacheForTest(): void {
  cachedInstallKind = null;
}

export function buildGatewayRuntimeInfo(
  opts: {
    env?: NodeJS.ProcessEnv;
    uptimeSeconds?: number;
    platform?: string;
    arch?: string;
    nodeVersion?: string;
    installKind?: InstallKind;
  } = {},
): GatewayRuntime {
  let installKind: InstallKind | undefined = opts.installKind;
  if (!installKind) {
    try {
      installKind = resolveInstallKindCached();
    } catch {
      installKind = undefined;
    }
  }
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  return {
    version: resolveGatewayVersion(opts.env),
    uptimeMs: Math.max(0, Math.round((opts.uptimeSeconds ?? process.uptime()) * 1000)),
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
    ...(nodeVersion ? { nodeVersion } : {}),
    ...(installKind ? { installKind } : {}),
  };
}
