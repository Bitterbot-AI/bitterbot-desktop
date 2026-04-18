/**
 * Top-level P2P Identity doctor section.
 *
 * Bitterbot's orchestrator runs a libp2p Ed25519 keypair in `keyDir`.
 * That keypair IS the node identity — for edge nodes it's how peers
 * recognise you on the mesh; for management nodes it's also the signing
 * key used for census, anomaly detection, and management IPC auth.
 *
 * What we check:
 *   1. Node tier is valid (edge | management)
 *   2. Key directory exists (node.key / node.pub will be generated on
 *      first orchestrator start if absent; we only warn if the dir itself
 *      is unwritable)
 *   3. Management nodes additionally need a genesis trust list — either
 *      an inline `p2p.genesisTrustList` array or a file at
 *      `p2p.genesisTrustListPath`. Without one, the orchestrator refuses
 *      to start in management mode.
 *
 * What we deliberately don't check:
 *   - Keypair content / validity (the orchestrator loads or regenerates
 *     on startup; if the files are corrupt it fails fast with a clear
 *     error we don't need to duplicate)
 *   - Live peer reachability (that's doctor-p2p.ts)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

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

const DEFAULT_KEY_DIR = path.join(os.homedir(), ".bitterbot", "keys");
const DEFAULT_GENESIS_TRUST_FILE = path.join(os.homedir(), ".bitterbot", "genesis-trust.txt");

export function runIdentityChecks(params: { config: BitterbotConfig }): void {
  const { config } = params;
  const p2p = config.p2p;
  const results: CheckResult[] = [];

  if (p2p?.enabled === false) {
    results.push(info("P2P disabled — no mesh identity required."));
    renderSection(results);
    return;
  }

  // ── Node tier ──
  const tier = p2p?.nodeTier ?? "edge";
  if (tier !== "edge" && tier !== "management") {
    results.push(error(`Unknown p2p.nodeTier "${String(tier)}" (expected "edge" or "management")`));
    renderSection(results);
    return;
  }
  results.push(
    tier === "management"
      ? ok("Node tier: management (census + anomaly detection + signing)")
      : ok("Node tier: edge"),
  );

  // ── Key directory ──
  const keyDirRaw = p2p?.keyDir?.trim() || DEFAULT_KEY_DIR;
  const keyDir = resolveUserPath(keyDirRaw);
  const privPath = path.join(keyDir, "node.key");
  const pubPath = path.join(keyDir, "node.pub");

  try {
    if (fs.existsSync(keyDir)) {
      const stat = fs.statSync(keyDir);
      if (!stat.isDirectory()) {
        results.push(error(`keyDir ${keyDir} exists but is not a directory`));
      } else {
        try {
          fs.accessSync(keyDir, fs.constants.W_OK);
          const privExists = fs.existsSync(privPath);
          const pubExists = fs.existsSync(pubPath);
          if (privExists && pubExists) {
            results.push(ok(`Identity keypair present in ${keyDir}`));
          } else if (privExists || pubExists) {
            results.push(
              warn(
                `Identity keypair is partial (${privExists ? "node.key" : "node.pub"} missing). ` +
                  `Orchestrator will regenerate on next start.`,
              ),
            );
          } else {
            results.push(
              info(
                `Identity keypair not yet generated in ${keyDir} — orchestrator will create it on first start.`,
              ),
            );
          }
        } catch {
          results.push(error(`keyDir ${keyDir} exists but is not writable`));
        }
      }
    } else {
      results.push(
        info(
          `keyDir ${keyDir} doesn't exist yet — orchestrator will create it and generate a keypair on first start.`,
        ),
      );
    }
  } catch (err) {
    results.push(
      warn(`keyDir ${keyDir} check failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // ── Management tier: genesis trust list ──
  if (tier === "management") {
    const inline = p2p?.genesisTrustList ?? [];
    const trustPathRaw = p2p?.genesisTrustListPath?.trim() || DEFAULT_GENESIS_TRUST_FILE;
    const trustPath = resolveUserPath(trustPathRaw);

    let hasTrust = false;
    if (inline.length > 0) {
      results.push(ok(`Genesis trust list: ${inline.length} inline entries`));
      hasTrust = true;
    }
    if (fs.existsSync(trustPath)) {
      try {
        const body = fs.readFileSync(trustPath, "utf8");
        const count = body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#")).length;
        if (count > 0) {
          results.push(ok(`Genesis trust list: ${count} entries in ${trustPath}`));
          hasTrust = true;
        } else {
          results.push(warn(`Genesis trust list ${trustPath} exists but is empty`));
        }
      } catch (err) {
        results.push(
          warn(
            `Could not read genesis trust list ${trustPath}: ` +
              (err instanceof Error ? err.message : String(err)),
          ),
        );
      }
    }
    if (!hasTrust) {
      results.push(
        error(
          [
            "Management tier requires a genesis trust list.",
            `  Expected at: ${trustPath}`,
            `  Or inline via: ${formatCliCommand("bitterbot config set p2p.genesisTrustList '[\"<pubkey>\"]'")}`,
            "  Orchestrator will refuse to start in management mode without one.",
          ].join("\n"),
        ),
      );
    }
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Identity (P2P node)");
}
