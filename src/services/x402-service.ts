import type { WalletConfig } from "../config/types.wallet.js";
import type { WalletService } from "./wallet-service.js";

export type X402PaymentResult = {
  data: unknown;
  cost: string;
};

export type X402ServiceEntry = {
  url: string;
  description: string;
  price: string;
};

export interface X402Service {
  /** Execute an x402 payment flow: GET → 402 → sign payment → retry with X-PAYMENT header. */
  payForRequest(url: string, opts?: { maxCostUsd?: number }): Promise<X402PaymentResult>;
  /** Search for x402-enabled services (discovery endpoint). */
  searchServices(query: string): Promise<X402ServiceEntry[]>;
}

type X402PaymentPayload = {
  /** Payment network (e.g. "base"). */
  network: string;
  /** Recipient address for payment. */
  payTo: string;
  /** Required payment amount (smallest unit). */
  maxAmountRequired: string;
  /** Resource description. */
  resource: string;
  /** Payment scheme version. */
  scheme: string;
  /** Extra fields from the 402 response. */
  [key: string]: unknown;
};

export function createX402Service(walletService: WalletService, config: WalletConfig): X402Service {
  const maxCostDefault = config.x402?.maxCostPerRequestUsd ?? 1;

  return {
    async payForRequest(url: string, opts?: { maxCostUsd?: number }): Promise<X402PaymentResult> {
      const maxCost = opts?.maxCostUsd ?? maxCostDefault;

      // Step 1: Initial GET request
      const initialResponse = await fetch(url);

      // If not 402, return the data directly (no payment needed)
      if (initialResponse.status !== 402) {
        const data = await initialResponse.json();
        return { data, cost: "0" };
      }

      // Step 2: Parse the 402 payment payload
      const paymentHeader = initialResponse.headers.get("X-Payment");
      if (!paymentHeader) {
        throw new Error("402 response missing X-Payment header with payment instructions");
      }

      let paymentPayload: X402PaymentPayload;
      try {
        paymentPayload = JSON.parse(paymentHeader);
      } catch {
        throw new Error("Failed to parse X-Payment header as JSON");
      }

      // Step 3: Validate cost against cap
      const costUsd = parsePaymentCostUsd(paymentPayload);
      if (costUsd > maxCost) {
        throw new Error(
          `x402 payment cost $${costUsd.toFixed(4)} exceeds max allowed $${maxCost.toFixed(2)}`,
        );
      }

      // Step 4: Execute on-chain payment via wallet
      // Pass the raw integer amount to avoid float round-trip precision loss
      const rawSmallestUnit = BigInt(paymentPayload.maxAmountRequired);
      const sendResult = await walletService.sendUsdc(paymentPayload.payTo, costUsd, {
        rawSmallestUnit,
      });
      const address = await walletService.getAddress();

      // Step 5: Retry the request with payment proof
      const paymentProof = JSON.stringify({
        from: address,
        txHash: sendResult.txHash,
        network: paymentPayload.network,
        amount: paymentPayload.maxAmountRequired,
        payTo: paymentPayload.payTo,
        scheme: paymentPayload.scheme,
      });

      const paidResponse = await fetch(url, {
        headers: {
          "X-PAYMENT": paymentProof,
        },
      });

      if (!paidResponse.ok) {
        throw new Error(
          `x402 paid request failed: ${paidResponse.status} ${paidResponse.statusText}`,
        );
      }

      const data = await paidResponse.json();
      return { data, cost: costUsd.toFixed(6) };
    },

    async searchServices(query: string): Promise<X402ServiceEntry[]> {
      // x402 service discovery is still emerging; for now, return an empty list.
      // Future: query a registry like x402.org/services?q=...
      void query;
      return [];
    },
  };
}

function parsePaymentCostUsd(payload: X402PaymentPayload): number {
  // Convert from smallest unit based on scheme/network
  const amount = Number(payload.maxAmountRequired);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Invalid payment amount in x402 payload");
  }
  // Assume USDC (6 decimals) for Base network x402 payments
  return amount / 1e6;
}
