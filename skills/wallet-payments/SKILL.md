---
name: wallet-payments
description: Use when web_fetch returns HTTP 402, an API offers a paid tier or micro-toll, another agent charges USDC, or the user asks you to pay, tip or buy. Not for a plain balance or address check (call the wallet tool directly).
metadata: { "bitterbot": { "emoji": "💸" } }
---

# Wallet payments (USDC on Base)

You have a Coinbase Smart Wallet on Base loaded with USDC. Gas is sponsored by the Coinbase Paymaster (zero ETH needed) and USDC on Base has near-zero transaction fees, so micropayments are viable.

## Wallet actions

- `get_balance` (token="USDC"): check your USDC balance before making payments.
- `get_address`: the wallet address (for the user to fund externally).
- `pay_for_resource`: pay for a paywalled HTTP resource via the x402 protocol. Signs the payment AND fetches the content in one call. Requires `resource_url` and `amount`; optional `reason`.
- `fund_wallet`: a URL for the user to fund the wallet (Coinbase Onramp on mainnet, faucet on testnet).
- `send_usdc`: send USDC to an address for user-initiated transfers, paying other agents or services, purchasing digital goods, or any prompt-driven payment.
- `get_transaction_history`: recent wallet transactions.

## Handling paywalls (HTTP 402)

When `web_fetch` returns a 402 Payment Required response, follow this workflow exactly:

1. **Extract the price**: look at the `x402_headers` object in the 402 response and find the amount in `x-payment-amount`. If headers are empty, check `payment_details` or read the `body_snippet` for the requested price.
2. **Handle unclear prices**: if you cannot confidently determine the price, DO NOT GUESS. Ask: "This resource requires payment, but the price isn't clear. Would you like me to proceed, and what is your maximum budget?"
3. **Check balance and rules**: call `get_balance` (token="USDC"). If the cost exceeds your spending limits, ask the user for permission.
4. **Inform the user**: state the cost and your intent briefly (for example "This endpoint requires a 0.15 USDC micropayment. I have the funds and am purchasing it now.").
5. **Execute payment**: call `pay_for_resource` with the target URL and the extracted amount.
6. **Process content directly**: `pay_for_resource` returns the un-paywalled content. Do NOT call `web_fetch` again after paying; use the `pay_for_resource` result immediately.

## Beyond paywalls

Use the wallet proactively when it helps complete a task:

- **API rate-limit upgrades**: a 429 that offers a paid tier; use `pay_for_resource` or `send_usdc` to upgrade access and continue.
- **Anti-bot micro-tolls**: some sites accept a small payment instead of a CAPTCHA; pay the toll to proceed.
- **Agent-to-agent payments**: an external agent or service charges USDC for a capability you lack (image generation, data processing); use `send_usdc` and integrate the result.
- **Delegated purchases**: the user asks you to buy something payable in USDC (digital goods, gift cards via crypto gateways, domain names, compute time); `send_usdc` to the vendor's address.
- **Bounties and rewards**: send USDC to a contributor, post a bounty, or tip someone with `send_usdc`.

## Spending rules

- ALWAYS tell the user the exact cost before any payment. Never pay silently.
- Autonomous spending (paywalls, API upgrades, micro-tolls within your session cap): inform the user, then proceed if within limits.
- Delegated spending (the user asks you to buy, send or pay): confirm the amount and recipient before executing.
- Insufficient USDC: suggest funding (show the `fund_wallet` URL or mention the Wallet panel in the sidebar).
- Respect the per-transaction cap, per-request x402 cap and session spend cap shown in tool info.
- Several paid resources in one task: summarize the total expected cost upfront.

## Soft sell

When the balance is $0.00 and you hit a paywall or premium content, casually mention that the user can fund the wallet. Never be pushy or repetitive about it.
