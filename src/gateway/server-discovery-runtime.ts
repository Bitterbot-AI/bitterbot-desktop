import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { resolveWideAreaDiscoveryDomain, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

export async function startGatewayDiscovery(params: {
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  canvasPort?: number;
  wideAreaDiscoveryEnabled: boolean;
  wideAreaDiscoveryDomain?: string | null;
  tailscaleMode: "off" | "serve" | "funnel";
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const tailscaleEnabled = params.tailscaleMode !== "off";
  const tailnetDns = params.wideAreaDiscoveryEnabled
    ? await resolveTailnetDnsHint({ enabled: tailscaleEnabled })
    : undefined;
  const sshPortEnv = process.env.BITTERBOT_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
  const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : undefined;

  if (params.wideAreaDiscoveryEnabled) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: params.wideAreaDiscoveryDomain ?? undefined,
    });
    if (!wideAreaDomain) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no domain was configured; set discovery.wideArea.domain to enable unicast DNS-SD",
      );
      return;
    }
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaGatewayZone({
          domain: wideAreaDomain,
          gatewayPort: params.port,
          displayName: formatBonjourInstanceName(params.machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          tailnetDns,
          sshPort,
          cliPath: resolveBonjourCliPath(),
        });
        params.logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${wideAreaDomain} → ${result.zonePath})`,
        );
      } catch (err) {
        params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }
}
