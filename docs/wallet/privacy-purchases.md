---
summary: "Let the agent buy things with single-use cards from your Privacy.com account"
read_when:
  - You want card purchases without Stripe Link
  - Setting up Privacy.com for the agent
title: "Card purchases with Privacy.com"
---

# Card purchases with Privacy.com

If you do not use [Stripe Link purchases](/wallet/link-purchases), the agent can buy things with
single-use virtual cards from your own [Privacy.com](https://privacy.com)
account. Privacy.com has no approval step of its own, so you approve each
purchase in Bitterbot, the same way you approve a payment from the wallet.

## How a purchase goes

1. The agent asks to buy from a shop, for an amount, and says why.
2. The request waits for you in the Control UI (or on your chat channel). Nothing
   is created yet.
3. When you approve it, Bitterbot creates one **single-use** card in your Privacy
   account with a spending limit of exactly that amount.
4. The agent fills the shop's checkout form. The gateway types the card into the
   page; the agent only ever sees "Privacy card ending 4242".
5. The card closes after one charge. If it is not used within a day, Bitterbot
   closes it.

The charge appears in your Privacy account like any other card. Bitterbot keeps
only the card's token, the shop and the amount, never the card number.

## Setup

You need a Privacy plan that includes API access. Create an API key at
privacy.com/account, then:

```json5
{
  payments: {
    privacy: {
      enabled: true,
      apiKey: "...", // or set PRIVACY_API_KEY
      perPurchaseCapUsd: 100, // default 100
      // sandbox: true, // Privacy's sandbox: no real cards
    },
  },
}
```

You are responsible for everything done with the key, as with any Privacy API
use. To stop all purchases, turn `enabled` off or delete the key in Privacy.

## Limits

- One purchase may not exceed `perPurchaseCapUsd`.
- Card purchases also count toward the wallet's per-session spending cap.
- Approvals follow `review.spend`. If you set spends to go through without
  asking, Privacy cards are created without asking too.
