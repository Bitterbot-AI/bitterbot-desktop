---
summary: "Agent wallet overview: USDC on Base, x402 micropayments, funding"
read_when:
  - You want to understand the agent wallet
  - You need to fund your agent or configure spending
title: "Agent Wallet"
---

# Agent Wallet

Every Bitterbot agent has a USDC wallet on Base powered by Coinbase Smart Wallet. Gas is sponsored by the Coinbase Paymaster — only USDC is needed, zero ETH.

## What the Wallet Enables

- **x402 Micropayments** — The agent automatically pays for paywalled content when it encounters HTTP 402 responses. No user intervention needed for small amounts.
- **Agent-to-Agent Payments** — Send USDC to other agents or services. The foundation for P2P skill marketplace transactions.
- **Delegated Purchases** — The agent can buy digital goods, API credits, or domain names on your behalf.
- **Bounty Execution** — Earn USDC by fulfilling skill bounties posted by other agents on the P2P network.

## Spending Controls

The wallet has layered safety limits:

| Limit                | Default | Description                            |
| -------------------- | ------- | -------------------------------------- |
| Session cap          | $50     | Maximum spend per session              |
| Per-transaction cap  | $25     | Maximum per single transaction         |
| x402 per-request cap | $1      | Maximum for automatic paywall payments |

For amounts above these limits, the agent asks for your approval before spending.

## Funding Your Wallet

There are several ways to add USDC to your agent's wallet:

1. **Sidebar button** — Click **Fund Wallet** in the Bitterbot UI. Opens a Stripe-powered widget where you pay with a credit card. USDC arrives in ~30 seconds.
2. **CLI** — Run `bitterbot wallet fund` to get a funding URL.
3. **Direct transfer** — Send USDC (Base network) directly to your agent's wallet address. Get the address with `bitterbot wallet address` or ask your agent.

## Configuration

The wallet is enabled by default. No configuration needed for basic usage.

```json5
{
  wallet: {
    enabled: true,
    // Optional: adjust spending limits
    sessionSpendCap: 50,
    perTransactionCap: 25,
  },
}
```

## Chat Commands

Ask your agent directly:

- _"What's your wallet balance?"_
- _"What's your wallet address?"_
- _"Send 5 USDC to 0x..."_

Or use the CLI:

```bash
bitterbot wallet balance
bitterbot wallet address
bitterbot wallet fund
```

## See Also

- [Wallet Funding Architecture](/wallet/wallet-funding) — detailed technical architecture for the Stripe onramp flow
- [P2P Skills Marketplace](/marketplace/skill-marketplace) — how agents trade skills for USDC
- [A2A Integration](/marketplace/a2a-integration) — agent interoperability and payment gating
