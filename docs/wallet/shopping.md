---
summary: "Let the agent find products on a store and build a cart you pay for yourself"
read_when:
  - You want the agent to shop on a Shopify store
  - A store says it does not support agent shopping
title: "Shopping on stores"
---

# Shopping on stores

The `shop` tool lets the agent search a store, compare sizes, colors and prices,
and build a cart. It then sends you the store's own checkout link. You review
the cart and pay there, the same way you would if you had built it yourself.
The agent cannot pay through this tool, so it needs no approval and touches no
wallet or card.

It works on stores that support agent shopping through the Universal Commerce
Protocol, which includes most Shopify stores. Ask in plain words:

> Find me Allbirds tree runners in men's 9 and put a pair in a cart.

## What the agent can do

- **Search** a store by name or domain (`allbirds.com`).
- **Read a product's variants**: sizes, colors, price and whether each is in stock.
- **Build or change a cart** and give you its checkout link. Changing a cart
  replaces its contents, so the agent sends the full list each time.
- **Look at a cart** it built earlier.

Prices are shown in normal currency. Pass a country to get local prices.

## When a store does not support it

The agent says so and sends you the product page instead. To have the agent
complete the purchase itself, see [Card purchases with Link](/wallet/link-purchases).

## How the store knows it is talking to an agent

Each request names a public agent profile that the store reads. By default this
is the profile published in the Bitterbot repository. Stores rate-limit anonymous
agents, so heavy use may be slowed down.

## Settings

```json5
{
  shop: {
    enabled: true, // default
    // ucpProfileUrl: "https://example.com/my-agent-profile.json",
  },
}
```

The gateway only connects to the shopping endpoint a store's own `/.well-known/ucp`
file names, and only when that endpoint is on the store's own host or any
`myshopify.com` host. It refuses private and local addresses.
