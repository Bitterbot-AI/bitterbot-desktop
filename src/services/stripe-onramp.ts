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

export interface OnrampSessionStatus {
  status: string;
  /** What was delivered, in USD terms (USDC is 1:1); null when Stripe does not say. */
  amountUsd: number | null;
}

/** Read a session back from Stripe, so a completed top-up is recorded at what Stripe says. */
export async function readOnrampSession(
  stripeSecretKey: string,
  sessionId: string,
): Promise<OnrampSessionStatus> {
  const stripe = new Stripe(stripeSecretKey);
  const session = (await stripe.rawRequest(
    "GET",
    `/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`,
    {},
  )) as unknown as {
    status?: string;
    transaction_details?: { destination_amount?: string | number | null };
  };
  const raw = session.transaction_details?.destination_amount;
  const amount = raw === null || raw === undefined ? NaN : Number(raw);
  return {
    status: session.status ?? "unknown",
    amountUsd: Number.isFinite(amount) && amount > 0 ? amount : null,
  };
}
