# Aubaine: agent-coordinated group buying

Aubaine lets AI agents pool consumer demand into custom / made-to-order group
buys and settle them onchain in USDC on Base. Hundreds of buyers' agents form a
"flash syndicate" and strike a bulk deal with a manufacturer. It is an open,
vendor-neutral protocol (`aubaine/v1`); Bitterbot is the reference
implementation, but any agent framework can participate over plain HTTP.

The wedge is C2M (custom / made-to-order: mechanical-keyboard group buys, custom
PCBs, white-label production), not branded retail. That is where the discount
math actually works (no existing retail price, no MAP, no channel conflict) and
where long lead times make an always-on agent's patience genuinely useful.

## Status

The coordination layer is built and tested; it is **off by default**.

- Landed: SKU canonicalization, signed-envelope protocol, offer/intent
  directory, demand matcher, the clearinghouse service + HTTP surface, the
  `group_buy` agent tool, and commerce-scoped counterparty reputation.
- In progress: the non-custodial settlement money-path (EIP-3009 sign-at-strike)
  and the live gateway / gossip wiring. Settlement stays disabled until a legal
  review of the non-custodial and dispute-liability invariants completes.

## Enabling it

Aubaine is gated behind a config flag (default `false`):

```jsonc
{
  "commerce": {
    "groupbuy": {
      "enabled": true,
      "coordinatorFeeBps": 200,
    },
  },
}
```

`coordinatorFeeBps` is the coordinator fee on a settled syndicate, in basis
points (200 = 2%, the default).

## The `group_buy` agent tool

When enabled, the agent gets a `group_buy` tool with three actions:

- `list_offers` (requires `sku`): suppliers' current offers for a SKU.
- `list_syndicates` (requires `sku`): forming / active group buys for a SKU and
  their fill (`committed_qty` against `moq`).
- `register_intent` (requires `sku` or `spec_json`, `max_price_usdc`,
  `buyer_wallet`): registers a standing buy-intent. The agent joins a syndicate
  automatically once demand covers the supplier's minimum order quantity.
  Optional: `qty` (default 1), `lead_time_max_days`, `ttl_days` (default 30),
  `description`. Use `spec_json` to express demand for an item that has no offer
  yet; the tool canonicalizes the structured spec into a SKU.

## The clearinghouse HTTP surface

The agnostic surface (any agent, no libp2p, no Bitterbot binary) mounts under
`/aubaine`:

```text
POST /aubaine/intent       { signed intent envelope }   -> 202 { ok, matched }
POST /aubaine/offer        { signed offer envelope }     -> 202 { ok, matched }
GET  /aubaine/offers?sku=<sku_canonical>                 -> 200 [ offers ]
GET  /aubaine/syndicates?sku=<sku_canonical>             -> 200 [ syndicates ]
GET  /aubaine/events                                     -> SSE: syndicate_forming
```

The minimal participant needs only an Ed25519 keypair, an EIP-3009-capable EVM
wallet on Base, and HTTP.

## The open protocol

The wire format, JSON Schemas, `.well-known` descriptor, and runnable
conformance test vectors live in
[`docs/protocol/aubaine-v1`](../protocol/aubaine-v1/README.md). The TypeScript
implementation reproduces those vectors byte-for-byte (signed-envelope
signatures and SKU hashes), so an independent implementation can verify
interoperability.

## Design invariants

These are structural constraints, not policy notes:

- **Non-custodial.** The platform never holds pooled funds. Settlement relays
  signed buyer-to-supplier EIP-3009 authorizations; the coordinator is never the
  payee. Holding funds would trigger money-transmitter licensing.
- **No price coordination between buyers.** The matcher reads public offers and
  intents and optimizes one buyer's fill; it never circulates one buyer's price
  to another to standardize a price.
- **USDC-native, not card pre-auth.** Card holds expire in days; C2M lead times
  are weeks. Authorizations are signed at strike.
- **Brand authorization for any branded goods.** The C2M wedge sidesteps
  gray-market exposure by construction; do not drift into branded-retail
  arbitrage without authorized-reseller status.

## Architecture

| Module                               | Responsibility                                   |
| ------------------------------------ | ------------------------------------------------ |
| `src/commerce/sku.ts`                | SKU canonicalization (content hash + spec-lock)  |
| `src/commerce/envelope.ts`           | Ed25519 signing / verification / validation      |
| `src/commerce/directory.ts`          | Offer/intent directory over migration-v20 tables |
| `src/commerce/matcher.ts`            | Demand matching into syndicates                  |
| `src/commerce/clearinghouse.ts`      | Transport-agnostic ingest + match + events       |
| `src/commerce/clearinghouse-http.ts` | Express adapter (the HTTP surface)               |
| `src/agents/tools/group-buy-tool.ts` | The user-facing `group_buy` tool                 |
| `src/memory/peer-reputation.ts`      | `recordSettlementOutcome` (commerce trust)       |

The full design, phasing, and open questions are in
[`docs/plans/PLAN-26-SWARM-COMMERCE-C2M-COORDINATION.md`](../plans/PLAN-26-SWARM-COMMERCE-C2M-COORDINATION.md).
