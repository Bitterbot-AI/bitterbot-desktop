import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { WalletConfig } from "../../config/types.wallet.js";
import { createWalletService, type WalletService } from "../../services/wallet-service.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

const WALLET_ACTIONS = [
  "get_balance",
  "send_usdc",
  "trade",
  "get_address",
  "get_transaction_history",
  "fund_wallet",
  "pay_for_resource",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const WalletToolSchema = Type.Object({
  action: stringEnum(WALLET_ACTIONS, {
    description:
      "The wallet action to perform: get_balance, send_usdc, trade, get_address, get_transaction_history, fund_wallet, or pay_for_resource.",
  }),
  address: Type.Optional(
    Type.String({ description: "Recipient address or ENS name (for send_usdc)." }),
  ),
  amount: Type.Optional(
    Type.Number({ description: "Amount in token units (for send_usdc, trade)." }),
  ),
  token: Type.Optional(
    Type.String({ description: "Token symbol for balance queries (default: ETH)." }),
  ),
  fromToken: Type.Optional(Type.String({ description: "Source token symbol (for trade)." })),
  toToken: Type.Optional(Type.String({ description: "Target token symbol (for trade)." })),
  limit: Type.Optional(
    Type.Number({
      description:
        "Max number of transactions to return (for get_transaction_history, default: 10).",
    }),
  ),
  resource_url: Type.Optional(
    Type.String({
      description: "URL of the paywalled resource to pay for and retrieve (for pay_for_resource).",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Brief explanation of why this resource is needed (for pay_for_resource).",
    }),
  ),
});

type WalletToolOptions = {
  config?: BitterbotConfig;
  agentSessionKey?: string;
};

export function createWalletTool(opts?: WalletToolOptions): AnyAgentTool | undefined {
  const walletConfig: WalletConfig | undefined = opts?.config?.tools?.wallet;
  // Wallet is on by default — user must explicitly set enabled=false to disable.
  // Safe because wallet starts empty; user must fund it to transact.
  if (walletConfig?.enabled === false) {
    return undefined;
  }

  const effectiveConfig: WalletConfig = walletConfig ?? {};

  // Lazily created wallet service instance
  let service: WalletService | null = null;
  function getService(): WalletService {
    if (!service) {
      service = createWalletService(effectiveConfig);
    }
    return service;
  }

  // Session spend tracking
  const sessionSpendCapUsd = effectiveConfig.sessionSpendCapUsd ?? 50;
  let sessionSpentUsd = 0;

  function checkSessionCap(amountUsd: number): void {
    if (sessionSpentUsd + amountUsd > sessionSpendCapUsd) {
      throw new ToolInputError(
        `Session spend cap exceeded. Cap: $${sessionSpendCapUsd}, spent: $${sessionSpentUsd.toFixed(2)}, ` +
          `requested: $${amountUsd.toFixed(2)}. Remaining: $${(sessionSpendCapUsd - sessionSpentUsd).toFixed(2)}.`,
      );
    }
  }

  function recordSpend(amountUsd: number): void {
    sessionSpentUsd += amountUsd;
  }

  const network = effectiveConfig.network ?? "base-sepolia";

  return {
    label: "Wallet",
    name: "wallet",
    description: `Manage a crypto wallet on Base ${network === "base-sepolia" ? "(testnet)" : "(mainnet)"}. Actions:
- get_address: Get the wallet's address.
- get_balance: Check token balance (default: ETH). Pass token="USDC" for USDC.
- send_usdc: Send USDC to an address. Requires: address, amount.
- trade: Swap tokens. Requires: fromToken, toToken, amount.
- get_transaction_history: View recent transactions. Optional: limit (default 10).
- fund_wallet: Get a URL to fund the wallet via Coinbase Onramp or faucet.
- pay_for_resource: Pay for a paywalled HTTP resource via x402 protocol (USDC on Base). Pass the exact price from the 402 response. This tool signs the payment AND fetches the resource — it RETURNS THE ACTUAL CONTENT. Do NOT call web_fetch again after using this action. Requires: resource_url, amount. Optional: reason.

Session spend cap: $${sessionSpendCapUsd}. Per-tx cap: $${effectiveConfig.perTransactionCapUsd ?? 25}. x402 max per request: $${effectiveConfig.x402?.maxCostPerRequestUsd ?? 1}.`,
    parameters: WalletToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const svc = getService();

      switch (action) {
        case "get_address": {
          const address = await svc.getAddress();
          return jsonResult({
            address,
            network: svc.getNetwork(),
          });
        }

        case "get_balance": {
          const token = readStringParam(params, "token") ?? "ETH";
          const result = await svc.getBalance(token);
          return jsonResult(result);
        }

        case "send_usdc": {
          const address = readStringParam(params, "address", {
            required: true,
            label: "recipient address",
          });
          const amount = readNumberParam(params, "amount", { required: true });
          checkSessionCap(amount);

          const result = await svc.sendUsdc(address, amount);
          recordSpend(amount);

          return jsonResult({
            ...result,
            amount,
            to: address,
            sessionSpent: sessionSpentUsd,
            sessionRemaining: sessionSpendCapUsd - sessionSpentUsd,
          });
        }

        case "trade": {
          const fromToken = readStringParam(params, "fromToken", {
            required: true,
            label: "source token",
          });
          const toToken = readStringParam(params, "toToken", {
            required: true,
            label: "target token",
          });
          const amount = readNumberParam(params, "amount", { required: true });
          checkSessionCap(amount);

          const result = await svc.trade(fromToken, toToken, amount);
          recordSpend(amount);

          return jsonResult({
            ...result,
            fromToken,
            toToken,
            amount,
            sessionSpent: sessionSpentUsd,
            sessionRemaining: sessionSpendCapUsd - sessionSpentUsd,
          });
        }

        case "get_transaction_history": {
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
          const history = await svc.getTransactionHistory(limit);
          return jsonResult({ transactions: history, count: history.length });
        }

        case "fund_wallet": {
          const url = await svc.getFundingUrl();
          return jsonResult({
            fundingUrl: url,
            network: svc.getNetwork(),
            instructions:
              network === "base-sepolia"
                ? "Visit the faucet URL to get free testnet tokens."
                : "Visit the Coinbase Onramp URL to fund with USDC.",
          });
        }

        case "pay_for_resource": {
          const x402Config = effectiveConfig.x402;
          if (!x402Config?.enabled) {
            throw new ToolInputError(
              "x402 payments are not enabled. Set tools.wallet.x402.enabled: true in config.",
            );
          }

          const resourceUrl = readStringParam(params, "resource_url", {
            required: true,
            label: "resource URL",
          });
          const amount = readNumberParam(params, "amount", { required: true });
          const maxPerRequest = x402Config.maxCostPerRequestUsd ?? 1;
          if (amount > maxPerRequest) {
            throw new ToolInputError(
              `Amount $${amount} exceeds x402 per-request cap of $${maxPerRequest}.`,
            );
          }

          checkSessionCap(amount);

          const result = await svc.payForResource(resourceUrl, amount);
          if (result.success) {
            recordSpend(result.amountPaid ?? amount);
          }

          return jsonResult({
            ...result,
            resource_url: resourceUrl,
            reason: readStringParam(params, "reason") ?? "",
            sessionSpent: sessionSpentUsd,
            sessionRemaining: sessionSpendCapUsd - sessionSpentUsd,
          });
        }

        default:
          throw new ToolInputError(`Unknown wallet action: ${action}`);
      }
    },
  };
}
