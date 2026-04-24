/**
 * Onboarding wizard step: USDC wallet on Base.
 *
 * The wallet is what makes Bitterbot's economic layer real — without it, the
 * agent can publish skills but can't earn from them, and can't pay for the
 * paywalled APIs it discovers via x402. This step:
 *
 *   1. Tells the operator what the wallet does (and what it does not)
 *   2. Confirms whether to enable it now or defer
 *   3. Walks the operator through getting Coinbase Developer Platform (CDP)
 *      credentials — the API Key pair plus the separate Wallet Secret — and
 *      persists them (API key pair → config JSON, wallet secret → env file)
 *   4. Defaults to base-sepolia (testnet) for safety — switching to base
 *      mainnet is a deliberate later choice via `bitterbot configure`
 *   5. Sets sane spend caps so an autonomous agent can't drain the wallet
 *      to zero on a single bad call
 *
 * The actual smart-account provisioning is lazy — handled by the wallet
 * service on first wallet RPC. This step is about consent, credentials,
 * and config. If the operator already has CDP creds in env or config we
 * skip the credential prompts silently.
 */

import fs from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { openUrl } from "../commands/onboard-helpers.js";
import { resolveConfigDir } from "../utils.js";

const DEFAULT_PER_TX_CAP_USD = 25;
const DEFAULT_DAILY_CAP_USD = 50;
const DEFAULT_SESSION_CAP_USD = 50;

const CDP_PORTAL_URL = "https://portal.cdp.coinbase.com";
const CDP_API_KEYS_URL = "https://portal.cdp.coinbase.com/projects/api-keys";
const CDP_WALLET_SECRET_URL = "https://portal.cdp.coinbase.com/products/wallets";

// Newly-collected credentials. Fields are present only if the collector
// actually prompted for them this run — so the caller can persist fresh
// values without clobbering existing config/env. A null return from the
// collector means the operator picked "skip".
type CollectedCdpCreds = {
  apiKeyId?: string;
  apiKeySecret?: string;
  walletSecret?: string;
};

// Presence check. Loose intentionally — we don't validate format upstream
// because Coinbase reserves the right to change the exact shape; the wallet
// service will surface a clear error on first use if anything is malformed.
function detectExistingCdpCreds(config: BitterbotConfig): {
  hasApiKey: boolean;
  hasWalletSecret: boolean;
} {
  const cfgApiKeyId = config.tools?.wallet?.cdpApiKeyId?.trim();
  const cfgApiKeySecret = config.tools?.wallet?.cdpApiKeySecret?.trim();
  const envApiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const envApiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  const envWalletSecret = process.env.CDP_WALLET_SECRET?.trim();
  return {
    hasApiKey: Boolean((cfgApiKeyId || envApiKeyId) && (cfgApiKeySecret || envApiKeySecret)),
    hasWalletSecret: Boolean(envWalletSecret),
  };
}

// Append or replace CDP_WALLET_SECRET in ~/.bitterbot/.env. The gateway's
// dotenv loader reads that file on startup (src/infra/dotenv.ts), so writing
// here makes the secret available to every subsequent gateway run without
// needing the operator to export it manually. Other env files (repo .env,
// shell rc) are left untouched.
function persistWalletSecretToEnvFile(walletSecret: string): string {
  const configDir = resolveConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const envPath = path.join(configDir, ".env");

  let contents = "";
  if (fs.existsSync(envPath)) {
    contents = fs.readFileSync(envPath, "utf-8");
  }

  const line = `CDP_WALLET_SECRET=${walletSecret}`;
  const re = /^CDP_WALLET_SECRET=.*$/m;
  if (re.test(contents)) {
    contents = contents.replace(re, line);
  } else {
    if (contents.length > 0 && !contents.endsWith("\n")) {
      contents += "\n";
    }
    contents += `${line}\n`;
  }

  fs.writeFileSync(envPath, contents, { mode: 0o600 });
  // Best-effort: also populate the current process so later wizard steps
  // or an immediate gateway spawn see the value without a restart.
  process.env.CDP_WALLET_SECRET = walletSecret;
  return envPath;
}

