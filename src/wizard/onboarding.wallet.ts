/**
 * Onboarding wizard step: USDC wallet on Base.
 *
 * The wallet is what makes Bitterbot's economic layer real — without it, the
 * agent can publish skills but can't earn from them, and can't pay for the
 * paywalled APIs it discovers via x402. This step:
 *
 *   1. Tells the operator what the wallet does (and what it does not)
 *   2. Confirms whether to enable it now or defer
 *   3. Defaults to base-sepolia (testnet) for safety — switching to base
 *      mainnet is a deliberate later choice via `bitterbot configure`
 *   4. Sets sane spend caps so an autonomous agent can't drain the wallet
 *      to zero on a single bad call
 *
 * The actual seed/keypair generation is lazy — handled by createWalletService
 * on first use. This step is purely about consent, expectations, and config.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

const DEFAULT_PER_TX_CAP_USD = 25;
const DEFAULT_DAILY_CAP_USD = 50;
const DEFAULT_SESSION_CAP_USD = 50;

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

  // ── 3. Spend caps (advanced only) ──
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

  // ── 4. Apply config ──
  const network = config.tools?.wallet?.network ?? "base-sepolia";
  const nextConfig: BitterbotConfig = {
    ...config,
    tools: {
      ...config.tools,
      wallet: {
        ...config.tools?.wallet,
        enabled: true,
        network,
        perTransactionCapUsd: perTxCap,
        dailySpendLimitUsd: dailyCap,
        sessionSpendCapUsd: sessionCap,
      },
    },
  };

  await prompter.note(
    [
      `Wallet enabled on ${network}.`,
      "",
      "  Per-tx cap:  $" + String(perTxCap),
      "  Daily cap:   $" + String(dailyCap),
      "  Session cap: $" + String(sessionCap),
      "",
      "Next steps after onboarding:",
      "  bitterbot wallet status        # show address + balance",
      "  bitterbot wallet fund          # open onramp / show funding URL",
      "  bitterbot wallet history       # see recent transactions",
      "",
      network === "base-sepolia"
        ? "On testnet — fund with Base Sepolia USDC from any faucet to start."
        : "MAINNET — start with a small float you can afford to lose while you watch the agent's behavior.",
    ].join("\n"),
    "Wallet ready",
  );

  return nextConfig;
}
