import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { createWalletService, type WalletService } from "../../services/wallet-service.js";
import { createOnrampSession } from "../../services/stripe-onramp.js";
import {
  createHostedOnrampSession,
  DEFAULT_ONRAMP_URL,
} from "../../services/hosted-onramp.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

let cachedService: WalletService | null = null;

function getWalletService(): WalletService {
  if (!cachedService) {
    const config = loadConfig();
    const walletConfig = config.tools?.wallet;
    if (walletConfig?.enabled === false) {
      throw new Error("Wallet is disabled in configuration");
    }
    cachedService = createWalletService(walletConfig ?? {});
  }
  return cachedService;
}

export const walletHandlers: GatewayRequestHandlers = {
  "wallet.getAddress": async ({ respond }) => {
    try {
      const svc = getWalletService();
      const address = await svc.getAddress();
      respond(true, { address, network: svc.getNetwork() });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.getBalance": async ({ params, respond }) => {
    try {
      const svc = getWalletService();
      const token = typeof params.token === "string" ? params.token.trim() : undefined;
      const result = await svc.getBalance(token);
      respond(true, result);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.getHistory": async ({ params, respond }) => {
    try {
      const svc = getWalletService();
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 10;
      const transactions = await svc.getTransactionHistory(limit);
      respond(true, { transactions, count: transactions.length });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.getConfig": async ({ respond }) => {
    try {
      const config = loadConfig();
      const walletConfig = config.tools?.wallet;

      // Determine which onramp tier is active
      const hasLocalKeys = !!(
        (walletConfig?.stripe?.secretKey || process.env.STRIPE_SECRET_KEY) &&
        (walletConfig?.stripe?.publishableKey || process.env.STRIPE_PUBLISHABLE_KEY)
      );
      const onrampUrl =
        walletConfig?.onrampUrl ?? process.env.BITTERBOT_ONRAMP_URL ?? "";
      const hasCustomOnramp = !!onrampUrl;

      let onrampTier: "local" | "custom" | "hosted" | "none";
      if (hasLocalKeys) {
        onrampTier = "local";
      } else if (hasCustomOnramp) {
        onrampTier = "custom";
      } else {
        onrampTier = "hosted";
      }

      respond(true, {
        enabled: walletConfig?.enabled !== false,
        network: walletConfig?.network ?? "base-sepolia",
        sessionSpendCapUsd: walletConfig?.sessionSpendCapUsd ?? 50,
        perTransactionCapUsd: walletConfig?.perTransactionCapUsd ?? 25,
        dailySpendLimitUsd: walletConfig?.dailySpendLimitUsd ?? 50,
        x402Enabled: walletConfig?.x402?.enabled ?? false,
        x402MaxPerRequestUsd: walletConfig?.x402?.maxCostPerRequestUsd ?? 1,
        // Onramp is always available — either via local keys, custom endpoint, or hosted service
        stripeOnrampEnabled: true,
        onrampTier,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.fund": async ({ respond }) => {
    try {
      const svc = getWalletService();
      const url = await svc.getFundingUrl();
      respond(true, { fundingUrl: url, network: svc.getNetwork() });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.x402Pay": async ({ params, respond }) => {
    try {
      const config = loadConfig();
      const walletConfig = config.tools?.wallet;
      if (!walletConfig?.x402?.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "x402 payments are not enabled in configuration"),
        );
        return;
      }
      const svc = getWalletService();
      const resourceUrl =
        typeof params.resourceUrl === "string" ? params.resourceUrl.trim() : "";
      const amount =
        typeof params.amount === "number" && Number.isFinite(params.amount)
          ? params.amount
          : 0;
      if (!resourceUrl || amount <= 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "resourceUrl (string) and amount (positive number) are required"),
        );
        return;
      }
      const result = await svc.payForResource(resourceUrl, amount);
      respond(true, result);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.stripeOnramp": async ({ respond }) => {
    try {
      const config = loadConfig();
      const walletConfig = config.tools?.wallet;

      const svc = getWalletService();
      const walletAddress = await svc.getAddress();
      const network = (walletConfig?.network ?? "base-sepolia") as "base" | "base-sepolia";

      // ── Tier 2: Local Stripe keys — create session locally ──
      const secretKey =
        walletConfig?.stripe?.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
      const publishableKey =
        walletConfig?.stripe?.publishableKey ?? process.env.STRIPE_PUBLISHABLE_KEY ?? "";

      if (secretKey && publishableKey) {
        const session = await createOnrampSession(secretKey, { walletAddress, network });
        respond(true, {
          clientSecret: session.clientSecret,
          publishableKey,
          tier: "local",
        });
        return;
      }

      // ── Tier 3: Custom onramp endpoint ──
      // ── Tier 1: Default to hosted service (onramp.bitterbot.ai) ──
      const onrampUrl =
        walletConfig?.onrampUrl ??
        process.env.BITTERBOT_ONRAMP_URL ??
        DEFAULT_ONRAMP_URL;

      const hosted = await createHostedOnrampSession(onrampUrl, {
        walletAddress,
        network,
      });
      respond(true, {
        clientSecret: hosted.clientSecret,
        publishableKey: hosted.publishableKey,
        tier: onrampUrl === DEFAULT_ONRAMP_URL ? "hosted" : "custom",
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.setConfig": async ({ params, respond }) => {
    // Admin-only: update wallet configuration fields at runtime.
    // Actual persistence goes through the config system; this validates and returns ok.
    try {
      const updates: Record<string, unknown> = {};
      if (typeof params.enabled === "boolean") updates.enabled = params.enabled;
      if (typeof params.network === "string") updates.network = params.network;
      if (typeof params.sessionSpendCapUsd === "number")
        updates.sessionSpendCapUsd = params.sessionSpendCapUsd;
      if (typeof params.perTransactionCapUsd === "number")
        updates.perTransactionCapUsd = params.perTransactionCapUsd;

      // Reset cached service so next call picks up new config
      cachedService = null;

      respond(true, { ok: true, applied: updates });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
