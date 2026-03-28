/**
 * Client for the hosted Bitterbot onramp service (onramp.bitterbot.ai).
 *
 * Tier 1: Users who don't configure any Stripe keys use this service.
 * The hosted service holds the Stripe secret key server-side and returns
 * a clientSecret + publishableKey for the Stripe Crypto Onramp widget.
 */

export const DEFAULT_ONRAMP_URL = "https://onramp.bitterbot.ai";

export interface HostedOnrampRequest {
  walletAddress: string;
  network: "base" | "base-sepolia";
  amount?: number;
}

export interface HostedOnrampResponse {
  clientSecret: string;
  publishableKey: string;
}

export async function createHostedOnrampSession(
  onrampUrl: string,
  params: HostedOnrampRequest,
): Promise<HostedOnrampResponse> {
  const url = new URL("/session", onrampUrl);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress: params.walletAddress,
      network: params.network,
      ...(params.amount != null && { amount: params.amount }),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Hosted onramp service returned ${res.status}: ${body || res.statusText}`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  const clientSecret = data.clientSecret;
  const publishableKey = data.publishableKey;
  if (typeof clientSecret !== "string" || typeof publishableKey !== "string") {
    throw new Error("Hosted onramp service returned invalid response");
  }

  return { clientSecret, publishableKey };
}
