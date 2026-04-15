/**
 * Top-level Wallet doctor section.
 *
 * Verifies the agent's USDC wallet is reachable and configured. The actual
 * balance / on-chain calls happen via the wallet service at runtime; this
 * doctor section is config + reachability only — never spends gas, never
 * touches the seed, never opens an outbound RPC.
 *
 * What we check:
 *   1. Wallet config block exists and `tools.wallet.enabled !== false`
 *   2. Network is one we recognize (base / base-sepolia)
 *   3. Spend caps are sane (positive, per-tx ≤ daily ≤ session)
 *   4. Wallet store directory is writable
 *   5. CDP keys present (config or env vars) — required for actual signing
 *   6. x402 + Stripe sub-block sanity (if enabled)
 *
 * What we deliberately don't check:
 *   - Live RPC connectivity to Base (would surface noisy network failures
 *     during dev; runtime checks handle this)
 *   - On-chain balance (would require RPC + risk metrics)
 *   - Seed file integrity (filesystem and lockfile already enforce this)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const KNOWN_NETWORKS = new Set(["base", "base-sepolia"]);
const DEFAULT_WALLET_STORE = path.join(os.homedir(), ".bitterbot", "wallet");

export async function runWalletChecks(params: { config: BitterbotConfig }): Promise<void> {
  const { config } = params;
  const wallet = config.tools?.wallet;
  const results: CheckResult[] = [];

  // ── Enabled? ──
  if (!wallet || wallet.enabled === false) {
    results.push(
      info(
        "Wallet is disabled (tools.wallet.enabled = false). Agent can publish " +
          "skills but cannot earn or pay for paywalled APIs.",
      ),
    );
    renderSection(results);
    return;
  }
  results.push(ok("Wallet is enabled"));

  // ── Network ──
  const network = wallet.network ?? "base-sepolia";
  if (!KNOWN_NETWORKS.has(network)) {
    results.push(error(`Unknown network: ${network} (expected base or base-sepolia)`));
  } else if (network === "base-sepolia") {
    results.push(info(`Network: ${network} (testnet — switch to 'base' for mainnet earnings)`));
  } else {
    results.push(ok(`Network: ${network} (mainnet)`));
  }

  // ── Spend caps ──
  const perTx = wallet.perTransactionCapUsd;
  const daily = wallet.dailySpendLimitUsd;
  const session = wallet.sessionSpendCapUsd;

  if (perTx !== undefined && perTx <= 0) {
    results.push(error(`Per-transaction cap must be positive (got ${perTx})`));
  } else if (daily !== undefined && daily <= 0) {
    results.push(error(`Daily spend limit must be positive (got ${daily})`));
  } else if (session !== undefined && session <= 0) {
    results.push(error(`Session spend cap must be positive (got ${session})`));
  } else if (perTx !== undefined && daily !== undefined && perTx > daily) {
    results.push(
      warn(
        `Per-tx cap ($${perTx}) exceeds daily limit ($${daily}) — single tx could blow the daily budget`,
      ),
    );
  } else {
    results.push(
      ok(`Spend caps: $${perTx ?? 25}/tx · $${daily ?? 50}/day · $${session ?? 50}/session`),
    );
  }

  // ── Wallet store directory ──
  const storePath = wallet.walletStorePath ?? DEFAULT_WALLET_STORE;
  try {
    fs.mkdirSync(storePath, { recursive: true });
    fs.accessSync(storePath, fs.constants.W_OK);
    results.push(ok(`Wallet store: ${storePath} (writable)`));
  } catch (err) {
    results.push(
      error(
        `Wallet store ${storePath} not writable: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  // ── CDP credentials (config or env) ──
  const cdpKeyId = wallet.cdpApiKeyId || process.env.CDP_API_KEY_ID;
  const cdpKeySecret = wallet.cdpApiKeySecret || process.env.CDP_API_KEY_SECRET;
  if (cdpKeyId && cdpKeySecret) {
    results.push(ok("CDP credentials present (signing will work)"));
  } else if (cdpKeyId || cdpKeySecret) {
    results.push(
      warn(
        "CDP credentials partially configured — both CDP_API_KEY_ID and CDP_API_KEY_SECRET required for signing",
      ),
    );
  } else {
    results.push(
      warn(
        "CDP credentials missing — set CDP_API_KEY_ID + CDP_API_KEY_SECRET (or tools.wallet.cdpApiKeyId/Secret) to enable signing",
      ),
    );
  }

  // ── x402 sub-config ──
  if (wallet.x402?.enabled) {
    const maxCost = wallet.x402.maxCostPerRequestUsd ?? 1;
    if (maxCost <= 0) {
      results.push(error(`x402 maxCostPerRequestUsd must be positive (got ${maxCost})`));
    } else if (perTx !== undefined && maxCost > perTx) {
      results.push(
        warn(
          `x402 max-per-request ($${maxCost}) exceeds per-tx cap ($${perTx}) — x402 calls will be capped at $${perTx}`,
        ),
      );
    } else {
      results.push(ok(`x402 enabled, max $${maxCost} per request`));
    }
  } else {
    results.push(info("x402 disabled — agent will see 402 responses on paywalled APIs"));
  }

  // ── Stripe onramp sub-config ──
  if (wallet.stripe?.enabled) {
    const stripeSecret = wallet.stripe.secretKey || process.env.STRIPE_SECRET_KEY;
    const stripePub = wallet.stripe.publishableKey || process.env.STRIPE_PUBLISHABLE_KEY;
    if (stripeSecret && stripePub) {
      results.push(ok("Stripe onramp enabled (Tier 2: local keys)"));
    } else if (wallet.onrampUrl) {
      results.push(ok(`Stripe onramp enabled (Tier 3: custom URL ${wallet.onrampUrl})`));
    } else {
      results.push(info("Stripe onramp enabled (Tier 1: hosted onramp.bitterbot.ai)"));
    }
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Wallet (USDC on Base)");
}
