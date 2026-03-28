import Stripe from "stripe";

export interface OnrampSessionParams {
  walletAddress: string;
  network: "base" | "base-sepolia";
  defaultAmount?: number;
}

export interface OnrampSession {
  clientSecret: string;
  sessionId: string;
}

export async function createOnrampSession(
  stripeSecretKey: string,
  params: OnrampSessionParams,
): Promise<OnrampSession> {
  const stripe = new Stripe(stripeSecretKey);

  const reqParams: Record<string, string> = {
    "wallet_addresses[base_network]": params.walletAddress,
    lock_wallet_address: "true",
    "destination_currencies[0]": "usdc",
    "destination_networks[0]": "base",
  };
  if (params.defaultAmount) {
    reqParams.destination_amount = params.defaultAmount.toString();
    reqParams.destination_currency = "usdc";
  }

  const session = (await stripe.rawRequest(
    "POST",
    "/v1/crypto/onramp_sessions",
    reqParams,
  )) as unknown as { id: string; client_secret: string };

  return {
    clientSecret: session.client_secret,
    sessionId: session.id,
  };
}
