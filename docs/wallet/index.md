---
summary: "Agent wallet overview: USDC on Base, x402 micropayments, funding"
read_when:
  - You want to understand the agent wallet
  - You need to fund your agent or configure spending
title: "Agent Wallet"
---

# Agent Wallet

A Bitterbot agent can have a USDC wallet on Base, held as a Coinbase Developer Platform (CDP) server account. It is off until you turn it on, and starts on the Base Sepolia test network.

Sending USDC needs a small amount of ETH in the same wallet to pay network fees. Gasless sending through a smart account is not active yet.

## What the Wallet Enables

- **x402 Micropayments**: the agent can pay for a paywalled resource that answers HTTP 402. It does not pay on sight: fetching a page only reports the price, and the payment itself is a wallet action that waits for your approval unless a standing grant covers it.
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

## In-app funding (PLAN-49 Phase 2)

With `payments.fiat.onramp.enabled` (default off), the agent asks you to add funds
instead of dead-ending when it is short for a task: it calls `request_funding`,
which delivers a "funds needed" prompt to your primary channel and points you at the
Wallet tab's **Add Funds** flow. A hard **monthly funding ceiling**
(`payments.fiat.onramp.monthlyCeilingUsd`) caps how much fiat can be pulled in per
period. Today the ceiling is advisory: it is shown with the funding prompt, but the
Add Funds flow does not refuse a top-up above it, and past top-ups are not counted
(see the limitation below). The actual card/bank charge runs through the licensed onramp partner and is
always completed by a human — no money moves autonomously.

> **Current limitation.** Funding requests, the ceiling math, and the operator
> prompt are wired and tested, but completed top-ups are not yet recorded back, so
> the ceiling headroom shown assumes a fresh period. Automatic top-up (staying above
> a target balance within the ceiling) and completion tracking are the next phase.

## Spending Controls

The wallet has layered safety limits:

| Limit                | Default | Description                                             |
| -------------------- | ------- | ------------------------------------------------------- |
| Session cap          | $50     | Most one session may spend in any 24 hours              |
| Daily limit          | $50     | Most the wallet may spend in any 24 hours, by any route |
| Per-transaction cap  | $25     | Most in a single payment                                |
| x402 per-request cap | $1      | Most for one paid resource                              |

Paid tasks sent to other agents have two smaller limits of their own:
`a2a.marketplace.client.maxTaskCostUsdc` ($0.50 per task) and `dailySpendLimitUsdc`
($2 per day).

Every payment leaves through one spend gate, whichever route asked for it: the agent's wallet
tool, a paid task for another agent, the gateway API, or an automatic payout. The gate applies
these limits, and records each payment it allowed or refused where you can read it (the
**Payments** list in the Activity tab).

A payment over a limit is refused when it is about to be sent. Inside the limits, a send, an
x402 payment or a paid task for another agent still waits for your approval unless a standing
spend grant covers it: see [Action review](/tools/action-review). Payouts of money already owed
to others (royalties, bounties) do not wait; they are limited, recorded, and you are told when
they go out. Set `review.spend: "allow"` to go back to caps only, and
then set the caps to amounts you can lose.

### Card data is never kept

Payment card numbers and security codes are scrubbed from everything the agent keeps or sees: tool results before the model reads them, session transcripts, the event journal, tool events shown in the Control UI, and the review queue. A card number is replaced with its last four digits, a security code with `[removed]`. This holds whatever the `logging.redactSensitive` setting says. Fiat purchases with a card are not built yet; this is the floor they will stand on.

The `wallet` and `a2a_client` tools are **owner-only**, like the tools that run code or drive the
browser. They are offered to the agent only on turns you start yourself: the Control UI, the CLI,
or a channel message from an owner account (`commands.ownerAllowFrom`, or the channel's `allowFrom`
list when that is not set). A message from anyone else, including other members of a group chat,
runs without them, so nobody else can ask your agent to pay them. Heartbeat turns,
webhook-triggered runs, and anything a non-owner turn starts (sub-agents, task wakeups) do not get
them either. An isolated scheduled job you added yourself runs as you. See
[Owner-only tools](/gateway/security#owner-only-tools).

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
  tools: {
    wallet: {
      enabled: true, // required: the wallet is off by default
      network: "base-sepolia", // default; "base" is mainnet, real money
      // Optional: adjust spending limits
      sessionSpendCapUsd: 50,
      perTransactionCapUsd: 25,
      dailySpendLimitUsd: 50,
    },
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
