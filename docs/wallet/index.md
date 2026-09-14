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

## Money view (dollars)

By default the Wallet tab presents the wallet as a plain **dollar balance** with a
human-readable activity feed ("Paid a peer agent", "Added funds", "Earned from a
buyer") instead of USDC amounts and transaction hashes. One USDC is shown as $1.00
(it is a fully-reserved, issuer-redeemable US-dollar stablecoin), and any on/off-ramp
fee is surfaced explicitly, never folded into the amount. On testnet the balance is
marked "not real money".

The crypto-native details (wallet address, per-token balances, raw transactions, the
BaseScan links) are one click away behind **Show crypto details**. To make the wallet
crypto-first instead, set `payments.fiat.uiDollars` to `false` (default `true`). This
is display-only — it moves no money and changes no on-chain behavior.

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

The wallet tool is **opt-in** (V1 default flip): set `tools.wallet.enabled` to
`true` to expose it to the agent. The wallet starts empty either way; fund it
to transact.

```json5
{
  wallet: {
    enabled: true, // required — the wallet tool is off by default
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
