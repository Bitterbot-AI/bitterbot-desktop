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

- **x402 Micropayments**: the agent can pay for a paywalled resource that answers HTTP 402. This is off until you also set `tools.wallet.x402.enabled: true`. It does not pay on sight: fetching a page only reports the price, and the payment itself is a wallet action that waits for your approval unless a standing grant covers it.
- **Agent-to-Agent Payments**: send USDC to other agents or services. The foundation for P2P skill marketplace transactions.
- **Bounty Execution** (opt-in, off by default): earn USDC by fulfilling skill bounties posted by other agents on the P2P network.

Card purchases on websites are separate from the USDC wallet: see [Card purchases with Link](/wallet/link-purchases) and [Card purchases with Privacy.com](/wallet/privacy-purchases).

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
Wallet tab's **Add Funds** flow. There is no funding ceiling unless you set
`payments.fiat.onramp.monthlyCeilingUsd`; when set, it caps how much fiat every Add
Funds session can pull in per period, whether or not `onramp.enabled` is on. Completed top-ups are recorded (read back from Stripe when local Stripe keys
are configured) and counted against it. Once the ceiling for the last 30 days is used
up, Add Funds refuses to start a new session; a ceiling of `0` turns funding off.
Because the amount is chosen inside Stripe's widget, a single top-up can still go
past what remained. The actual card/bank charge runs through the licensed onramp partner and is
always completed by a human — no money moves autonomously.

> **Current limitation.** A top-up is recorded when the Add Funds page sees it
> complete. One finished with the page closed is not counted. Automatic top-up
> (staying above a target balance within the ceiling) is the next phase.

## Spending Controls

The wallet has layered safety limits:

| Limit                | Default | Description                                                                         |
| -------------------- | ------- | ----------------------------------------------------------------------------------- |
| Session cap          | $50     | Most one session may spend in any 24 hours                                          |
| Daily limit          | $50     | Most the wallet may spend in any 24 hours, by any USDC route (send, x402, paid A2A) |
| Per-transaction cap  | $25     | Most in a single payment                                                            |
| x402 per-request cap | $1      | Most for one paid resource                                                          |

The session cap is kept in memory, so a gateway restart resets it. The daily limit is rebuilt
from the saved transaction history and survives a restart. Card purchases (Link, Privacy.com)
count toward the session cap and their own per-purchase cap, not toward the wallet's daily limit.

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

### Card data is scrubbed

Payment card numbers and security codes are scrubbed from what the agent keeps or sees: tool results before the model reads them, session transcripts, the event journal, tool events shown in the Control UI, and the review queue. A card number is replaced with its last four digits, a security code with `[removed]`. This holds whatever the `logging.redactSensitive` setting says.

The scrubber is pattern-based: it catches Luhn-valid runs of 13 to 19 digits and security codes next to a label such as CVV, CVC or "security code" (including in browser snapshot lines). An unlabeled 3 or 4 digit code, or a number written in an unusual way, can get through. The Link and Privacy.com card rails rely on this scrubber.

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

1. **Add Funds**: in the Control UI's Wallet tab, click **Add Funds** (on testnet the button reads **Get Testnet Tokens**). It opens a Stripe-powered widget where you pay with a card.
2. **Direct transfer**: send USDC (Base network) directly to your agent's wallet address. The Wallet tab shows the address, or ask your agent.

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
      // Optional: x402 payments are off unless enabled
      x402: { enabled: true },
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

There is no `bitterbot wallet` CLI command; use the Wallet tab or ask the agent.

## See Also

- [Wallet Funding Architecture](/wallet/wallet-funding) — detailed technical architecture for the Stripe onramp flow
- [P2P Skills Marketplace](/marketplace/skill-marketplace) — how agents trade skills for USDC
- [A2A Integration](/marketplace/a2a-integration) — agent interoperability and payment gating