async function collectCdpCredentials(params: {
  prompter: WizardPrompter;
  missingApiKey: boolean;
  missingWalletSecret: boolean;
}): Promise<CollectedCdpCreds | null> {
  const { prompter, missingApiKey, missingWalletSecret } = params;

  await prompter.note(
    [
      "Bitterbot's wallet is backed by Coinbase Developer Platform (CDP).",
      "You need two secrets from the CDP portal — both are free and take",
      "about 3 minutes to create if you don't have them already.",
      "",
      "  1. API Key (ID + Secret)  — lets the agent call the CDP API",
      "  2. Wallet Secret          — separate key that authorizes signing",
      "",
      `Portal: ${CDP_PORTAL_URL}`,
      "",
      "If you'd rather do this later, pick 'skip' below; the wallet will",
      "stay disabled until you run `bitterbot configure --section wallet`",
      "or add the env vars (CDP_API_KEY_ID, CDP_API_KEY_SECRET,",
      "CDP_WALLET_SECRET) and restart the gateway.",
    ].join("\n"),
    "Coinbase Developer Platform (CDP) setup",
  );

  const choice = await prompter.select<"walkthrough" | "manual" | "skip">({
    message: "How do you want to set up CDP credentials?",
    options: [
      {
        value: "walkthrough",
        label: "Walk me through it (open the portal, step by step)",
      },
      {
        value: "manual",
        label: "I already have keys — let me paste them",
      },
      {
        value: "skip",
        label: "Skip for now (wallet stays disabled until configured)",
      },
    ],
    initialValue: "walkthrough",
  });

  if (choice === "skip") {
    return null;
  }

  const result: CollectedCdpCreds = {};

  // ── API Key pair ──
  if (missingApiKey) {
    if (choice === "walkthrough") {
      await prompter.note(
        [
          "Step 1 of 2 — Create an API Key.",
          "",
          "  a. Sign in at portal.cdp.coinbase.com (create an account if",
          "     you don't have one — no KYC needed, just email).",
          "  b. If you don't have a Project yet, create one (any name).",
          "  c. Open API Keys → 'Create API key'.",
          "  d. Give it a name (e.g. 'bitterbot') and click Create.",
          "  e. Copy the API Key ID (UUID) and the Secret (long base64",
          "     string). You won't be able to view the Secret again after",
          "     you close the dialog — if you miss it, just create a new key.",
          "",
          `URL: ${CDP_API_KEYS_URL}`,
        ].join("\n"),
        "CDP API Key",
      );
      const opened = await openUrl(CDP_API_KEYS_URL);
      if (!opened) {
        await prompter.note(
          `Couldn't open a browser automatically. Please open ${CDP_API_KEYS_URL} yourself.`,
          "Open manually",
        );
      }
    }

    // Validation is loose: non-empty + minimal sanity (UUIDish for the
    // ID, 20+ chars for the secret). CDP may change the exact shape, so
    // we don't over-constrain — the wallet service surfaces any mismatch
    // on first use with a clear error.
    result.apiKeyId = (
      await prompter.text({
        message: "Paste your CDP API Key ID (looks like a UUID)",
        placeholder: "00000000-0000-0000-0000-000000000000",
        validate: (v) => {
          const t = v.trim();
          if (!t) return "API Key ID is required";
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
            return "Doesn't look like a UUID — double-check the ID from the portal";
          }
          return undefined;
        },
      })
    ).trim();

    result.apiKeySecret = (
      await prompter.text({
        message: "Paste your CDP API Key Secret",
        placeholder: "base64-encoded string",
        validate: (v) => {
          const t = v.trim();
          if (!t) return "API Key Secret is required";
          if (t.length < 20) return "Secret looks too short — paste the full value";
          return undefined;
        },
      })
    ).trim();
  }

  // ── Wallet Secret ──
  if (missingWalletSecret) {
    if (choice === "walkthrough") {
      await prompter.note(
        [
          "Step 2 of 2 — Create a Wallet Secret.",
          "",
          "This is SEPARATE from the API Key Secret above. It authorizes",
          "the agent to sign transactions on its smart wallet. Coinbase",
          "treats it as a second factor, so keep it safe.",
          "",
          "  a. In the CDP portal, go to Wallets → Wallet Secret.",
          "  b. Click 'Create Wallet Secret' (or 'Rotate' if one exists).",
          "  c. Copy the secret — again, you won't be able to view it after",
          "     the dialog closes.",
          "",
          `URL: ${CDP_WALLET_SECRET_URL}`,
        ].join("\n"),
        "CDP Wallet Secret",
      );
      const opened = await openUrl(CDP_WALLET_SECRET_URL);
      if (!opened) {
        await prompter.note(
          `Couldn't open a browser automatically. Please open ${CDP_WALLET_SECRET_URL} yourself.`,
          "Open manually",
        );
      }
    }

    result.walletSecret = (
      await prompter.text({
        message: "Paste your CDP Wallet Secret",
        placeholder: "long base64-encoded string",
        validate: (v) => {
          const t = v.trim();
          if (!t) return "Wallet Secret is required";
          if (t.length < 40) {
            return "Wallet Secret looks too short — paste the full value";
          }
          return undefined;
        },
      })
    ).trim();
  }

  return result;
}

