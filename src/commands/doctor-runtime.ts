/**
 * Top-level Runtime doctor section.
 *
 * Everything else in this doctor assumes the runtime itself is viable.
 * This check runs first (logically, even if listed later) — it validates:
 *
 *   1. Node version meets the minimum (we depend on structuredClone,
 *      node:test, modern AbortSignal behaviour, and node --watch)
 *   2. pnpm is on PATH (monorepo dev workflow + `pnpm dev:all`)
 *   3. Platform-specific caveats:
 *        - Linux + public bind → recommend Tailscale / loopback
 *        - WSL2 → flag known symlink + filesystem-performance gotchas
 *
 * Doctor checks below this one may rely on features from newer Node
 * (e.g. dream-engine DB uses node:sqlite on 22+), so if runtime fails
 * here the user will see the cascade downstream too.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import type { BitterbotConfig } from "../config/config.js";
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

// Kept in sync with package.json#engines.node. Node 22 LTS is the floor
// because the dream-engine DB uses the stable node:sqlite that ships there,
// and several crypto / AbortController behaviours we rely on stabilised in
// 22.x. Downgrade = silent native-module failures.
const MIN_NODE_MAJOR = 22;

function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

function isWsl2(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const rel = os.release().toLowerCase();
    return rel.includes("microsoft") || rel.includes("wsl");
  } catch {
    return false;
  }
}

function whichPnpm(): { found: boolean; version?: string } {
  try {
    const result = spawnSync("pnpm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout?.trim()) {
      return { found: true, version: result.stdout.trim() };
    }
  } catch {
    // fall through
  }
  return { found: false };
}

export function runRuntimeChecks(params: { config: BitterbotConfig }): void {
  const { config } = params;
  const results: CheckResult[] = [];

  // ── Node version ──
  const major = parseNodeMajor(process.version);
  if (major === null) {
    results.push(warn(`Couldn't parse Node version "${process.version}"`));
  } else if (major < MIN_NODE_MAJOR) {
    results.push(
      error(
        `Node ${process.version} is below the supported floor (v${MIN_NODE_MAJOR} LTS). ` +
          `Dream engine, sqlite vector ops, and native modules may fail silently.`,
      ),
    );
  } else {
    results.push(ok(`Node ${process.version}`));
  }

  // ── pnpm ──
  const pnpm = whichPnpm();
  if (pnpm.found) {
    results.push(ok(`pnpm ${pnpm.version} on PATH`));
  } else {
    results.push(
      warn(
        "pnpm not found on PATH — `pnpm dev:all`, `pnpm start gateway`, and the " +
          "wizard's auto-spawn will fail. Install: `npm i -g pnpm`.",
      ),
    );
  }

  // ── Platform + bind posture ──
  const platform = process.platform;
  const bind = config.gateway?.bind ?? "loopback";
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";

  if (platform === "linux" && (bind === "lan" || bind === "auto" || bind === "custom")) {
    if (tailscaleMode === "off") {
      results.push(
        warn(
          `Linux + gateway bind=${bind} with Tailscale off. The gateway is reachable ` +
            "on your LAN without mesh-level auth. Run Tailscale or switch bind=loopback.",
        ),
      );
    } else {
      results.push(ok(`Linux + Tailscale ${tailscaleMode} (bind=${bind})`));
    }
  }

  // ── WSL2 caveats ──
  if (isWsl2()) {
    results.push(
      info(
        "Running under WSL2. Two things to know:\n" +
          "  - File I/O across /mnt/c is ~10× slower than native ext4 — keep the workspace under ~/ if possible.\n" +
          "  - Symlinks into /mnt/c can break skill ingestion. Use copies or keep skills on the Linux side.",
      ),
    );
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Runtime");
}
