import type { GatewayHelloOk } from "../../lib/gateway-client";
import type { GatewayRuntimeInfo, StatusSummary } from "../../stores/overview-store";

/**
 * The Overview stat cards, from what the gateway actually reports: the
 * `runtime` block of the `status` RPC (fresh on every refresh), else the
 * `runtime` block of the hello snapshot (as of connect), else the hello
 * `server.version`. Any field nobody reported stays a dash.
 */
export type OverviewStats = {
  version: string;
  /** Uptime in seconds, or null when unknown. */
  uptimeSeconds: number | null;
  platform: string;
  /** Install kind label under the platform card, when known. */
  platformSub?: string;
  configPath?: string;
  stateDir?: string;
};

const PLATFORM_NAMES: Record<string, string> = {
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
  freebsd: "FreeBSD",
};

const INSTALL_KIND_LABELS: Record<string, string> = {
  git: "source checkout",
  package: "package install",
  container: "container image",
  tarball: "installer (release tarball)",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function formatPlatform(platform?: string, arch?: string): string {
  if (!platform) {
    return "—";
  }
  const name = PLATFORM_NAMES[platform] ?? platform;
  return arch ? `${name} ${arch}` : name;
}

export function resolveOverviewStats(
  status: StatusSummary | null | undefined,
  hello: GatewayHelloOk | null | undefined,
): OverviewStats {
  const snapshot = asRecord(hello?.snapshot);
  const helloRuntime = asRecord(snapshot?.runtime) as GatewayRuntimeInfo | undefined;
  const runtime: GatewayRuntimeInfo | undefined = status?.runtime ?? helloRuntime;
  const server = asRecord(hello?.server);

  const version =
    nonEmpty(runtime?.version) ?? nonEmpty(server?.version) ?? nonEmpty(hello?.version) ?? "—";
  const runtimeUptime = runtime?.uptimeMs;
  const snapshotUptime = snapshot?.uptimeMs;
  const uptimeMs =
    typeof runtimeUptime === "number"
      ? runtimeUptime
      : typeof snapshotUptime === "number"
        ? snapshotUptime
        : null;
  const kind = runtime?.installKind;
  return {
    version,
    uptimeSeconds: uptimeMs === null ? null : Math.floor(uptimeMs / 1000),
    platform: formatPlatform(nonEmpty(runtime?.platform), nonEmpty(runtime?.arch)),
    platformSub: kind ? INSTALL_KIND_LABELS[kind] : undefined,
    configPath: nonEmpty(status?.configPath) ?? nonEmpty(snapshot?.configPath),
    stateDir: nonEmpty(status?.stateDir) ?? nonEmpty(snapshot?.stateDir),
  };
}
