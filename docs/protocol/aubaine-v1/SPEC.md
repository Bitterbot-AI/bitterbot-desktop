# Aubaine Protocol — v1 (DRAFT)

> **Protocol identifier:** `aubaine/v1` (name locked 2026-06-20).
> "Aubaine" (French: _a windfall / a great find_) — each syndicate member gets _une aubaine_.
> Collision-checked clear in crypto/web3/AI/software; the only existing "Aubaine" brands are in
> food/hospitality and wine (different trademark classes, coexistence feasible). Canonical home:
> **`aubaine.ai`** (acquired 2026-06-20). **Still pending before public launch:** a formal
> trademark clearance in classes 9/36/42 and social-handle registration. See
> `docs/plans/PLAN-26` §12.5.

An open, vendor-neutral protocol that lets AI agents from any framework pool consumer demand into
group buys and settle them onchain. Reference implementation: Bitterbot. **No part of this protocol
requires Bitterbot, libp2p, or a CDP wallet.** The minimal participant needs only: an Ed25519
keypair, an EIP-3009-capable EVM wallet on Base, and HTTP.

## 1. Roles

| Role            | Does                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **buyer**       | Broadcasts a signed **Intent** (what it wants, max price, qty, lead-time tolerance, signed mandate). At strike, signs EIP-3009 authorizations.                                                      |
| **supplier**    | Broadcasts a signed **Offer** (SKU, unit price at MOQ, lead time, A2A URL). Answers quote requests. Receives settled USDC directly.                                                                 |
| **coordinator** | Forms a syndicate when intents cover an offer's MOQ; drives the quote→commit→strike handshake; relays authorizations. Earns a coordination fee. **Never custodies funds.** Any node may coordinate. |

A single agent may hold multiple roles. A **clearinghouse node** is a coordinator that also exposes
the HTTP API (§6) and, optionally, bridges to a gossip transport.

## 2. Transport independence

Every protocol message is a **signed Envelope** (§3). The same Envelope is valid over any transport:

- **HTTP/A2A (agnostic surface, §6):** any agent POSTs Envelopes to a clearinghouse node and reads
  match events over SSE/webhook. JSON-RPC `aubaine/*` methods (§5) for the quote/commit handshake.
- **libp2p gossip (Bitterbot backbone):** Envelopes published on topics `aubaine/intents/v1`,
  `aubaine/offers/v1`. A clearinghouse node bridges gossip ↔ HTTP so both populations share one
  syndicate pool.

Conformance is defined at the Envelope + handshake level, never at the transport level.

## 3. Envelope

All messages share this wrapper:

```jsonc
{
  "protocol": "aubaine/v1",
  "type": "intent", // see §4
  "id": "b1c1...", // UUIDv4, unique per message
  "author_pubkey": "ed25519:9f8a...", // signer identity (see §3.2)
  "ts": 1718900000, // unix SECONDS, integer
  "body": {
    /* type-specific, §4 */
  },
  "signature": "ed25519-hex-128chars", // §3.1
}
```

### 3.1 Canonicalization & signing

1. Take the Envelope **without** the `signature` field.
2. Canonicalize with **JCS (RFC 8785)**: object keys sorted lexicographically by UTF-16 code unit,
   no insignificant whitespace, UTF-8, shortest-form numbers, no trailing zeros. (Reference
   implementations: `canonicalize` npm, `json-canonicalize`.)
3. Build the signing preimage: the ASCII bytes of the protocol id, a `\n` (0x0A), then the JCS bytes:
   `aubaine/v1\n<JCS>`.
4. Sign the preimage with **Ed25519**. `signature` = lowercase hex of the 64-byte signature.

A verifier recomputes the preimage and checks the signature against `author_pubkey`. The domain
prefix (`aubaine/v1\n`) is mandatory — it prevents signatures being replayed into other
protocols.

### 3.2 Identity

`author_pubkey` is `ed25519:<hex>` (32-byte raw public key, hex). Identity is "whoever holds the
key" — portable across frameworks, owned by no registry. Optional bindings (a participant MAY add,
a verifier MAY check, neither is required):

- `identity_proof.erc8004`: an onchain ERC-8004 identity id + a signature binding it to this pubkey.
- `identity_proof.did`: a DID + verifiable-credential proof.

Wallet address ≠ identity. The EVM wallet that signs settlement (§7) is named explicitly in the
Offer/commit; it need not equal the Ed25519 signer.

### 3.3 Validity rules (every receiver MUST enforce)

- `protocol` exactly `aubaine/v1`.
- `signature` verifies (§3.1).
- `ts` within ±300 s of receiver clock (replay/stale window). Receivers SHOULD dedupe on `id`.
- Serialized Envelope ≤ 256 KiB (gossip ceiling; HTTP nodes MUST also enforce it for parity).
- Unknown `body` fields are ignored (forward-compatible). Unknown `type` is rejected.

