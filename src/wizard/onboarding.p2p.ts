/**
 * Onboarding wizard step: P2P network setup.
 *
 * Inserted after the gateway config step (so the gateway token is
 * available for `desktop/.env` generation) and before channel setup.
 * P2P is on by default via applyP2pDefaults; this step exists to:
 *
 *   1. Tell the user what it means without being preachy
 *   2. Offer an opt-out in advanced mode only (quickstart keeps the
 *      default-on behavior)
 *   3. Probe orchestrator binary availability and surface the same
 *      4-path priority that OrchestratorBridge.resolveBinary uses
 *   4. Run a DNS bootstrap sanity check (advanced only — quick, ~1s)
 *   5. TCP-probe the first hardcoded fallback peer to catch firewall
 *      / egress issues before the user hits them at runtime
 *   6. Auto-generate `desktop/.env` with the gateway token so the
 *      Control UI connects on first `pnpm dev` without a copy-paste
 *      dance. This is the Tier 1 Control UI paper-cut fix, bundled
 *      here because it needs the same gateway token that just got
 *      minted.
 *
 * Deliberately NO node-tier prompt. All new nodes are edge tier.
 * Management tier is assigned manually by the network operator via
 * `p2p.nodeTier` + genesis trust list — never via this wizard.
 */

import fs from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { DEFAULT_GATEWAY_PORT, resolveGatewayPort } from "../config/config.js";
import { resolveBootstrapDns } from "../infra/dns-bootstrap.js";
import {
  parseMultiaddr,
  probeOrchestratorBinary,
  probeTcpReachable,
} from "../infra/orchestrator-binary.js";

export async function setupP2pForOnboarding(params: {
  config: BitterbotConfig;
  flow: WizardFlow;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<BitterbotConfig> {
  const { config, flow, settings, prompter } = params;

  // ── 1. Intro ──
  await prompter.note(
    [
      "Bitterbot participates in a peer-to-peer skills marketplace.",
      "Your agent discovers other agents via DNS, exchanges signed skill envelopes",
      "over libp2p, and can earn from skills it publishes. This is on by default.",
      "",
      flow === "advanced"
        ? "If you want local-only operation, you can disable it in the next step."
        : "If you want to disable it later, set `p2p.enabled = false` in your gateway config.",
    ].join("\n"),
    "P2P Network",
  );

  // ── 2. Opt-out (advanced only) ──
  let nextConfig = config;
  if (flow === "advanced") {
    const joinNetwork = await prompter.confirm({
      message: "Join the P2P skills marketplace?",
      initialValue: config.p2p?.enabled !== false,
    });
    if (!joinNetwork) {
      nextConfig = {
        ...config,
        p2p: { ...(config.p2p ?? {}), enabled: false },
      };
      await prompter.note(
        "P2P disabled. Your agent will run local-only. Re-enable later via `p2p.enabled = true` in the gateway config.",
        "P2P disabled",
      );
      // When disabled we still generate desktop/.env for the Control UI
      // because that's unrelated to P2P.
      await maybeGenerateDesktopEnv({
        settings,
        gatewayPort: resolveGatewayPort(nextConfig),
        prompter,
      });
      return nextConfig;
    }
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

  // ── 5. Fallback peer TCP probe ──
  // applyP2pDefaults merges the hardcoded Railway fallback into
  // bootstrapPeers, so config.p2p?.bootstrapPeers is authoritative
  // once the config has been defaulted.
  const peers = config.p2p?.bootstrapPeers ?? [];
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

  // ── 6. Auto-generate desktop/.env for the Control UI ──
  await maybeGenerateDesktopEnv({
    settings,
    gatewayPort: resolveGatewayPort(nextConfig),
    prompter,
  });

  return nextConfig;
}

/**
 * Write `desktop/.env` with the gateway token and URL so the Vite
 * Control UI can connect on `pnpm dev` without a manual copy-paste.
 * Only runs in the monorepo layout — if `desktop/` isn't present
 * (e.g. installed from npm as a library), this is a no-op.
 *
 * Respects any existing `desktop/.env` — if the user already has one,
 * we leave it alone and just note it to avoid clobbering a hand-edited
 * config.
 */
async function maybeGenerateDesktopEnv(params: {
  settings: GatewayWizardSettings;
  gatewayPort: number;
  prompter: WizardPrompter;
}): Promise<void> {
  const { settings, gatewayPort, prompter } = params;

  // Only do this in the monorepo layout (source clone). For library
  // installs via npm there is no `desktop/` directory to populate.
  const desktopDir = path.resolve(process.cwd(), "desktop");
  if (!fs.existsSync(desktopDir)) {
    return;
  }

  const envPath = path.join(desktopDir, ".env");
  if (fs.existsSync(envPath)) {
    // Don't clobber — the user (or a prior wizard run) may have
    // customized this file. Surface a hint instead.
    await prompter.note(
      [
        `${envPath} already exists — leaving it alone.`,
        "If the Control UI fails to connect, verify VITE_GATEWAY_TOKEN matches",
        "your current gateway auth token.",
      ].join("\n"),
      "Control UI env",
    );
    return;
  }

  const token = settings.gatewayToken;
  const gatewayHost =
    settings.bind === "loopback" || settings.bind === "auto"
      ? "127.0.0.1"
      : (settings.customBindHost ?? "127.0.0.1");
  const port = gatewayPort || DEFAULT_GATEWAY_PORT;

  const lines = [
    "# Auto-generated by the Bitterbot onboarding wizard.",
    "# Remove or edit this file to change the Control UI gateway target.",
    `VITE_GATEWAY_URL=ws://${gatewayHost}:${port}`,
  ];
  if (token) {
    lines.push(`VITE_GATEWAY_TOKEN=${token}`);
  } else {
    lines.push("# VITE_GATEWAY_TOKEN not set: your gateway uses password auth or no auth.");
  }
  lines.push("");

  try {
    fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
    await prompter.note(
      [
        `Wrote ${envPath}`,
        token
          ? "The Control UI will now connect to your gateway without manual configuration."
          : "VITE_GATEWAY_TOKEN was not set (gateway uses password or no auth). Edit the file if needed.",
      ].join("\n"),
      "Control UI env",
    );
  } catch (err) {
    await prompter.note(
      `Could not write ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
      "Control UI env",
    );
  }
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
