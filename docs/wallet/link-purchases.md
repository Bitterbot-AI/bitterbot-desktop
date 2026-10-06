---
summary: "Let the agent buy things with a one-time card from your Stripe Link account"
read_when:
  - You want the agent to complete a purchase on a website
  - Setting up Link Agent Wallet
title: "Card purchases with Link"
---

# Card purchases with Link

With `payments.link.enabled`, the agent can buy something on a website using a one-time card from your own [Stripe Link](https://link.com) account. You approve every purchase in the Link app. This uses Stripe's Link Agent Wallet; it is separate from the USDC wallet.

Off by default. US and Canada only, as Link Agent Wallet is.

## How a purchase goes

1. **Request.** The agent asks Link for a card for one merchant and one amount, with a description of at least 100 characters saying what it is buying and why.
2. **You approve in Link.** The Link app shows the merchant, the amount and that description. Nothing happens until you approve.
3. **The card goes into the page, not to the agent.** Once approved, the gateway fetches the one-time card into a private file, types it into the checkout form's fields, and deletes the file. It types the card only into a browser tab on the approved merchant's site (the same registrable domain, so any subdomain, and also other tenants on shared hosting domains such as `*.myshopify.com`). The agent is told only "visa ending 4242". If the number shows up later, for example in a snapshot of the filled page, it is scrubbed (pattern-based) from the agent's context, transcripts, events and logs.
4. **The agent submits the order** in the browser, after checking the total matches what you approved. You can watch, and take over, in the Browser tab.

Each purchase is recorded in the **Payments** list of the Activity tab and counts against your session spending cap. That cap is kept in memory and resets when the gateway restarts, and card purchases do not count toward the wallet's daily limit.

## Setting it up

```json5
{
  payments: {
    link: {
      enabled: true,
      perPurchaseCapUsd: 100, // default 100
    },
  },
}
```

Then ask the agent to connect Link ("connect my Link account"). It gives you a link and a short phrase: open the link, log in to Link and enter the phrase. The login is kept in `~/.bitterbot/link/auth.json`.

The gateway runs Stripe's Link CLI, pinned to `@stripe/link-cli@0.26.0`, through `npx` (downloaded on first use). Point `payments.link.command` at an installed copy to avoid the download.

## Limits

- Typing into card fields works for ordinary checkout forms. Card fields that live inside a payment provider's embedded frame may not be reachable from a page snapshot; the agent then hands the browser to you to enter the card details.
- A purchase that needs 3-D Secure or another step in Link shows the step Link asks for; the agent hands it to you.
- The `purchase` tool is owner-only and cannot be called over the gateway's HTTP tool endpoint.

No Link account? See [Card purchases with Privacy.com](/wallet/privacy-purchases).
