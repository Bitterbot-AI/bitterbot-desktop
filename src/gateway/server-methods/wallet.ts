import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  defaultTopUpLedgerPath,
  listTopUps,
  recordTopUp,
  sessionIdFromClientSecret,
} from "../../payments/fiat/topup-ledger.js";
import { gatedWallet } from "../../review/spend.js";
import { createHostedOnrampSession, DEFAULT_ONRAMP_URL } from "../../services/hosted-onramp.js";
import { createOnrampSession } from "../../services/stripe-onramp.js";
import { resolveWalletProvisioning } from "../../services/wallet-provisioning.js";
import { createWalletService, type WalletService } from "../../services/wallet-service.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

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

  "wallet.getMoneyView": async ({ params, respond }) => {
    try {
      const svc = getWalletService();
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 50;
      const [usdc, history] = await Promise.all([
        svc.getBalance("USDC"),
        svc.getTransactionHistory(limit),
      ]);
      const { buildMoneyView, kindForTxType, usdcToUsd } =
        await import("../../payments/fiat/money-view.js");
      // The dollar ledger is USDC-denominated: include USDC transfers and x402
      // payments (always USDC); ETH/gas rows are not user-facing money events.
      const events = history
        .filter((t) => (t.token ?? "USDC") === "USDC" || t.type === "x402_payment")
        .map((t) => ({
          kind: kindForTxType(t.type),
          amountUsd: usdcToUsd(t.amount),
          at: t.timestamp,
          ref: t.txHash,
        }));
      const view = buildMoneyView({
        balanceUsdc: usdc.balance,
        events,
        note:
          "Your balance is the live on-chain total. The activity list itemizes recorded " +
          "spends; money you received or earned is reflected in the balance.",
      });
      respond(true, view);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.requestFunding": async ({ params, respond }) => {
    // PLAN-49 Phase 2: raise a funding request on the consent rail. Notifies the
    // operator to Add Funds instead of the agent dead-ending; enforces the monthly
    // ceiling headroom. Moves no money — the human completes the top-up via the
    // licensed onramp partner. Gated by payments.fiat.onramp.enabled (default off).
    try {
      const config = loadConfig();
      const onramp = config.payments?.fiat?.onramp;
      if (onramp?.enabled !== true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "In-app funding is not enabled (payments.fiat.onramp)",
          ),
        );
        return;
      }
      const amountUsd =
        typeof params.amountUsd === "number" && Number.isFinite(params.amountUsd)
          ? params.amountUsd
          : NaN;
      if (!(amountUsd > 0)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "amountUsd (positive number) required"),
        );
        return;
      }
      const reason = typeof params.reason === "string" ? params.reason : undefined;

      const { checkFundingWithinCeiling } = await import("../../payments/fiat/funding-policy.js");
      const ceiling = checkFundingWithinCeiling({
        requestUsd: amountUsd,
        ceilingUsd: onramp.monthlyCeilingUsd,
        priorTopUps: await listTopUps(
          defaultTopUpLedgerPath(loadConfig().tools?.wallet?.walletStorePath),
        ),
      });

      const svc = getWalletService();
      let balanceUsd: number | undefined;
      try {
        const bal = await svc.getBalance("USDC");
        const n = Number.parseFloat(bal.balance);
        balanceUsd = Number.isFinite(n) ? n : undefined;
      } catch {
        // balance is best-effort context for the prompt
      }

      const { notifyFundingNeeded } = await import("../../payments/fiat/funding-notifier.js");
      await notifyFundingNeeded({ amountUsd, reason, balanceUsd });

      let onrampUrl: string | undefined;
      try {
        onrampUrl = await svc.getFundingUrl();
      } catch {
        // onramp URL is best-effort
      }

      respond(true, {
        requestedUsd: amountUsd,
        withinCeiling: ceiling.allowed,
        remainingUsd: Number.isFinite(ceiling.remainingUsd) ? ceiling.remainingUsd : null,
        onrampUrl,
      });
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
      const onrampUrl = walletConfig?.onrampUrl ?? process.env.BITTERBOT_ONRAMP_URL ?? "";
      const hasCustomOnramp = !!onrampUrl;

      let onrampTier: "local" | "custom" | "hosted" | "none";
      if (hasLocalKeys) {
        onrampTier = "local";
      } else if (hasCustomOnramp) {
        onrampTier = "custom";
      } else {
        onrampTier = "hosted";
      }

      const provisioningView = resolveWalletProvisioning(walletConfig);

      respond(true, {
        // V1 default flip (PLAN-41 D-D): the wallet is opt-in.
        enabled: walletConfig?.enabled === true,
        network: walletConfig?.network ?? "base-sepolia",
        sessionSpendCapUsd: walletConfig?.sessionSpendCapUsd ?? 50,
        perTransactionCapUsd: walletConfig?.perTransactionCapUsd ?? 25,
        dailySpendLimitUsd: walletConfig?.dailySpendLimitUsd ?? 50,
        x402Enabled: walletConfig?.x402?.enabled ?? false,
        x402MaxPerRequestUsd: walletConfig?.x402?.maxCostPerRequestUsd ?? 1,
        // Onramp is always available — either via local keys, custom endpoint, or hosted service
        stripeOnrampEnabled: true,
        onrampTier,
        // PLAN-49 Phase 1: present the wallet as dollars + a plain-English ledger.
        // Display-only, default on.
        uiDollars: config.payments?.fiat?.uiDollars ?? true,
        // PLAN-49 Phase 2: in-app funding on the consent rail (default off).
        onrampEnabled: config.payments?.fiat?.onramp?.enabled === true,
        fundingMonthlyCeilingUsd: config.payments?.fiat?.onramp?.monthlyCeilingUsd,
        // PLAN-49 Phase 0.5: wallet provisioning mode (embedded vs self-host CDP).
        provisioning: provisioningView.mode,
        embeddedProjectId: provisioningView.embeddedProjectId,
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
      // Paying needs a wallet that was switched on, not merely one that was
      // not switched off (reads above are more lenient on purpose).
      if (walletConfig.enabled !== true) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "the wallet is not enabled (tools.wallet.enabled)"),
        );
        return;
      }
      // PLAN-53 C0: the owner paying directly still goes through the gate, so
      // it is recorded and counts against the same limits.
      const svc = gatedWallet(getWalletService(), {
        origin: "rpc",
        purpose: "x402 from the gateway API",
      });
      const resourceUrl = typeof params.resourceUrl === "string" ? params.resourceUrl.trim() : "";
      const amount =
        typeof params.amount === "number" && Number.isFinite(params.amount) ? params.amount : 0;
      if (!resourceUrl || amount <= 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "resourceUrl (string) and amount (positive number) are required",
          ),
        );
        return;
      }
      // The same per-request ceiling the agent's tool has. It was missing here.
      const maxPerRequest = walletConfig.x402.maxCostPerRequestUsd ?? 1;
      if (amount > maxPerRequest) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `amount $${amount} exceeds the x402 per-request cap of $${maxPerRequest} (tools.wallet.x402.maxCostPerRequestUsd)`,
          ),
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

  /**
   * A funding session finished (PLAN-53 C5). Records the top-up once so the
   * monthly ceiling counts it. With local Stripe keys the amount is read back
   * from Stripe; otherwise the amount the funding page reports is used.
   */
  "wallet.recordTopUp": async ({ params, respond }) => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    const reported =
      typeof params.amountUsd === "number" && Number.isFinite(params.amountUsd)
        ? params.amountUsd
        : NaN;
    if (!/^cos_[A-Za-z0-9]+$/.test(sessionId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "a Stripe onramp sessionId (cos_...) is required"),
      );
      return;
    }
    try {
      const config = loadConfig();
      const walletConfig = config.tools?.wallet;
      const secretKey = walletConfig?.stripe?.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
      let amountUsd = reported;
      let source: "stripe-verified" | "reported" = "reported";
      if (secretKey) {
        const { readOnrampSession } = await import("../../services/stripe-onramp.js");
        const session = await readOnrampSession(secretKey, sessionId);
        if (session.status !== "fulfillment_complete") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `session is ${session.status}, not complete`),
          );
          return;
        }
        if (session.amountUsd !== null) {
          amountUsd = session.amountUsd;
          source = "stripe-verified";
        }
      }
      if (!(amountUsd > 0)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "amountUsd (positive number) required"),
        );
        return;
      }
      const recorded = await recordTopUp(defaultTopUpLedgerPath(walletConfig?.walletStorePath), {
        sessionId,
        amountUsd,
        atMs: Date.now(),
        source,
        network: walletConfig?.network ?? "base-sepolia",
      });
      respond(true, { recorded, amountUsd, source });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "wallet.listTopUps": async ({ respond }) => {
    const walletConfig = loadConfig().tools?.wallet;
    respond(true, {
      topUps: await listTopUps(defaultTopUpLedgerPath(walletConfig?.walletStorePath)),
    });
  },

  "wallet.stripeOnramp": async ({ respond }) => {
    try {
      const config = loadConfig();
      const walletConfig = config.tools?.wallet;

      const svc = getWalletService();
      const walletAddress = await svc.getAddress();
      const network = (walletConfig?.network ?? "base-sepolia") as "base" | "base-sepolia";

      // PLAN-53 C5: the monthly funding ceiling is enforced here, where money
      // comes in, against the top-ups already completed this period. The
      // amount is chosen inside Stripe's widget, so a session is refused once
      // the ceiling is used up; one top-up can still go past what remains.
      const ceilingUsd = config.payments?.fiat?.onramp?.monthlyCeilingUsd;
      if (ceilingUsd !== undefined) {
        const { checkFundingWithinCeiling } = await import("../../payments/fiat/funding-policy.js");
        const headroom = checkFundingWithinCeiling({
          requestUsd: 0.01,
          ceilingUsd,
          priorTopUps: await listTopUps(defaultTopUpLedgerPath(walletConfig?.walletStorePath)),
        });
        if (!headroom.allowed) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              ceilingUsd === 0
                ? "Funding is turned off (payments.fiat.onramp.monthlyCeilingUsd is 0)."
                : `The monthly funding ceiling of $${ceilingUsd} has been reached. It frees up as top-ups pass 30 days old (payments.fiat.onramp.monthlyCeilingUsd).`,
            ),
          );
          return;
        }
      }

      // ── Tier 2: Local Stripe keys — create session locally ──
      const secretKey = walletConfig?.stripe?.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
      const publishableKey =
        walletConfig?.stripe?.publishableKey ?? process.env.STRIPE_PUBLISHABLE_KEY ?? "";

      if (secretKey && publishableKey) {
        const session = await createOnrampSession(secretKey, { walletAddress, network });
        respond(true, {
          clientSecret: session.clientSecret,
          publishableKey,
          tier: "local",
          sessionId: session.sessionId,
        });
        return;
      }

      // ── Tier 3: Custom onramp endpoint ──
      // ── Tier 1: Default to hosted service (onramp.bitterbot.ai) ──
      const onrampUrl =
        walletConfig?.onrampUrl ?? process.env.BITTERBOT_ONRAMP_URL ?? DEFAULT_ONRAMP_URL;

      const hosted = await createHostedOnrampSession(onrampUrl, {
        walletAddress,
        network,
      });
      respond(true, {
        clientSecret: hosted.clientSecret,
        publishableKey: hosted.publishableKey,
        tier: onrampUrl === DEFAULT_ONRAMP_URL ? "hosted" : "custom",
        sessionId: sessionIdFromClientSecret(hosted.clientSecret),
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
    // Admin-only: update wallet configuration fields at runtime. Writes the
    // merged config to disk so the change survives restarts, then drops the
    // cached service so the next call picks it up.
    try {
      const updates: Record<string, unknown> = {};
      if (typeof params.enabled === "boolean") {
        updates.enabled = params.enabled;
      }
      if (params.network === "base" || params.network === "base-sepolia") {
        updates.network = params.network;
      }
      if (typeof params.sessionSpendCapUsd === "number" && params.sessionSpendCapUsd > 0) {
        updates.sessionSpendCapUsd = params.sessionSpendCapUsd;
      }
      if (typeof params.perTransactionCapUsd === "number" && params.perTransactionCapUsd > 0) {
        updates.perTransactionCapUsd = params.perTransactionCapUsd;
      }
      if (typeof params.dailySpendLimitUsd === "number" && params.dailySpendLimitUsd > 0) {
        updates.dailySpendLimitUsd = params.dailySpendLimitUsd;
      }

      if (Object.keys(updates).length > 0) {
        const cfg = loadConfig();
        const tools = cfg.tools ? { ...cfg.tools } : {};
        tools.wallet = {
          ...tools.wallet,
          ...(updates as Partial<NonNullable<typeof tools.wallet>>),
        };
        await writeConfigFile({ ...cfg, tools });
      }

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
