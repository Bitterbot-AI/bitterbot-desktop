# Wallet Funding Architecture

How Bitterbot agents get funded with USDC — from zero-friction user experience to full developer control.

## Overview

Every Bitterbot agent has a smart wallet on Base loaded with USDC. The wallet enables autonomous micropayments: paying for paywalled content, API access, agent-to-agent transactions, and user-delegated purchases. Gas is sponsored by the Coinbase Paymaster, so only USDC is needed.

The funding pipeline converts fiat (credit card) to USDC via Stripe's Crypto Onramp. The architecture supports three tiers of operation so that end users never touch a config file while developers retain full control.

## User Experience

From the user's perspective, funding is a single interaction:

1. The agent encounters a paywall or the user clicks **Fund Wallet** in the sidebar
2. A funding page opens with Stripe's embedded widget
3. The user enters their card details and an amount
4. Stripe handles KYC, payment processing, and crypto delivery
5. USDC arrives in the agent's wallet within ~30 seconds
6. The agent continues working

The user never manages keys, signs transactions, or thinks about blockchain. They're buying capability for their agent with a credit card.

## Architecture

### How It Works

Stripe's [Crypto Onramp](https://docs.stripe.com/crypto/onramp) is an embeddable widget that handles the entire fiat-to-crypto pipeline: identity verification, payment collection, currency conversion, and on-chain delivery. Bitterbot wraps this in a three-tier system.

The flow requires two Stripe credentials:
- **Secret key** — used server-side to create an Onramp Session
- **Publishable key** — used client-side to render the widget

The secret key never leaves the server. The publishable key and a one-time `client_secret` are passed to the frontend to initialize the widget.

```
┌─────────────┐         ┌──────────────────┐         ┌─────────┐
│  Bitterbot   │ ──(1)──▶│  Onramp Service  │ ──(2)──▶│  Stripe │
│  App / UI    │         │  (creates session)│◀──(3)── │   API   │
│              │◀──(4)── │                  │         │         │
│              │         └──────────────────┘         │         │
│  (5) Renders │                                      │         │
│  Stripe      │ ─────────────────────────────(6)────▶│         │
│  Widget      │                                      │         │
└─────────────┘                                       │         │
                                                      │  (7)    │
┌─────────────┐                                       │  Sends  │
│  Agent       │◀──────────────────────────────(8)─────│  USDC   │
│  Wallet      │                                       └─────────┘
└─────────────┘

1. App requests an onramp session (wallet address + network)
2. Service creates a Stripe Crypto Onramp Session
3. Stripe returns session with client_secret
4. Service returns client_secret + publishable_key to app
5. App renders the Stripe Onramp widget
6. User completes payment in widget (card, KYC — all Stripe-hosted)
7. Stripe converts fiat → USDC and sends on-chain
8. USDC arrives at the agent's wallet address on Base
```

### Three Tiers

The app resolves its funding strategy in order:

#### Tier 1: Hosted Service (Default)

For regular users and developers who don't want to configure Stripe.

The app ships with a default `onrampUrl` pointing to `https://onramp.bitterbot.ai` — a lightweight service operated by the Bitterbot project. This service holds the Stripe credentials and creates onramp sessions on behalf of users.

No configuration required. Install the app, click Fund, pay.

```
App → onramp.bitterbot.ai/session → Stripe → USDC to wallet
```

The hosted service is rate-limited and may include a small transparent service fee on mainnet to cover infrastructure costs. Testnet usage is free.

#### Tier 2: Self-Hosted Stripe Keys

For developers who want to be their own Stripe merchant.

Set your own Stripe keys in config or environment variables. The app creates onramp sessions locally, bypassing the hosted service entirely. You control the Stripe account, fees, and KYC flow.

```yaml
# In bitterbot config
tools:
  wallet:
    stripe:
      enabled: true
      secretKey: sk_live_...       # or STRIPE_SECRET_KEY env var
      publishableKey: pk_live_...  # or STRIPE_PUBLISHABLE_KEY env var
```

When local keys are detected, the app creates sessions directly against the Stripe API from the gateway process. The hosted service is never contacted.

#### Tier 3: Custom Onramp Endpoint

For developers who want to run their own onramp service or build an alternative funding mechanism.

```yaml
tools:
  wallet:
    onrampUrl: https://your-service.example.com
```

The app calls your endpoint with the same contract as the hosted service. You can implement any funding logic behind it — Stripe, Coinbase Commerce, MoonPay, manual transfers, or anything else.

### Resolution Order

```
1. Local Stripe keys present?     → Tier 2 (create session locally)
2. Custom onrampUrl configured?   → Tier 3 (call custom endpoint)
3. Neither?                       → Tier 1 (call onramp.bitterbot.ai)
```

## Onramp Service API

Whether hosted or self-deployed, the onramp service exposes a single endpoint.