## 4. Message types & bodies

Full JSON Schemas in `schemas/`. Bodies (summary):

### 4.1 `intent` (buyer → broadcast) — `schemas/intent.schema.json`

```jsonc
{
  "sku_canonical": "sha256:7d8f...", // §8
  "sku_description": "GMK-style PBT keycap set, cherry profile, 'Nautilus' colorway v1",
  "max_price_usdc": 65.0,
  "qty": 1,
  "lead_time_max_days": 140,
  "expires_at": 1721492000,
  "mandate": {
    // signed standing authorization, §7.1
    "max_total_usdc": 65.0,
    "settlement": "eip3009",
    "buyer_wallet": "0xabc...", // where EIP-3009 auths will originate
    "chain": "base",
    "token": "usdc",
  },
}
```

### 4.2 `offer` (supplier → broadcast) — `schemas/offer.schema.json`

```jsonc
{
  "sku_canonical": "sha256:7d8f...",
  "sku_description": "...frozen full spec... (§8 spec-lock)",
  "unit_price_usdc": 38.0,
  "moq": 50,
  "lead_time_days": 84,
  "supplier_wallet": "0xfee...", // EIP-3009 recipient; the real payee
  "supplier_a2a_url": "https://supplier.example/a2a",
  "deposit_bps": 4000, // 40% captured at strike; rest at ship (§7)
  "expires_at": 1721492000,
}
```

### 4.3 `quote_request` / `quote_response` (A2A request/response) — `schemas/quote.schema.json`

Coordinator→supplier AND, mandatorily, buyer→supplier (independent re-verification, §7.2).
Request `{ sku_canonical, qty }`. Response is a **signed Envelope** from the supplier:
`{ sku_canonical, unit_price_usdc, moq, lead_time_days, supplier_wallet, deposit_bps, valid_until }`.

### 4.4 `commit_request` / `commit_response` — `schemas/commit.schema.json`

Coordinator→buyer: `{ syndicate_id, sku_canonical, unit_price_usdc, supplier_wallet, deposit_bps, strike_deadline }`.
Buyer→coordinator (after re-verification passes, §7.2):

```jsonc
{
  "syndicate_id": "...",
  "deposit_auth": {
    /* EIP-3009 transferWithAuthorization, §7.3 */
  },
  "balance_auth": {
    /* EIP-3009 transferWithAuthorization, §7.3 */
  },
  "reverified": true, // MUST be true; coordinator rejects otherwise
}
```

### 4.5 `settlement_receipt` (signed, portable) — `schemas/settlement-receipt.schema.json`

Emitted per settled member. The open, cross-system reputation primitive (§9):

```jsonc
{
  "syndicate_id": "...",
  "counterparty_pubkey": "ed25519:...", // the party being rated
  "role": "buyer", // role of counterparty
  "amount_usdc": 38.0,
  "outcome": "settled", // settled | disputed | defaulted
  "tx_hash": "0x...", // deposit-leg tx
  "ts": 1718900500,
}
```

The receipt is itself an Envelope signed by the _attesting_ party (`author_pubkey`); anyone can
verify it without trusting the issuer's infrastructure.

## 5. A2A JSON-RPC methods (handshake)

Standard A2A/JSON-RPC 2.0 over HTTP. Each `params` carries a signed Envelope.

| Method                  | Direction              | Envelope type                        |
| ----------------------- | ---------------------- | ------------------------------------ |
| `aubaine/quote`         | → supplier             | `quote_request` ⇒ `quote_response`   |
| `aubaine/commit`        | coordinator → buyer    | `commit_request` ⇒ `commit_response` |
| `aubaine/settle-notify` | coordinator → supplier | informs final filled qty + tx hashes |

## 6. Clearinghouse HTTP API (the agnostic surface)

A non-Bitterbot agent participates with only these:

```
POST /aubaine/intent        body: <Envelope type=intent>          -> 202 { intent_id }
POST /aubaine/offer         body: <Envelope type=offer>           -> 202 { offer_id }
GET  /aubaine/offers?sku=<sku_canonical>                          -> 200 [ <offer body + author> ]
GET  /aubaine/syndicates?sku=<sku_canonical>                      -> 200 [ { id, committed_qty, moq, unit_price_usdc, status } ]
GET  /aubaine/events    (text/event-stream)                       -> SSE: intent_matched | syndicate_forming | commit_requested | settled
POST /aubaine/webhook       body: { url }                         -> 201 { webhook_id }   (push alternative to SSE)
```

A node MUST reject any POSTed Envelope failing §3.3. A node SHOULD rate-limit per source. The A2A
methods (§5) are mounted on the same origin. This API plus §5 is the _complete_ surface a foreign
agent needs — no gossip, no Bitterbot code.

## 7. Settlement (non-custodial, EIP-3009)

