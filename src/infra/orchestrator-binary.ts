/**
 * Shared helpers for locating the orchestrator binary and probing P2P
 * reachability. Consumed by:
 *
 *  - src/infra/orchestrator-bridge.ts (resolveBinary delegates here)
 *  - src/commands/doctor-p2p.ts (reports all candidate paths)
 *  - src/wizard/onboarding.p2p.ts (shows the operator what was found)
 *
 * Keeping the logic in one place prevents the bridge's private
 * resolution from drifting away from the doctor/wizard view of the
 * world — if a new install path is added in the future, it lands here
 * once and everyone picks it up.
 */

import fs from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { P2pConfig } from "../config/types.p2p.js";

/** Where a binary was found, if any. Ordered by priority. */
export type BinarySource = "config" | "release" | "debug" | "prebuilt";

export type BinaryCandidate = {
  source: BinarySource;
  path: string;
  exists: boolean;
};

export type OrchestratorBinaryProbe =
  | {
      found: true;
      /** Priority-winning candidate. */
      source: BinarySource;
      path: string;
      /** All candidates in priority order, with exists flags. */
      candidates: BinaryCandidate[];
    }
  | {
      found: false;
      candidates: BinaryCandidate[];
    };

const exeName = (): string =>
  process.platform === "win32" ? "bitterbot-orchestrator.exe" : "bitterbot-orchestrator";

/**
 * Enumerate every candidate binary path in priority order, regardless
 * of which one wins. Callers that want the winner call
 * probeOrchestratorBinary(); callers that want to render a full
 * diagnostic table use this.
 */
export function listOrchestratorBinaryCandidates(cfg: P2pConfig | undefined): BinaryCandidate[] {
  const bin = exeName();
  const cargoBase = path.resolve(process.cwd(), "orchestrator", "target");
  const candidates: BinaryCandidate[] = [];
  if (cfg?.orchestratorBinary) {
    candidates.push({
      source: "config",
      path: cfg.orchestratorBinary,
      exists: existsFile(cfg.orchestratorBinary),
    });
  }
  const releasePath = path.join(cargoBase, "release", bin);
  candidates.push({ source: "release", path: releasePath, exists: existsFile(releasePath) });
  const debugPath = path.join(cargoBase, "debug", bin);
  candidates.push({ source: "debug", path: debugPath, exists: existsFile(debugPath) });
  const prebuiltPath = path.join(os.homedir(), ".bitterbot", "bin", bin);
  candidates.push({ source: "prebuilt", path: prebuiltPath, exists: existsFile(prebuiltPath) });
  return candidates;
}

/**
 * Resolve the orchestrator binary using the priority order:
 *   1. Explicit config override (p2p.orchestratorBinary)
 *   2. Local cargo release build  (dev iteration wins over prebuilt)
 *   3. Local cargo debug build    (noted with a warning)
 *   4. Postinstall-downloaded prebuilt at ~/.bitterbot/bin/
 *
 * Returns a structured result so callers can render diagnostics, not
 * just get "the path or a throw." Bridge wraps this to preserve the
 * throw contract.
 */
export function probeOrchestratorBinary(cfg: P2pConfig | undefined): OrchestratorBinaryProbe {
  const candidates = listOrchestratorBinaryCandidates(cfg);
  const winner = candidates.find((c) => c.exists);
  if (winner) {
    return { found: true, source: winner.source, path: winner.path, candidates };
  }
  return { found: false, candidates };
}

/**
 * Format the "binary not found" remediation message shown to operators.
 * Lives here so the wording stays consistent across the bridge thrown
 * error, the doctor output, and the wizard warning.
 */
export function formatBinaryNotFoundMessage(candidates: BinaryCandidate[]): string {
  const lines = [
    "Orchestrator binary not found. Looked in:",
    ...candidates.map((c) => `  ${c.path}  (${c.source})`),
    "",
    "Fix options:",
    "  - Build locally:   cargo build --release --manifest-path orchestrator/Cargo.toml",
    "  - Download prebuilt: reinstall with `pnpm install` to run the postinstall fetcher",
    "  - Explicit override: set p2p.orchestratorBinary in your gateway config",
  ];
  return lines.join("\n");
}

function existsFile(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── TCP reachability probe ──────────────────────────────────────────

export type TcpProbeResult = {
  host: string;
  port: number;
  reachable: boolean;
  /** Round-trip time in ms when reachable, otherwise null. */
  rttMs: number | null;
  error?: string;
};

/**
 * Cheap raw TCP connectability probe. Does NOT speak libp2p — just
 * verifies the port is open and the handshake succeeds. Used by
 * doctor and the wizard to give a fast "can this peer even be
 * reached?" signal without spinning up an orchestrator instance.
 */
export function probeTcpReachable(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const socket = createConnection({ host, port, family: 0 });
    const done = (res: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      done({ host, port, reachable: false, rttMs: null, error: "timeout" });
    }, timeoutMs);
    socket.once("connect", () => {
      done({ host, port, reachable: true, rttMs: Date.now() - start });
    });
    socket.once("error", (err) => {
      done({ host, port, reachable: false, rttMs: null, error: err.message });
    });
  });
}

// ── Multiaddr parsing (minimal) ─────────────────────────────────────

export type ParsedMultiaddr = {
  host: string;
  /** "ip4" | "ip6" | "dns4" | "dns6" | "dns" */
  hostProto: string;
  port: number;
  peerId: string | null;
};

/**
 * Extract host + port + peer-id from the subset of multiaddrs we
 * actually use: /{ip4,ip6,dns4,dns6,dns}/<host>/tcp/<port>[/p2p/<id>].
 * Returns null if the format doesn't match — caller decides whether
 * that's a warning or an error.
 */
export function parseMultiaddr(ma: string): ParsedMultiaddr | null {
  const hostMatch = ma.match(/^\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)\/tcp\/(\d+)/);
  if (!hostMatch) return null;
  const hostProto = hostMatch[1];
  const host = hostMatch[2];
  const port = Number.parseInt(hostMatch[3], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const peerMatch = ma.match(/\/p2p\/([^/]+)/);
  return { host, hostProto, port, peerId: peerMatch ? peerMatch[1] : null };
}