### `POST /session`

Creates a Stripe Crypto Onramp session and returns the credentials needed to render the widget.

**Request:**
```json
{
  "walletAddress": "0xabc...",
  "network": "base-sepolia",
  "amount": 10.00
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `walletAddress` | string | yes | Agent wallet address (hex, checksummed) |
| `network` | string | yes | `base-sepolia` (testnet) or `base` (mainnet) |
| `amount` | number | no | Pre-filled USDC amount |

**Response:**
```json
{
  "clientSecret": "cos_xxx_secret_yyy",
  "publishableKey": "pk_test_..."
}
```

**Errors:**
| Status | Meaning |
|--------|---------|
| 400 | Invalid wallet address or network |
| 429 | Rate limited |
| 503 | Stripe unavailable |

### Rate Limiting

The hosted service rate-limits by IP and wallet address to prevent session spam. Defaults:
- 10 sessions per wallet address per hour
- 30 sessions per IP per hour

## Configuration Reference

All wallet funding configuration lives under `tools.wallet` in the Bitterbot config.

```yaml
tools:
  wallet:
    enabled: true
    network: base-sepolia          # base-sepolia | base

    # Tier 2: local Stripe keys (optional)
    stripe:
      enabled: true                # Activates local session creation
      secretKey: sk_test_...       # Or STRIPE_SECRET_KEY env var
      publishableKey: pk_test_...  # Or STRIPE_PUBLISHABLE_KEY env var

    # Tier 3: custom onramp endpoint (optional)
    onrampUrl: https://your-service.example.com
```

Environment variables take precedence over config file values for secrets:
- `STRIPE_SECRET_KEY` → `stripe.secretKey`
- `STRIPE_PUBLISHABLE_KEY` → `stripe.publishableKey`

### Testnet vs Mainnet

| Setting | Testnet (`base-sepolia`) | Mainnet (`base`) |
|---------|--------------------------|-------------------|
| Stripe keys | Test keys (`sk_test_`, `pk_test_`) | Live keys (`sk_live_`, `pk_live_`) |
| USDC | Test USDC (no real value) | Real USDC |
| Faucet fallback | Available | Not available |
| Hosted service fee | Free | Small service fee (shown in UI) |

The funding page automatically shows a **Use Faucet** option on testnet for developers who want free test USDC without going through Stripe.

## Security

**Secret keys are never exposed to the frontend.** The Stripe secret key lives either in the hosted service or in the developer's local config/environment. Only the publishable key and a one-time `client_secret` reach the browser.

**Wallet address locking.** Every onramp session is created with `lock_wallet_address: true`. The Stripe widget does not allow the user to change the destination — USDC can only be sent to the agent's wallet.

**Gateway auth.** The `/wallet/fund` page and the `wallet.stripeOnramp` RPC method are protected by the gateway's existing auth layer (token or device authentication). Unauthenticated requests are rejected.

**No keys in the binary.** The downloadable app contains zero secrets. Tier 1 users authenticate through the hosted service. Tier 2 developers supply their own keys explicitly.

## Deploying Your Own Onramp Service

If you want to run the hosted service yourself (Tier 3), here's the minimal implementation:

```typescript
// Cloudflare Worker, Express, or any HTTP framework
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

app.post("/session", async (req, res) => {
  const { walletAddress, network, amount } = req.body;

  const session = await stripe.crypto.onrampSessions.create({
    wallet_addresses: { base: walletAddress },
    lock_wallet_address: true,
    destination_currencies: ["usdc"],
    destination_networks: ["base"],
    ...(amount && {
      destination_amount: amount.toString(),
      destination_currency: "usdc",
    }),
  });

  res.json({
    clientSecret: session.client_secret,
    publishableKey,
  });
});
```

Add rate limiting, input validation, and logging as appropriate for your deployment.

## How the Agent Uses the Wallet

Once funded, the agent spends USDC autonomously within configurable limits:

- **Paywalled content (x402):** When `web_fetch` returns HTTP 402, the agent reads the price from response headers, informs the user, and pays via the x402 protocol.
- **API upgrades:** If a service returns 429 but offers a paid tier, the agent can pay to upgrade.
- **Agent-to-agent payments:** External agents or services that charge USDC.
- **User-delegated purchases:** The user asks the agent to buy something or send USDC to an address.

Spending is governed by per-transaction caps, per-request caps, and session spend limits — all configurable.

## Related

- [Wallet Tool Reference](./tools/wallet.md) — Agent-facing wallet capabilities
- [x402 Protocol](https://www.x402.org/) — HTTP-native micropayment standard
- [Stripe Crypto Onramp Docs](https://docs.stripe.com/crypto/onramp) — Stripe's official documentation
- [Coinbase AgentKit](https://docs.cdp.coinbase.com/agentkit/docs/welcome) — Wallet infrastructure
