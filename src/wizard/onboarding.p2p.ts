/**
 * Onboarding wizard step: P2P network setup.
 *
 * Inserted after the gateway config step and before channel setup.
 * P2P is on by default via applyP2pDefaults; this step exists to:
 *
 *   1. Tell the user what it means without being preachy
 *   2. Ask for network consent in EVERY flow (PLAN-41 Phase 1, p0-10):
 *      declining applies the Local-only preset — p2p, circles, a2a,
 *      update.checkOnStart and models.liveDiscovery all explicitly off,
 *      no new config key
 *   3. Probe orchestrator binary availability and surface the same
 *      4-path priority that OrchestratorBridge.resolveBinary uses
 *   4. Run a DNS bootstrap sanity check (advanced only — quick, ~1s)
 *   5. TCP-probe the first hardcoded fallback peer (advanced only)
 *
 * The old step 6 (auto-generate `desktop/.env` with the gateway token)
 * is GONE: nothing has read `VITE_GATEWAY_TOKEN` since PLAN-39 Phase 3
 * — the gateway serves the Control UI and hands the token over via
 * `/auth/session-token` — so writing the plaintext token to disk was a
 * pure secret leak (PLAN-41 Phase 1, p0-19 residual).
 *
 * Deliberately NO node-tier prompt. All new nodes are edge tier.
 * Management tier is assigned manually by the network operator via
 * `p2p.nodeTier` + genesis trust list — never via this wizard.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveBootstrapDns } from "../infra/dns-bootstrap.js";
import {
  parseMultiaddr,
  probeOrchestratorBinary,
  probeTcpReachable,
} from "../infra/orchestrator-binary.js";

export async function setupP2pForOnboarding(params: {
  config: BitterbotConfig;
  flow: WizardFlow;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<BitterbotConfig> {
  const { config, flow, prompter } = params;

  // ── 1. Intro ──
  await prompter.note(
    [
      "Bitterbot agents talk to each other on a live P2P mesh. Your node:",
      "",
      "  - publishes skills your agent crystallizes during dream cycles",
      "    (other agents can buy them with USDC via x402)",
      "  - ingests skills published by trusted peers (defaults to 'review'",
      "    mode — quarantined until you approve, never auto-installed)",
      "  - participates in EigenTrust reputation scoring so good actors",
      "    rise and bad actors get gossipsub-throttled",
      "  - receives weather + bounty broadcasts from management nodes",
      "",
      "Your node starts as an EDGE tier (read skills, publish skills, no",
      "broadcast authority). Management tier — issuing bans, bounties, and",
      "weather — is assigned manually by the network's existing operators",
      "via genesis trust list, never via this wizard.",
      "",
      "If you want fully local operation, decline next and everything",
      "network-facing switches off in one gesture.",
    ].join("\n"),
    "P2P Network",
  );

  // ── 2. Network consent (every flow — PLAN-41 Phase 1, p0-10) ──
  let nextConfig = config;
  const joinNetwork = await prompter.confirm({
    message: "Join the P2P network? (skills marketplace + circles; you can leave anytime)",
    initialValue: config.p2p?.enabled !== false,
  });
  if (!joinNetwork) {
    // Local-only preset: every ambient network surface off explicitly, so
    // the config file documents the choice and each flag can be flipped
    // back individually. Deliberately not a new config key.
    nextConfig = {
      ...config,
      p2p: { ...config.p2p, enabled: false },
      circles: { ...config.circles, enabled: false },
      a2a: { ...config.a2a, enabled: false },
      update: { ...config.update, checkOnStart: false },
      models: {
        ...config.models,
        liveDiscovery: { ...config.models?.liveDiscovery, enabled: false },
      },
    };
    await prompter.note(
      [
        "Local-only mode. Switched off: P2P mesh, circles, agent-to-agent",
        "HTTP, boot-time update check, live model discovery.",
        "Re-enable any of them later in Settings or the gateway config",
        "(p2p.enabled, circles.enabled, a2a.enabled, update.checkOnStart,",
        "models.liveDiscovery.enabled).",
      ].join("\n"),
      "Local-only",
    );
    return nextConfig;
  }

  // ── 3. Orchestrator binary probe ──
  const binary = probeOrchestratorBinary(config.p2p);
  if (binary.found) {
    const label =
      binary.source === "prebuilt"
        ? `downloaded prebuilt at ${binary.path}`
        : binary.source === "release"
          ? "local cargo release build"
          : binary.source === "debug"
            ? "local cargo debug build (release recommended for production)"
            : `explicit override: ${binary.path}`;
    await prompter.note(`Orchestrator binary: ${label}`, "Binary");
  } else {
    await prompter.note(
      [
        "The orchestrator binary was not found in any expected location.",
        "This is normal on fresh clones before `pnpm install` has run the postinstall",
        "downloader, or before a cargo build. The gateway will give you a clear error",
        "with remediation steps if you start it without a binary.",
        "",
        "Options:",
        "  - Wait for `pnpm install` postinstall to download the prebuilt (next install)",
        "  - Build locally:  cargo build --release --manifest-path orchestrator/Cargo.toml",
      ].join("\n"),
      "Orchestrator binary missing",
    );
  }

  // ── 4. DNS bootstrap probe (advanced only — keep quickstart snappy) ──
  if (flow === "advanced") {
    const dnsDomain = config.p2p?.bootstrapDns ?? "p2p.bitterbot.ai";
    try {
      const peers = await withTimeout(resolveBootstrapDns(dnsDomain), 5000);
      if (peers === null) {
        await prompter.note(
          `DNS bootstrap check timed out for _dnsaddr.${dnsDomain}. Fallback peers will be used.`,
          "DNS bootstrap",
        );
      } else if (peers.length === 0) {
        await prompter.note(
          `DNS bootstrap returned 0 peers from _dnsaddr.${dnsDomain}. Fallback peers will be used.`,
          "DNS bootstrap",
        );
      } else {
        await prompter.note(
          `DNS bootstrap: ${peers.length} peer(s) discovered from _dnsaddr.${dnsDomain}`,
          "DNS bootstrap",
        );
      }
    } catch (err) {
      await prompter.note(
        `DNS bootstrap check failed: ${err instanceof Error ? err.message : String(err)}. Fallback peers will be used.`,
        "DNS bootstrap",
      );
    }
  }

  // ── 5. Fallback peer TCP probe (advanced only — keep quickstart snappy) ──
  // applyP2pDefaults merges the hardcoded Railway fallback into
  // bootstrapPeers, so config.p2p?.bootstrapPeers is authoritative
  // once the config has been defaulted.
  const peers = flow === "advanced" ? (config.p2p?.bootstrapPeers ?? []) : [];
  if (peers.length > 0) {
    const first = peers[0];
    const parsed = parseMultiaddr(first);
    if (parsed) {
      const result = await probeTcpReachable(parsed.host, parsed.port, 3000);
      if (result.reachable) {
        const rtt = result.rttMs != null ? ` (${result.rttMs}ms)` : "";
        await prompter.note(
          `Fallback peer ${parsed.host}:${parsed.port} reachable via TCP${rtt}`,
          "Network reachability",
        );
      } else {
        await prompter.note(
          [
            `Fallback peer ${parsed.host}:${parsed.port} unreachable via TCP (${result.error ?? "unknown"}).`,
            "Your network may block outbound TCP to that port, or the peer is down.",
            "The orchestrator will still try DNS-discovered peers at runtime.",
          ].join("\n"),
          "Network reachability",
        );
      }
    }
  }

  return nextConfig;
}

/** Small helper so we can time-box DNS probes and stay responsive. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      },
    );
  });
}