### 7.1 Mandate

A buyer's Intent carries a signed `mandate` (the Envelope signature covers it). It is the
automated-agent authorization (UETA §14) and the evidentiary record that the agent acted within a
price cap. It does **not** move funds.

### 7.2 Mandatory independent re-verification (anti-front-running — protocol requirement)

Before signing any authorization in response to `aubaine/commit`, the buyer agent MUST itself call
`aubaine/quote` against the **supplier's own `supplier_a2a_url`** (taken from the Offer it saw, not
from the coordinator) and confirm `unit_price_usdc` and `supplier_wallet` match the commit request.
If they disagree, the buyer refuses to sign, sets `reverified:false` is **not** permitted (it simply
declines), and SHOULD emit a `settlement_receipt` with `outcome:"disputed"` naming the coordinator.
A coordinator MUST reject any `commit_response` with `reverified != true`. This closes coordinator
price front-running.

### 7.3 Two legs

Each committing buyer signs **two** EIP-3009 `transferWithAuthorization` messages, `buyer_wallet → supplier_wallet`:

- **deposit leg** = `round(unit_price_usdc * deposit_bps / 10000)`, short `validBefore`, captured at
  strike (gives the supplier real settled funds to commit tooling).
- **balance leg** = remainder, captured at the ship milestone.

`token` = Base USDC, `chain` = `base`. The authorization format and on-chain verification reuse the
x402 / EIP-3009 stack (recipient pinned to `supplier_wallet`, value checked, single-use replay ledger).

### 7.4 Strike atomicity

The coordinator marks the syndicate `striking` and captures deposit legs. Because N EIP-3009 captures
are **not atomic**, a conformant coordinator MUST use one of:

- **(a) confirm-then-capture:** collect ≥ MOQ valid signed deposit auths _before_ any on-chain
  capture; abort (capturing none) if the quorum of signatures is not reached.
- **(b) escrow contract:** route deposits through a non-custodial Base escrow that releases to the
  supplier only on ≥ MOQ and auto-refunds otherwise.

A coordinator MUST NOT capture deposits sequentially with no quorum guarantee (it would strand early
buyers with no refund path). The coordinator MUST never be the EIP-3009 recipient (non-custodial
invariant; recipient is always `supplier_wallet`).

## 8. SKU canonicalization

`sku_canonical` is the join key for matching. For custom/C2M goods (no universal identifier, specs
that drift during interest-check) the **primary** form is a content hash:

```
sku_canonical = "sha256:" + lowerhex( SHA-256( JCS( normalize(structured_spec) ) ) )
```

`normalize`: recursively trim and `toLowerCase()` all string values; drop null/empty fields; keep
numbers as-is. `JCS` per §3.1. Two intents match iff `sku_canonical` is byte-equal.

**Spec-lock:** an Offer freezes its `structured_spec` and publishes the resulting hash; intents match
the frozen hash. A spec change yields a _new_ `sku_canonical` (a new pool), never silent drift, so a
buyer who committed to "Nautilus v1" can never be settled into "v2". The full frozen spec rides in
`sku_description`.

**Branded alias (secondary, future):** `"brand:" + lower(trim(brand|model|variant))` for any later
expansion into branded goods. Out of scope for the C2M MVP.

See `test-vectors/sku-canonicalization.json` for worked examples.

## 9. Reputation (portable, optional)

Settlement emits signed `settlement_receipt` Envelopes (§4.5). They are the open, cross-system trust
primitive: any agent carries its receipts and presents them to any clearinghouse; anyone verifies
them without trusting the issuer. An implementation MAY fold receipts into its own trust model
(Bitterbot's EigenTrust does) and MAY mirror them onchain via ERC-8004 `giveFeedback`, but the
protocol requires neither. No participant is forced to run any specific reputation system.

## 10. Conformance

An implementation is **v1-conformant** iff it:

1. Produces and verifies Envelope signatures exactly per §3.1 (verify against
   `test-vectors/envelope-signing.json`).
2. Computes `sku_canonical` identically (verify against `test-vectors/sku-canonicalization.json`).
3. Enforces every §3.3 validity rule.
4. Implements the §6 HTTP surface **or** the gossip transport (a clearinghouse node MUST do HTTP).
5. For settlement: signs/verifies EIP-3009 legs per §7.3, enforces §7.2 re-verification, and uses a
   §7.4 atomicity strategy.
6. Never makes the coordinator/clearinghouse the settlement payee (§7.4).

Test vectors are generated by `tools/gen-test-vectors.mjs` (deterministic; run it to reproduce
`test-vectors/*.json` byte-for-byte).

## 11. Versioning

Breaking changes bump the `/vN` suffix in `protocol` and the gossip topics. Additive fields are
non-breaking (receivers ignore unknown fields). A node MAY support multiple versions concurrently;
the `protocol` field selects the handler.
