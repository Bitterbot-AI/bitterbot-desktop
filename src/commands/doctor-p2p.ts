/**
 * Top-level P2P network doctor section.
 *
 * Promoted from a subsection of the biological memory architecture
 * block to its own section because P2P is now core infrastructure
 * for the agent, not a memory subsystem. The old `checkP2POrchestrator`
 * in doctor-memory-system.ts has been removed and its responsibilities
 * split across:
 *
 *   - Binary availability → probeOrchestratorBinary (shared with bridge/wizard)
 *   - DNS bootstrap reachability → resolveBootstrapDns
 *   - Hardcoded fallback peer TCP probe → probeTcpReachable
 *   - Live orchestrator state → HTTP /api/stats when gateway is running
 */

import type { BitterbotConfig } from "../config/config.js";
import { resolveBootstrapDns } from "../infra/dns-bootstrap.js";
import {
  parseMultiaddr,
  probeOrchestratorBinary,
  probeTcpReachable,
  type BinarySource,
} from "../infra/orchestrator-binary.js";
import { note } from "../terminal/note.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const error = (message: string): CheckResult => ({ level: "error", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `\u2714 ${r.message}`;
    case "warn":
      return `\u26A0 ${r.message}`;
    case "error":
      return `\u2718 ${r.message}`;
    case "info":
      return `\u2139 ${r.message}`;
  }
}

/**
 * Describe a resolved binary source in operator-facing language.
 * Matches the vocabulary used by the orchestrator-binary probe.
 */
function describeSource(source: BinarySource): string {
  switch (source) {
    case "config":
      return "explicit config override";
    case "release":
      return "local cargo release build";
    case "debug":
      return "local cargo debug build";
    case "prebuilt":
      return "downloaded prebuilt (~/.bitterbot/bin)";
  }
}

/**
 * Query the orchestrator's HTTP dashboard for live peer state.
 * Only meaningful when a gateway is actively running somewhere on
 * this host — otherwise the port is closed and we fall through.
 */
async function queryLiveStats(
  httpAddr: string,
  timeoutMs = 2000,
): Promise<{
  peerId?: string;
  connectedPeers?: number;
  meshPeers?: number;
  subscribedTopics?: string[];
  error?: string;
}> {
  const url = `http://${httpAddr}/api/stats`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      peerId: typeof data.peer_id === "string" ? data.peer_id : undefined,
      connectedPeers: typeof data.connected_peers === "number" ? data.connected_peers : undefined,
      meshPeers: typeof data.mesh_peers_count === "number" ? data.mesh_peers_count : undefined,
      subscribedTopics: Array.isArray(data.subscribed_topics)
        ? (data.subscribed_topics.filter((t) => typeof t === "string") as string[])
        : undefined,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runP2pNetworkChecks(params: {
  config: BitterbotConfig;
  isGatewayRunning: boolean;
}): Promise<void> {
  const { config, isGatewayRunning } = params;
  const results: CheckResult[] = [];

  // ── Enabled check ──
  const p2pEnabled = config.p2p?.enabled !== false;
  if (!p2pEnabled) {
    results.push(info("P2P is disabled in config (p2p.enabled = false). Node runs local-only."));
    renderSection(results);
    return;
  }
  results.push(ok("P2P is enabled"));

  // ── Binary availability ──
  const probe = probeOrchestratorBinary(config.p2p);
  if (probe.found) {
    if (probe.source === "debug") {
      results.push(
        warn(
          `Orchestrator: ${describeSource(probe.source)} — run \`cargo build --release --manifest-path orchestrator/Cargo.toml\` for production`,
        ),
      );
    } else {
      results.push(ok(`Orchestrator: ${describeSource(probe.source)}`));
    }
  } else {
    results.push(
      error(
        "Orchestrator binary NOT FOUND — node cannot join the P2P network.\n" +
          `  Build locally:   cargo build --release --manifest-path orchestrator/Cargo.toml\n` +
          `  Or download:     reinstall with \`pnpm install\` to run the postinstall fetcher`,
      ),
    );
    // Still run the rest of the checks so the operator gets the full picture.
  }

  // ── DNS bootstrap resolution ──
  const dnsDomain = config.p2p?.bootstrapDns;
  if (dnsDomain) {
    try {
      const peers = await resolveBootstrapDns(dnsDomain);
      if (peers.length === 0) {
        results.push(
          warn(
            `DNS bootstrap: _dnsaddr.${dnsDomain} returned 0 peers (fallback peers will be used)`,
          ),
        );
      } else {
        results.push(
          ok(`DNS bootstrap: _dnsaddr.${dnsDomain} → ${peers.length} peer(s) discovered`),
        );
      }
    } catch (err) {
      results.push(
        warn(
          `DNS bootstrap: _dnsaddr.${dnsDomain} resolution failed (${err instanceof Error ? err.message : String(err)})`,
        ),
      );
    }
  } else {
    results.push(info("DNS bootstrap: no domain configured (p2p.bootstrapDns unset)"));
  }

  // ── Hardcoded fallback peer reachability ──
  const fallbackPeers = config.p2p?.bootstrapPeers ?? [];
  if (fallbackPeers.length === 0) {
    results.push(info("No hardcoded bootstrap peers configured"));
  } else {
    // Probe the first one as a representative sample — no need to hammer
    // every peer in the list during a doctor run.
    const firstPeer = fallbackPeers[0];
    const parsed = parseMultiaddr(firstPeer);
    if (!parsed) {
      results.push(warn(`Could not parse first bootstrap peer: ${firstPeer}`));
    } else {
      const probeResult = await probeTcpReachable(parsed.host, parsed.port, 3000);
      if (probeResult.reachable) {
        const rtt = probeResult.rttMs != null ? ` (${probeResult.rttMs}ms)` : "";
        results.push(ok(`Fallback peer ${parsed.host}:${parsed.port} reachable via TCP${rtt}`));
        if (fallbackPeers.length > 1) {
          results.push(
            info(
              `${fallbackPeers.length - 1} additional fallback peer(s) not probed (sampling first only)`,
            ),
          );
        }
      } else {
        results.push(
          warn(
            `Fallback peer ${parsed.host}:${parsed.port} unreachable via TCP (${probeResult.error ?? "unknown"})`,
          ),
        );
      }
    }
  }

  // ── Live orchestrator stats (only if gateway is running) ──
  if (isGatewayRunning) {
    const httpAddr = config.p2p?.httpAddr ?? "127.0.0.1:9847";
    const stats = await queryLiveStats(httpAddr);
    if (stats.error) {
      results.push(
        info(
          `Live orchestrator stats: ${httpAddr} unreachable (${stats.error}) — orchestrator may still be starting`,
        ),
      );
    } else {
      if (stats.peerId) {
        results.push(ok(`Local peer ID: ${stats.peerId}`));
      }
      if (typeof stats.connectedPeers === "number") {
        const label = stats.connectedPeers === 1 ? "peer" : "peers";
        const level: Level = stats.connectedPeers > 0 ? "ok" : "warn";
        results.push({
          level,
          message: `Connected to ${stats.connectedPeers} ${label}`,
        });
      }
      if (typeof stats.meshPeers === "number" && stats.meshPeers !== stats.connectedPeers) {
        results.push(info(`Gossipsub mesh peers: ${stats.meshPeers}`));
      }
      if (stats.subscribedTopics && stats.subscribedTopics.length > 0) {
        results.push(info(`Subscribed topics: ${stats.subscribedTopics.length}`));
      }
    }
  } else {
    results.push(info("Gateway not running — live orchestrator stats unavailable"));
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "P2P Network");
}