export async function setupWalletForOnboarding(params: {
  config: BitterbotConfig;
  flow: WizardFlow;
  prompter: WizardPrompter;
}): Promise<BitterbotConfig> {
  const { config, flow, prompter } = params;

  // ── 1. Intro ──
  await prompter.note(
    [
      "Bitterbot can hold a USDC wallet on Base. With it, your agent can:",
      "",
      "  - earn USDC when other agents purchase skills it published",
      "  - pay paywalled APIs autonomously via x402 micropayments",
      "  - send and receive on-chain on Base (sponsored gas, no ETH needed)",
      "  - claim management-node bounties when it fulfils them",
      "",
      "Without it: skills can be published but won't earn, x402-walled",
      "APIs return 402 instead of content, and bounty payouts go nowhere.",
      "",
      "Spend caps below are enforced by the wallet service — every outbound",
      "transaction is checked against per-tx, daily, and per-session limits",
      "before signing. The agent can't override these from inside a session.",
      "",
      "Default network is base-sepolia (testnet) — switch to mainnet only",
      "after you've watched the agent transact for a while:",
      "  bitterbot configure --section wallet",
    ].join("\n"),
    "USDC Wallet (Base)",
  );

  // ── 2. Enable? ──
  const currentlyEnabled = config.tools?.wallet?.enabled !== false;
  const enableNow =
    flow === "quickstart"
      ? currentlyEnabled
      : await prompter.confirm({
          message:
            "Enable the wallet now? (testnet by default; you can fund it with a few USDC anytime)",
          initialValue: currentlyEnabled,
        });

  if (!enableNow) {
    await prompter.note(
      [
        "Wallet disabled. Your agent can still publish skills but can't",
        "earn or pay for paywalled resources. Enable later via:",
        "  bitterbot configure --section wallet",
      ].join("\n"),
      "Wallet disabled",
    );
    return {
      ...config,
      tools: {
        ...config.tools,
        wallet: {
          ...config.tools?.wallet,
          enabled: false,
        },
      },
    };
  }

  // ── 3. CDP credentials ──
  const { hasApiKey, hasWalletSecret } = detectExistingCdpCreds(config);
  let collected: CollectedCdpCreds | null = null;
  let credentialsSkipped = false;

  if (flow === "quickstart" && (hasApiKey || hasWalletSecret)) {
    // Quickstart only does credential setup if nothing is present. If
    // even one is present we assume the operator is resuming a partial
    // setup and don't surprise them with prompts.
    // No-op.
  } else if (hasApiKey && hasWalletSecret) {
    await prompter.note(
      [
        "CDP credentials already present (env or config) — reusing them.",
        "",
        "To rotate: delete CDP_* values from ~/.bitterbot/.env and/or clear",
        "wallet.cdpApiKeyId / wallet.cdpApiKeySecret in ~/.bitterbot/bitterbot.json,",
        "then re-run `bitterbot configure --section wallet`.",
      ].join("\n"),
      "CDP credentials detected",
    );
  } else {
    collected = await collectCdpCredentials({
      prompter,
      missingApiKey: !hasApiKey,
      missingWalletSecret: !hasWalletSecret,
    });
    credentialsSkipped = collected === null;
  }

  // ── 4. Spend caps (advanced only) ──
  const existingCaps = config.tools?.wallet ?? {};
  let perTxCap = existingCaps.perTransactionCapUsd ?? DEFAULT_PER_TX_CAP_USD;
  let dailyCap = existingCaps.dailySpendLimitUsd ?? DEFAULT_DAILY_CAP_USD;
  let sessionCap = existingCaps.sessionSpendCapUsd ?? DEFAULT_SESSION_CAP_USD;

  if (flow === "advanced") {
    const tweakCaps = await prompter.confirm({
      message: "Tune spend caps now? (defaults: $25 per-tx, $50 daily, $50 per-session)",
      initialValue: false,
    });

    if (tweakCaps) {
      const parsePositive = (value: string, fallback: number): number => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
      };

      const perTxRaw = await prompter.text({
        message: "Per-transaction cap (USD)",
        initialValue: String(perTxCap),
        validate: (v) => (Number(v) > 0 ? undefined : "Must be a positive number"),
      });
      perTxCap = parsePositive(String(perTxRaw ?? ""), perTxCap);

      const dailyRaw = await prompter.text({
        message: "Daily spend limit (USD, resets every 24h)",
        initialValue: String(dailyCap),
        validate: (v) => (Number(v) > 0 ? undefined : "Must be a positive number"),
      });
      dailyCap = parsePositive(String(dailyRaw ?? ""), dailyCap);

      const sessionRaw = await prompter.text({
        message: "Per-agent-session cap (USD)",
        initialValue: String(sessionCap),
        validate: (v) => (Number(v) > 0 ? undefined : "Must be a positive number"),
      });
      sessionCap = parsePositive(String(sessionRaw ?? ""), sessionCap);
    }
  }

  // ── 5. Apply config ──
  const network = config.tools?.wallet?.network ?? "base-sepolia";

  // Fold collected CDP creds into the config. API key pair persists in
  // bitterbot.json; the wallet secret is env-only and was already
  // written to ~/.bitterbot/.env + process.env inside the collection
  // helper.
  let envFilePath: string | null = null;
  const walletConfigBase = {
    ...config.tools?.wallet,
    enabled: true,
    network,
    perTransactionCapUsd: perTxCap,
    dailySpendLimitUsd: dailyCap,
    sessionSpendCapUsd: sessionCap,
  };
  if (collected) {
    // Only overwrite values the operator just typed in. If only one of
    // the pair/secret was missing, leave the other slot untouched so we
    // don't clobber what was already in config or env.
    if (collected.apiKeyId) walletConfigBase.cdpApiKeyId = collected.apiKeyId;
    if (collected.apiKeySecret) walletConfigBase.cdpApiKeySecret = collected.apiKeySecret;
    if (collected.walletSecret) {
      envFilePath = persistWalletSecretToEnvFile(collected.walletSecret);
    }
  }

  const nextConfig: BitterbotConfig = {
    ...config,
    tools: {
      ...config.tools,
      wallet: walletConfigBase,
    },
  };

  if (credentialsSkipped) {
    await prompter.note(
      [
        `Wallet enabled on ${network}, but CDP credentials were skipped.`,
        "",
        "  Per-tx cap:  $" + String(perTxCap),
        "  Daily cap:   $" + String(dailyCap),
        "  Session cap: $" + String(sessionCap),
        "",
        "Wallet RPCs (getAddress, getBalance, send, fund) will fail until",
        "credentials are set. When you're ready:",
        "",
        "  bitterbot configure --section wallet    # re-run this step",
        "",
        "Or set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in",
        "~/.bitterbot/.env and restart the gateway.",
      ].join("\n"),
      "Wallet enabled (credentials pending)",
    );
  } else {
    const funding =
      network === "base-sepolia"
        ? "On testnet — fund with Base Sepolia USDC from any faucet to start."
        : "MAINNET — start with a small float you can afford to lose while you watch the agent's behavior.";

    const credentialLines = envFilePath
      ? [
          "Credentials saved:",
          "  - API Key pair  → ~/.bitterbot/bitterbot.json (wallet.cdpApiKey*)",
          `  - Wallet Secret → ${envFilePath} (CDP_WALLET_SECRET)`,
          "",
        ]
      : ["Credentials: using values already in env/config.", ""];

    await prompter.note(
      [
        `Wallet enabled on ${network}.`,
        "",
        "  Per-tx cap:  $" + String(perTxCap),
        "  Daily cap:   $" + String(dailyCap),
        "  Session cap: $" + String(sessionCap),
        "",
        ...credentialLines,
        "Next steps after onboarding:",
        "  bitterbot wallet status        # show address + balance",
        "  bitterbot wallet fund          # open onramp / show funding URL",
        "  bitterbot wallet history       # see recent transactions",
        "",
        funding,
      ].join("\n"),
      "Wallet ready",
    );
  }

  return nextConfig;
}
