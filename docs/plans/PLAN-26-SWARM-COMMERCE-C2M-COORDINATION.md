# PLAN-26: Swarm Commerce / C2M Coordination Layer

**Status:** DRAFT (2026-06-20)
**Depends on:** A2A (PLAN-prior), wallet/x402 (Wallet #54), peer-reputation, mesh gossip, marketplace-economics escrow queue
**Schema:** migration v20 (current head v19)

## 0. Thesis and scope

Bitterbot already ships production payment rails (CDP MPC wallet, x402/EIP-3009 verification with replay ledger), an A2A task protocol, a libp2p gossip mesh, and a single-party escrow queue. What it does **not** have is the _coordination layer_ that turns isolated agents into a buyer syndicate: an offer/intent directory, a demand matcher, multi-party threshold settlement, and commerce-grade counterparty reputation. Those four primitives are this plan.

**Wedge: C2M / made-to-order, not branded retail.** External assessment (2026-06-20) established that the "pool demand, squeeze 20-40% off branded retail" model is fragile: GPU/camera channel margins (~5-10%) cannot absorb the discount, MAP policies and channel-conflict enforcement actively block it, and every dot-com demand-aggregator (Mercata, MobShop, LetsBuyIt) died on exactly these rocks. The economics only work where there is **no existing retail price, no MAP, no channel to protect**: custom/white-label production with minimum-order-quantity (MOQ) commitments and 8-16 week lead times (the mechanical-keyboard / custom-PCB group-buy model). Long lead times are a _feature_ here because agents have unbounded patience; humans flake.

This reframes two design constraints up front:

- **No card pre-auth.** Card authorization holds expire in 5-7 days (30 days only for lodging/rental MCCs). A 16-week C2M lead time is categorically outside card rails. Settlement is **USDC-native** via signed authorizations, captured at strike, not held.
- **Never custody funds (hard legal invariant).** Holding pooled buyer funds = money-transmitter licensing in ~50 states (felony exposure under 18 USC 1960) and, for USDC, a NY BitLicense. The platform must be structurally non-custodial: it relays signed buyer→supplier authorizations and is paid as an application fee on its own leg. See Section 6.

## 1. Architecture overview

```
 buyer agent A ┐                              ┌ supplier agent
 buyer agent B ┤ 1. broadcast INTENT          │
 buyer agent C ┤    (aubaine/intents/v1)    │ 2. broadcast OFFER
        ...    ┘         │                    │   (aubaine/offers/v1)
                         ▼                    ▼
                  ┌─────────────────────────────────┐
                  │  Directory  (local sqlite index) │  group_buy_offers
                  │  + optional vec0 SKU fuzzy match │  group_buy_intents
                  └───────────────┬─────────────────┘
                                  ▼
                  ┌─────────────────────────────────┐
                  │  Matcher: form syndicate when    │  group_buy_syndicates
                  │  N intents agree on SKU + price  │  group_buy_members
                  │  band + lead-time window         │
                  └───────────────┬─────────────────┘
                                  ▼  A2A aubaine/quote → aubaine/commit
                  ┌─────────────────────────────────┐
                  │  Threshold settlement (NON-      │  group_buy_settlements
                  │  CUSTODIAL): collect signed      │  (reuses x402_consumed_tx
                  │  EIP-3009 auths buyer→supplier;  │   replay ledger)
                  │  fire atomically on quorum+accept│
                  └───────────────┬─────────────────┘
                                  ▼
                  ┌─────────────────────────────────┐
                  │  Commerce reputation: settlement │  peer_reputation
                  │  outcome → trust edge + category │  (category="commerce")
                  └─────────────────────────────────┘
```

Everything below cites the real interfaces these primitives extend.

## 2. Primitive 1 — Offer/Intent Directory

### 2.1 What exists to build on

The `bitterbot/queries/v1` gossip topic is **fully wired** (not dormant): Rust `QUERIES_TOPIC` (`orchestrator/src/swarm/mod.rs:40`) → `IpcCommand::PublishQuery` (`mod.rs:1848`) → emit `query_received` (`mod.rs:2224`) → TS `OrchestratorBridge.publishQuery()` / `onQueryReceived()` (`src/infra/orchestrator-bridge.ts:537,603`) → consumer `skillNetworkBridge.handleQueryEvent()` (`src/memory/skill-network-bridge.ts:798`). The six-step "add a topic" pattern is established and reused below verbatim.

### 2.2 New gossip topics

Add two topics following the exact six-step pattern (const → SwarmHandle field → subscribe → SwarmEvent variant → `IpcCommand` publish handler → `emit_ipc_event` + bridge callback):

| Const           | String               | Envelope         |
| --------------- | -------------------- | ---------------- |
| `INTENTS_TOPIC` | `aubaine/intents/v1` | `IntentEnvelope` |
| `OFFERS_TOPIC`  | `aubaine/offers/v1`  | `OfferEnvelope`  |

Rust envelopes (mirror `QueryEnvelope` at `mod.rs:107`, all signed + timestamped, validated via `crypto::verify_*` + `security.validate_timestamp_secs`):

```rust
struct IntentEnvelope {
  intent_id: String,
  sku_canonical: String,      // normalized SKU/product key (see 2.4)
  sku_description: String,     // human text for fuzzy match
  max_price_usdc: f64,
  qty: u32,
  lead_time_max_days: u32,     // C2M: buyer tolerance, e.g. 112 (16wk)
  expires_at: u64,
  author_peer_id: String, author_pubkey: String, signature: String, timestamp: u64,
}
struct OfferEnvelope {
  offer_id: String,
  sku_canonical: String, sku_description: String,
  unit_price_usdc: f64,        // price at stated MOQ
  moq: u32,                    // minimum order quantity to strike
  lead_time_days: u32,
  supplier_a2a_url: String,    // where to negotiate (aubaine/quote)
  expires_at: u64,
  author_peer_id: String, author_pubkey: String, signature: String, timestamp: u64,
}
```

Respect `MAX_GOSSIPSUB_MSG_SIZE = 256*1024` (`mod.rs:43`).

### 2.3 Local directory index (migration v20)

Append to `MIGRATIONS` in `src/memory/migrations.ts` (follow v18 at `:718`; runs atomically in BEGIN/COMMIT per the runner at `:807`). Conventions: TEXT UUID PK, integer ms-epoch `created_at`/`updated_at`, snake_case, JSON as `*_json TEXT DEFAULT '{}'`.

```sql
CREATE TABLE IF NOT EXISTS group_buy_offers (
  id TEXT PRIMARY KEY,
  sku_canonical TEXT NOT NULL,
  sku_description TEXT NOT NULL,
  unit_price_usdc REAL NOT NULL,
  moq INTEGER NOT NULL,
  lead_time_days INTEGER NOT NULL,
  supplier_peer_id TEXT NOT NULL,
  supplier_pubkey TEXT NOT NULL,
  supplier_a2a_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gbo_sku ON group_buy_offers(sku_canonical, expires_at);

CREATE TABLE IF NOT EXISTS group_buy_intents (
  id TEXT PRIMARY KEY,
  sku_canonical TEXT NOT NULL,
  sku_description TEXT NOT NULL,
  max_price_usdc REAL NOT NULL,
  qty INTEGER NOT NULL,
  lead_time_max_days INTEGER NOT NULL,
  buyer_peer_id TEXT NOT NULL,
  buyer_pubkey TEXT NOT NULL,
  is_local INTEGER NOT NULL DEFAULT 0,   -- this node's own standing intent
  mandate_json TEXT DEFAULT '{}',         -- signed standing mandate (see 4.2)
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gbi_sku ON group_buy_intents(sku_canonical, expires_at);
```

Optional fuzzy SKU match reuses the vec0 path (`VECTOR_TABLE` pattern, `manager-embedding-ops.ts:28`; `CREATE VIRTUAL TABLE ... USING vec0`, `manager-sync-ops.ts:155`) over `sku_description` embeddings. Defer to Phase 2; exact `sku_canonical` match covers the C2M case (passionate buyers converge on precise SKUs).

### 2.4 SKU canonicalization

C2M items lack universal identifiers, and truly custom goods have **no brand/model at all** plus specs that _mutate during the interest-check phase_ (colors added, materials swapped). So the **primary** path is a content hash of a structured spec, not a brand string:

```ts
// src/commerce/sku.ts
canonicalizeSku(spec: StructuredSpec): string   // -> sha256 of normalized canonical-JSON spec
// StructuredSpec = ordered, normalized {category, attributes:{k:v}, ...}; keys sorted, values lowercased/trimmed
```

- **Custom/C2M (primary):** `sku_canonical = hash(normalize(structuredSpec))`. Two intents match iff their specs hash-equal.
- **Branded (secondary, future):** `lowercase(trim(brand|model|variant))` as a convenience alias for any later expansion into branded goods.

**Spec-lock at offer time (critical).** Because custom specs evolve, an offer **freezes** its `StructuredSpec` and publishes the resulting hash; intents match against the _frozen_ hash. Spec changes during interest-check produce a _new_ `sku_canonical` (a new pool), not silent drift in an existing one. This prevents the failure where a buyer committed to "blue v1" gets settled into "blue v2." The full frozen spec travels in `sku_description` (within the 256KB gossip cap) so agents can show users exactly what they are committing to.

Get this key wrong and the pools fragment (the Zwirl two-sided cold-start failure mode); allow it to drift mid-pool and you settle buyers into a product they did not agree to.

### 2.5 New TS module `src/commerce/directory.ts`

```ts
class GroupBuyDirectory {
  constructor(db: DatabaseSync, bridge: OrchestratorBridge) {}
  publishIntent(i: LocalIntent): void; // signs + publishQuery-style broadcast on intents/v1
  publishOffer(o: LocalOffer): void; // broadcast on offers/v1
  handleIntentEvent(e: IntentEnvelope): void; // validate, upsert group_buy_intents
  handleOfferEvent(e: OfferEnvelope): void; // validate, upsert group_buy_offers
  findOffers(skuCanonical: string): OfferRow[]; // fresh, non-expired
  findIntents(skuCanonical: string): IntentRow[];
  pruneExpired(now: number): number;
}
```

Wire callbacks in `src/gateway/server-startup.ts` next to the existing `onQueryReceived` wiring (`:347`): `bridge.onIntentReceived(e => directory.handleIntentEvent(e))` and `onOfferReceived(...)`.

## 3. Primitive 2 — Demand-Matching Engine

### 3.1 Trigger

On each new intent or offer (and on a periodic sweep), the matcher asks: for `sku_canonical`, is there an offer whose `moq` is covered by the sum of `qty` across intents that satisfy `intent.max_price_usdc >= offer.unit_price_usdc` and `intent.lead_time_max_days >= offer.lead_time_days` and not expired? If yes, form a **syndicate**.

### 3.2 Schema (same migration v20)

```sql
CREATE TABLE IF NOT EXISTS group_buy_syndicates (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  sku_canonical TEXT NOT NULL,
  unit_price_usdc REAL NOT NULL,
  moq INTEGER NOT NULL,
  committed_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'forming',  -- forming|quoting|committing|striking|settled|failed|expired
  supplier_pubkey TEXT NOT NULL,
  supplier_a2a_url TEXT NOT NULL,
  coordinator_peer_id TEXT NOT NULL,        -- node that formed it (earns fee)
  strike_deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_buy_members (
  id TEXT PRIMARY KEY,
  syndicate_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  buyer_pubkey TEXT NOT NULL,
  buyer_peer_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  amount_usdc REAL NOT NULL,                -- qty * unit_price
  commit_status TEXT NOT NULL DEFAULT 'invited', -- invited|committed|declined|settled|failed
  auth_token TEXT,                          -- signed EIP-3009 authorization (Phase commit)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gbm_syndicate ON group_buy_members(syndicate_id, commit_status);
```

### 3.3 New TS module `src/commerce/matcher.ts`

```ts
class DemandMatcher {
  evaluate(skuCanonical: string): SyndicateRow | null; // forms + persists if MOQ coverable
  onIntent(e): void; // called by directory after upsert
  onOffer(e): void;
  sweep(now: number): void; // periodic, also expires stale 'forming' syndicates
}
```

Coordinator selection: the node whose evaluate() first crosses MOQ becomes `coordinator_peer_id` and drives the A2A handshake. This is the fee-earning role (Section 6.3). Antitrust invariant (Section 6.1): the matcher optimizes a _single buyer's_ fill against supplier offers; it must **never** circulate one buyer's price/intent to another buyer to coordinate a common price. Offers and intents are public broadcasts; the matcher reads them but produces no shared-price signal back to competitors. This keeps it on the lawful side of the RealPage line.

## 4. Primitive 3 — Threshold Settlement (non-custodial)

### 4.1 What exists to build on

`marketplace-economics.ts` already does the _fan-out_ half: `computeRevenueShares()` (`:325`) produces an N-recipient split, `queueRevenuePayment()` (`:615`) enqueues one row per recipient into `revenue_payment_queue` (state machine `held -> released -> paid`, schema `:126`), and `dispatchReleasedPayments()` (`manager.ts:3452`) pays N recipients per tick via `wallet.sendUsdc()`. The replay-safe single-use ledger `x402_consumed_tx` + `claimTxHashAtomically()` (`x402-verify.ts:44`) prevents double-spend. The missing half is **many-buyers -> one-supplier with a quorum gate**, and doing it **without the platform ever holding funds**.

### 4.2 Non-custodial model (primary)

Each buyer agent holds a **standing mandate** (stored `group_buy_intents.mandate_json`): a signed statement "my wallet will pay up to `max_price_usdc` for `sku_canonical` if matched, valid until `expires_at`." This satisfies UETA s.14 automated-contract formation and supplies the AP2-style "intent mandate" evidentiary record (Section 6.4).

At **strike** (quorum reached + supplier accepts via A2A), each member agent produces the actual on-chain authorization itself:

1. Coordinator sends `aubaine/commit` (A2A) to each member with the resolved supplier address + final unit price.
2. **Mandatory independent re-verification (anti-front-running, protocol requirement not best-practice).** Before signing, each member agent MUST independently call `aubaine/quote` against the supplier's own A2A URL (from the offer it saw, not a URL handed over by the coordinator) and confirm the unit price + supplier address match what the coordinator relayed. This closes the coordinator front-running hole (coordinator learns the real supplier price, inflates it to members under their max, pockets the spread). A member whose independent quote disagrees with the coordinator's claim refuses to sign and flags the coordinator (commerce-reputation negative event). The implementation rejects any commit where re-verification was skipped.
3. Each member agent then validates against its own mandate (SKU hash match, `price <= max_price`, not expired), and signs **two** EIP-3009 `transferWithAuthorization` legs buyer-wallet → supplier-address (short `validBefore`): a **deposit leg** (e.g. 30-50% of `amount_usdc`) and a **balance leg** (remainder). Returns both signed auths as `group_buy_members.auth_token`.
4. The platform/coordinator **relays** authorizations; it never holds funds. At strike the **deposit leg is captured immediately on-chain** (real USDC moves buyer → supplier) so the supplier has credible, settled funds to commit tooling against — not a revocable promise from an agent with no legal identity (Open Q3). The **balance leg** is captured at the ship milestone. Each capture verifies via `verifyX402Payment` (`x402-verify.ts:86`, recipient pinned to supplier, recorded in `x402_consumed_tx`).
5. Atomicity: mark the syndicate `striking`; only flip `settled` when >= MOQ deposit legs confirm on-chain. Members whose deposit fails capture -> `commit_status='failed'`, supplier informed of final filled qty (may fall below MOQ -> supplier's call to proceed or abort; only deposits were captured, and a failed strike refunds nothing because successful captures already moved buyer→supplier — so the deposit %% should be sized to what a buyer accepts losing if the run is cancelled, or escrowed via 4.3 if the supplier/buyers want refundability).

Why EIP-3009 and not a pre-signed authorization at intent time: `transferWithAuthorization` fixes the recipient at signing, and the supplier is unknown at intent time. So the binding signature is produced at _commit_, when the supplier is known. The buyer agent being always-on (this is the whole bitterbot premise) makes a short commit window viable where human group-buys flake.

**Capital-efficiency note:** the balance leg is not locked during the 8-16 week lead time; it is signed at strike and captured only at the ship milestone. The deposit leg captures at strike. This is strictly better than the "$200k locked for 21 days" premise, which the rails cannot support anyway.

**Atomicity caveat (honest limitation of the pure-relay model).** N sequential EIP-3009 captures are _not_ atomic: if the coordinator captures deposits buyer-by-buyer and quorum fails partway, early buyers' deposits have already moved buyer→supplier with **no native refund**. Two ways to handle it, pick per design-partner:

- **(a) Confirm-then-capture:** collect all >= MOQ _signed_ deposit auths first (cheap, off-chain), and only begin on-chain capture once quorum of signatures is in hand. This shrinks but does not eliminate the window (a signed auth can still fail capture if the buyer wallet emptied). Good enough for trusted early pools.
- **(b) Escrow contract (4.3) pulled forward:** if buyers require refund-on-failed-strike, the non-custodial escrow contract is the only clean way to get all-or-nothing + refundability. This trades the "no new on-chain code" benefit for real atomicity. **Decide at the first design-partner conversation (Open Q3) — it may move 4.3 from Phase 5 into Phase 3.**

### 4.3 Smart-contract escrow (alternative, Phase 3)

If a supplier demands guaranteed funds before committing tooling, the fallback is a **non-custodial escrow contract** on Base: buyers deposit USDC; the contract releases to supplier only on coordinator+quorum signature, else refunds after `strike_deadline`. Non-custodial = no admin key can redirect funds (fact-sensitive; legal review required, Section 6.2). This is new on-chain work (contract + audit) and deliberately deferred until a supplier actually requires it.

### 4.4 Schema (same migration v20)

```sql
CREATE TABLE IF NOT EXISTS group_buy_settlements (
  id TEXT PRIMARY KEY,
  syndicate_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  buyer_pubkey TEXT NOT NULL,
  supplier_address TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  auth_token TEXT,                 -- signed EIP-3009
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|authorized|settled|failed|refunded
  error TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gbs_syndicate ON group_buy_settlements(syndicate_id, status);
```

### 4.5 New TS module `src/commerce/settlement.ts`

```ts
class ThresholdSettlement {
  requestCommit(syndicateId: string): Promise<void>; // A2A aubaine/commit fan-out to members
  recordAuthorization(memberId: string, authToken: string): void;
  strike(syndicateId: string): Promise<StrikeResult>; // execute auths once >= MOQ confirmed
  // reuses verifyX402Payment + claimTxHashAtomically for each leg
}
```

## 5. A2A handshake + capability advertisement

### 5.1 New methods

A2A method dispatch is a switch in `src/gateway/a2a/server.ts:23`. Add a `aubaine/*` namespace alongside `message/send`:

- `aubaine/quote` — coordinator -> supplier: "syndicate of N units for `sku_canonical` at/above your offer; confirm unit price, MOQ, lead time, deposit schedule." Supplier returns a firm quote.
- `aubaine/commit` — coordinator -> each member: resolved supplier address + final price. Member MUST independently re-issue `aubaine/quote` to the supplier's own URL to confirm price/address (Section 4.2 step 2) before returning its signed EIP-3009 deposit+balance auths (`A2aDataPart`, `types.ts:109`, the structured carrier). Commit is rejected if re-verification did not occur.
- `aubaine/settle-notify` — coordinator -> supplier: final filled qty + settlement tx hashes.

Structured payloads ride `A2aDataPart = { type: "data"; data: {...} }` rather than text parts.

### 5.2 Capability extension

Advertise support in the agent card via a new `extensions["aubaine"]` block (`buildAgentCard`, `agent-card.ts:16`; extensions assembled `:52-127`, alongside existing `x402-payment`/`bitterbot-mesh`/`erc8004`):

```jsonc
"aubaine": {
  "role": "buyer" | "supplier" | "coordinator",
  "topics": ["aubaine/intents/v1", "aubaine/offers/v1"],
  "methods": ["aubaine/quote", "aubaine/commit", "aubaine/settle-notify"],
  "settlement": "eip3009"
}
```

This keeps the protocol **scaffolding-agnostic**: any A2A agent can advertise the extension and participate; bitterbot agents get the wallet + mesh + reputation for free.

### 5.3 Supplier on-ramp — the B2B cold-start bottleneck (MVP-critical)

The whole plan assumes a supplier exposes an A2A URL that speaks `aubaine/quote`. **No custom factory does this today.** Shenzhen/Taiwan makers and the boutique vendors who front them (keyboard group-buy runners, PCB houses) speak email, WeChat, Alibaba, and spreadsheets. If we wait for suppliers to adopt A2A, the supply side never lights up and the directory is a graveyard (the Zwirl two-sided cold-start, again — this time on the supply leg).

So the MVP needs a **Supplier Gateway**: a Bitterbot-hosted (or team-operated) adapter that _impersonates_ the supplier on the mesh until real suppliers adopt the protocol. This is the supply-side "Wizard of Oz" — deliberately not-yet-scaled, and called out as such (house rule: no silent stubs).

```
factory (email/WeChat/Alibaba quote)
        │  human or headless-browser agent enters/normalizes the quote
        ▼
  Supplier Gateway  (src/commerce/supplier-gateway.ts, runs as a node)
        │  - signs OfferEnvelope on aubaine/offers/v1
        │  - answers aubaine/quote with the entered firm quote
        │  - on strike, receives settled USDC to the SUPPLIER's own wallet
        │    (gateway is a relay/translator, NOT a fund custodian — see invariant 2)
        ▼
  mesh: behaves like any other supplier agent
```

Design constraints:

- The gateway publishes offers and answers quotes, but **settlement still flows buyer → supplier wallet directly** via EIP-3009. The gateway must never be the payee, or it re-creates the money-transmitter problem we designed out (invariant 2). The supplier's real wallet address is what goes into the OfferEnvelope and the EIP-3009 recipient.
- The independent member re-verification (4.2 step 2) points at the _gateway's_ `aubaine/quote`; since the gateway is the supplier's authorized voice in the MVP, this is consistent. When the real factory adopts A2A later, the gateway is removed and members re-verify against the factory directly — no protocol change.
- A headless-browser/email-ingest agent can automate the quote-entry over time, but cohort 1 is fine with a human operator pasting the factory's emailed quote. Honest labeling: this is manual until it isn't.

This also answers "who runs the first OfferEnvelopes": we do, on behalf of one vetted manufacturing partner, until the loop is proven.

## 6. Legal design invariants (baked into the code, not optional)

These are constraints the implementation must structurally enforce. A payments lawyer review is load-bearing where flagged.

1. **No price coordination among buyers (antitrust / RealPage).** The matcher reads public offers/intents and optimizes one buyer's fill; it must never feed one buyer's price back to another to standardize prices. Consumers-only by default (consumers are not competitors, so per-se buyer-cartel theories do not fit). If business/reseller buyers are ever admitted, hard-segregate them (a horizontal "rim" among competing resellers is the hub-and-spoke trip-wire). **Withdrawn GPO safe-harbors** (DOJ/FTC 2023-2024) mean the old 35%/20% thresholds are benchmarks, not shields; keep contemporaneous procompetitive-rationale docs.
2. **Never custody funds (money transmission).** Non-custodial relay of buyer->supplier EIP-3009 authorizations only. The platform is paid as an application fee on its own A2A leg, not by holding and forwarding pooled funds. Custodial USDC additionally triggers NY BitLicense. The "pooled pre-authorized funds = stored value" characterization is the make-or-break legal question and **needs payments counsel** before any pooling-of-funds variant ships. Smart-contract escrow (4.3) only if genuinely non-custodial (no redirect key).
3. **USDC-native settlement, not card pre-auth.** Card holds cannot span C2M lead times; do not promise "guaranteed funds locked for weeks." Authorizations are signed at strike.
4. **Agent authority (mandates) + chargeback reality.** Standing mandates (4.2) give UETA s.14 binding formation + AP2-style evidentiary intent, with a max-price cap satisfying UETA s.10 error-correction. But statutory chargeback/dispute rights (Reg Z/E) survive any mandate; budget operationally for disputed losses landing on the coordinator. **Consumer-finance counsel** for the dispute mapping.
5. **Supplier-side: brand authorization for any branded goods.** Gray-market/Lanham material-difference exposure (no-warranty dropship) lands on the _platform_, traced by serial code regardless of price privacy. The C2M wedge sidesteps this (no brand, no MAP, no channel) which is precisely why it is the chosen wedge. Do not drift into branded-retail arbitrage without authorized-reseller status.

## 7. Primitive 4 — Commerce-grade counterparty reputation

### 7.1 What exists to build on

`PeerReputationManager` (`src/memory/peer-reputation.ts`) already scores skill-sharing peers via EigenTrust over `peer_trust_edges`. The canonical "outcome -> trust" wrapper is `recordSkillExecutionVerification(authorPubkey, category, success, rewardScore)` (`:1003`), which maps an outcome to an edge weight and calls `recordTrustEdge("local", trustee, weight)` (`:524`, EMA alpha=0.3) plus `recordCategoryTrust(pubkey, category, success, quality)` (`:934`, per-category EMA). Category-scoped scores let "commerce" trust live without polluting the global skill-trust signal.

### 7.2 New method

Add alongside `recordSkillExecutionVerification` (do not overload it):

```ts
recordSettlementOutcome(
  counterpartyPubkey: string,
  role: "buyer" | "supplier",
  outcome: "settled" | "disputed" | "defaulted",
  amountUsdc: number,
): void
```

Maps outcome -> weight in [0,1] (e.g. `settled` -> `0.5 + min(amount/CAP, 0.5)*0.5`; `defaulted` -> `0.2`; `disputed` -> `0.35`), calls `recordTrustEdge("local", counterpartyPubkey, weight)` for the global signal, `recordCategoryTrust(counterpartyPubkey, "commerce", settled, quality)` for the domain score, and logs an activity row (`settlement_paid`/`settlement_defaulted`) for anomaly detection. The settlement modules already resolve counterparties by pubkey or peer_id (`resolvePeerWalletAddress`, `marketplace-economics.ts:710`), so events line up with existing reputation rows.

### 7.3 Use in matching

`DemandMatcher` and `ThresholdSettlement` gate participation on `getCategoryReputation(pubkey, "commerce")` (`:983`) and `isBanned()` (`:76`): defaulting buyers and non-delivering suppliers decay out of future syndicates. This is the moat the assessment identified: proprietary, settlement-grounded counterparty trust that a fresh competitor cannot replicate. (ERC-8004 onchain feedback writes remain a separate, optional public-attestation layer; today they are a read-only prototype and are out of scope here.)

## 8. Build phases

Each phase ships wired + active-by-default + tested + documented in the same commit (house rule).

- **Phase 0 — SKU + schema. [LANDED 2026-06-20]** `src/commerce/sku.ts` (canonicalizer pinned to the protocol conformance vectors via `sku.test.ts`), `src/commerce/feature.ts` (the `isAubaineEnabled` gate), migration v20 (the 5 tables: offers/intents/syndicates/members/settlements), feature flag `commerce.groupbuy.enabled` (`src/config/types.commerce.ts` + zod, default off). Tests green: `sku.test.ts` (6), `migrations.v20.test.ts` (3).
- **Phase 1 — Directory + matcher + agent tool + clearinghouse HTTP.**
  - **[LANDED 2026-06-20] Core logic:** `src/commerce/envelope.ts` (Ed25519 sign/verify/validate over the JCS preimage, reproduces the conformance vectors), `src/commerce/directory.ts` (`GroupBuyDirectory`: ingest validated offer/intent envelopes, upsert by (pubkey,sku), find, prune), `src/commerce/matcher.ts` (`DemandMatcher`: form a syndicate when intents cover MOQ within price + lead-time, idempotent, no-price-leak). Tests green: `envelope.test.ts` (7), `directory.test.ts` (9, incl. tamper/expiry/wrong-type rejection + matcher coverage/idempotency). Lint clean.
  - **[LANDED 2026-06-20] Transport core + UX:** `src/commerce/clearinghouse.ts` (`ClearinghouseService` — transport-agnostic ingest+match+subscribe), `src/commerce/clearinghouse-http.ts` (Express router for the agnostic HTTP surface, §12.3 routes), `src/agents/tools/group-buy-tool.ts` (the user-facing `group_buy` tool: list_offers / list_syndicates / register_intent, demand-first via spec_json, gated on `isAubaineEnabled` + wired service+signer). Tests green: `clearinghouse.test.ts` (4), `group-buy-tool.test.ts` (5).
  - **[TODO] Live integration:** mount the clearinghouse router on the gateway Express app (gated), and the two Rust gossip topics (six-step x2) + `bridge.ts` HTTP↔gossip sync.
- **Phase 2 — Matcher.** `matcher.ts`, syndicate formation, coordinator election, expiry sweep. Tests: MOQ coverage math, price/lead-time filtering, no-price-leak invariant assertion.
- **Phase 3 — Settlement (non-custodial). [ORCHESTRATION LANDED 2026-06-20]** `src/commerce/settlement.ts`: `buildCommitResponse` (member side — mandatory independent re-verification against the supplier's own quote, mandate-cap enforcement, two-leg EIP-3009 deposit+balance signing) and `ThresholdSettlement` (coordinator side — rejects un-re-verified commits, confirm-then-capture that captures nothing under MOQ, per-leg capture, feeds `recordSettlementOutcome`). On-chain signing/capture/quote behind injected interfaces (`Eip3009Signer`, `SettlementExecutor`, `QuoteProvider`) so it is unit-tested with fakes (`settlement.test.ts`, 7) and carries no wallet dependency. **[TODO] adapters + wiring:** real `Eip3009Signer`/`SettlementExecutor` over the CDP/viem wallet + x402 verify, the `aubaine/quote|commit|settle-notify` A2A methods, `supplier-gateway.ts`, signed `settlement_receipt` emission, and the cohort-1 details below. Stays disabled until legal review.
- **Phase 3 (cont.) — Supplier Gateway + cohort-1 mode.** `settlement.ts`, `supplier-gateway.ts` (5.3), A2A `aubaine/quote|commit|settle-notify`, agent-card extension, EIP-3009 sign-at-strike (deposit+balance legs), mandatory member re-verification (4.2 step 2), **confirm-then-capture** atomicity (4.2 option a), reuse `verifyX402Payment` + replay ledger. Run the first real syndicate with **one vetted manufacturing partner** + a small trusted buyer cohort, where the partner contractually agrees to refund a failed strike (covers the residual atomicity gap without solidity work). Tests: commit fan-out, re-verification-required rejection, partial-fill below MOQ, double-spend rejection, mandate-cap rejection. **Gate: legal review (invariants 1,2,4) before default-on.**
- **Phase 4 — Reputation. [LANDED 2026-06-20]** `PeerReputationManager.recordSettlementOutcome(counterparty, role, outcome, amount)` (`src/memory/peer-reputation.ts`) — maps settled/disputed/defaulted to a trust-edge weight + a `commerce`-category EMA + a role-tagged activity event, mirroring `recordSkillExecutionVerification` without polluting skill trust. Tests green: `peer-reputation.settlement.test.ts` (6: weight mapping, amount scaling, category isolation, activity log). [TODO] gate matcher on commerce score + ban list (wires in once settlement emits receipts in Phase 3).
- **Phase 5 — Smart-contract escrow (GA gate, not optional at scale) + vec0 fuzzy SKU.** The non-custodial Base escrow contract (4.3) for absolute all-or-nothing + auto-refund. This is the **gate to opening beyond vetted suppliers**: confirm-then-capture relies on supplier goodwill for refunds, which is acceptable for a trusted cohort-1 partner but not for untrusted/open supply. Build + audit it before GA. vec0 fuzzy SKU if exact hash-match proves too brittle.

## 9. New files / touch list

New: `src/commerce/{sku,directory,matcher,settlement}.ts`, `src/commerce/reputation-commerce.ts` (or extend `peer-reputation.ts`), `docs/commerce/groupbuy.md`.
Migration: append v20 to `src/memory/migrations.ts`.
Rust: `orchestrator/src/swarm/mod.rs` (2 topics, full six-step each).
Bridge: `src/infra/orchestrator-bridge.ts` (publish/on\* for intents+offers).
A2A: `src/gateway/a2a/server.ts` (3 methods), `agent-card.ts` (extension).
Wiring: `src/gateway/server-startup.ts` (callbacks + matcher sweep interval).
Tools (Phase 1, the primary user surface): `src/agents/tools/group-buy-tool.ts` mirroring `wallet-tool.ts` for "register intent / list offers / show syndicate fill / opt in".

## 10. Open questions for review

1. ~~Coordinator trust~~ **RESOLVED into a protocol requirement (Section 4.2 step 2 / 5.1):** mandatory independent member re-verification via `aubaine/quote` to the supplier's own URL before signing; commit rejected without it; disagreement -> coordinator flagged in commerce reputation. Remaining: a threat-model pass on the residual (e.g. coordinator censoring/withholding members, or colluding with a fake supplier) before Phase 3 default-on.
2. Sybil intents inflating MOQ: a fake-buyer flood could trick a supplier into tooling up. Mitigation: only **signed deposit auths** count toward MOQ at strike (intents are non-binding), the deposit is real captured USDC (costly to fake), plus commerce-reputation gating on members.
3. **The central business risk (per design-partner).** Is a deposit from agents with no legal identity credible enough for a factory to spend ~$50K on tooling? Working assumption: suppliers want **30-50% deposit captured (not merely authorized) at strike** (Section 4.2 step 4), with the balance leg captured at ship. Open within this: refund-on-failed-strike. Pure relay can't do atomic all-or-nothing -> if buyers demand refundability, pull the escrow contract (4.3) forward into Phase 3. **Decide in the first supplier + first buyer-community conversation (mechanical keyboards / custom PCBs).**
4. Jurisdiction of the non-custodial relay claim, and whether immediate deposit capture changes the agent-of-payee analysis — confirm with payments counsel before Phase 3 default-on.
5. **Supplier on-ramp (5.3).** No factory speaks A2A yet; cohort-1 supply comes through a team-operated Supplier Gateway translating emailed quotes into signed OfferEnvelopes. The gateway must remain a translator, never a payee (invariant 2). Open: how much of the email/WeChat/Alibaba quote ingestion to automate (headless-browser agent) vs. keep manual for the first cohort. Manual is fine to start; label it honestly.

## 11. Recommended sequencing (the escrow-timing decision)

Both reviewing agents and this analysis converge: do **not** build the smart-contract escrow first. Sequence:

1. **Cohort 1 = confirm-then-capture with one vetted partner** (Phase 3). Pick a known-reputable maker in a tight community (mechanical keyboards: an established vendor/runner; or a custom-PCB house) and a small trusted buyer pool. The partner contractually agrees to refund a failed strike. This validates the entire loop (directory → match → quote → re-verify → commit → settle → reputation) with **zero new on-chain code** and teaches us what suppliers actually require (deposit %, refund terms, lead-time realities). The real MVP risk is two-sided cold-start, not refund atomicity — a small trusted cohort makes atomicity a non-issue.
2. **Build the audited escrow contract before opening to untrusted/open supply** (Phase 5, the GA gate). Once demand is proven and we know the deposit/refund shape suppliers want, the immutable auto-refund contract is worth the solidity + audit + legal-review cost — and it's _required_ the moment suppliers aren't hand-vetted, because community trust in these spaces is fragile and one bad refund poisons the well.

Rationale: building audited solidity before proving suppliers will even participate is premature optimization against the wrong risk. The contract is the scaling unlock, not the MVP unlock.

## 12. Scaffolding-agnostic participation (the open-protocol boundary)

The strategy is "open protocol, bitterbot as reference implementation and liquidity backbone" — own the tollbooth, not a walled garden. That only holds if a non-bitterbot agent (Claude, GPT, LangChain, CrewAI, a bare script) can fully participate. As drafted, three pieces are accidentally bitterbot-only and must be moved behind an open boundary: the **libp2p gossip transport** (foreign agents aren't on the mesh), the **CDP wallet** (they have their own signer), and **EigenTrust reputation** (internal). Fix = separate three layers the rest of this doc conflates.

### 12.1 Three layers

1. **Protocol (open, neutral-named, versioned).** Signed envelope schemas (Intent/Offer/Quote/Commit/SettlementReceipt), SKU canonicalization (2.4), the quote→commit→strike state machine, EIP-3009 settlement binding. Transport-independent; every message is a signed JSON envelope (`author_pubkey` + `signature`) that _anyone_ can verify without bitterbot code. Published as JSON Schemas + a `.well-known/aubaine.json` descriptor + an A2A extension definition + reference test vectors for conformance.
2. **Transport (pluggable).** libp2p gossip is _one_ transport (bitterbot's decentralized backbone). The agnostic transport is **HTTP/A2A JSON-RPC against a clearinghouse node** + SSE/webhook for match events. A **bridge** mirrors HTTP-submitted intents/offers into the gossip pool and gossiped ones back out, so HTTP and mesh participants share one syndicate pool.
3. **Reference implementation (bitterbot, privileged not required).** CDP wallet, EigenTrust, mesh, agent-tool UX. The best client, not the only client.

### 12.2 Minimal participation contract (nothing bitterbot-specific)

Any agent participates with exactly:

- **Any keypair** (Ed25519/secp256k1/DID) to sign envelopes. Identity = whoever holds the key; ERC-8004 onchain identity is an optional upgrade, not a requirement.
- **Any EIP-3009-capable EVM wallet** on Base USDC (MetaMask/Privy/viem/Coinbase/...). The verifier (`verifyX402Payment`, `x402-verify.ts:86`) is already signer-agnostic — it checks the on-chain transfer + signature, not the wallet brand. Spec MUST state settlement = EIP-3009/x402, any signer; CDP is merely bitterbot's signer.
- **HTTP**: POST a signed intent/offer to any clearinghouse node, receive match events (poll or webhook), and answer the `aubaine/quote`/`commit` handshake including the mandatory independent re-verify (4.2 step 2). No libp2p, no CDP, no bitterbot binary.

### 12.3 The clearinghouse HTTP API (the agnostic surface)

A new `src/commerce/clearinghouse-http.ts` (mounted on the gateway, reachable on the relay fleet) exposes, alongside the existing A2A JSON-RPC:

```
POST /aubaine/intent      { signed IntentEnvelope }      -> { intent_id }
POST /aubaine/offer       { signed OfferEnvelope }       -> { offer_id }
GET  /aubaine/offers?sku= -> [ OfferRow ]
GET  /aubaine/syndicates?sku= -> [ { id, committed_qty, moq, unit_price, status } ]
GET  /aubaine/events      (SSE: intent_matched, syndicate_forming, commit_requested, settled)
POST /aubaine/webhook     { url }                         -> register push endpoint
```

A2A `aubaine/quote|commit|settle-notify` (Section 5) is already HTTP/JSON-RPC and works as-is for foreign agents. The bridge (`src/commerce/bridge.ts`) keeps the HTTP-backed `group_buy_*` tables and the gossip-backed ones in sync so both populations match into the same `group_buy_syndicates`.

### 12.4 Portable reputation (cross-system)

Settlement emits a **signed SettlementReceipt** `{ counterparty_pubkey, role, amount_usdc, outcome, tx_hash, ts, signer_sig }` that any agent carries and presents to any clearinghouse. Bitterbot's `recordSettlementOutcome` (7.2) _consumes_ receipts as a value-add; the protocol does not require running EigenTrust. ERC-8004 onchain `giveFeedback` is the optional public-attestation form of the same receipt. This is the open analog of the internal trust graph — verifiable by anyone, owned by no one.

### 12.5 Naming / branding decision — RESOLVED: **Aubaine** (locked 2026-06-20)

The wire protocol is named **`aubaine/v1`** ("Aubaine" = French for _a windfall / a great find_; each syndicate member gets _une aubaine_). It is deliberately **vendor-neutral** — adopting it does not read as adopting "bitterbot's thing"; bitterbot is the named _reference implementation_ and reference-node operator, not the wire format. The agent-card extension (5.2), gossip topics, A2A methods, and HTTP paths all use the `aubaine` namespace; bitterbot-internal table/module names (`group_buy_*`, `src/commerce/*`) keep their descriptive names.

Why Aubaine (vs. the other candidates evaluated): collision-checked **clear** in crypto / web3 / AI-agent / software, where the alternatives were taken — Resonance (Ritual's "Resonance" mechanism + Resonance Security), Frugal (Reliance-adjacent "Frugal AI" + BeFrugal), Fynd (Reliance-owned Fynd, a same-category AI-commerce platform). The only existing "Aubaine" brands are a London café chain and an Oregon wine — both in food/hospitality classes (43/33), which legally coexist with a software/finance protocol (classes 9/36/42). Cost accepted: mild pronunciation friction (minor for a dev-facing protocol read in docs and as `aubaine/v1`). **Canonical home: `aubaine.ai`** (acquired 2026-06-20); the protocol spec, schemas, and `.well-known` descriptor are URL-rooted there (not on bitterbot.dev) to reinforce vendor-neutrality. `aubaine.com` remains held by the café (not needed).

**Still required before public launch:** a paid trademark clearance in classes 9/36/42 for the launch geographies, and social-handle registration. **Open, separate decision:** the _consumer-facing client_ brand. Bargain-semantic words (Frugal/Aubaine/Fynd) are crowded in consumer commerce; the client should get its own distinct coined name rather than reuse the protocol name — protocol stays neutral, client gets branded.

### 12.6 Where the moat lives (since the protocol is open)

Not secrecy. (1) **Liquidity** — bitterbot nodes form the deepest demand pool, so best fills cluster where bitterbot agents are. (2) **The reference clearinghouse/relay nodes** — the literal tollbooth taking the coordination fee (Section 6.3). (3) **Integration** — the only client with wallet + reputation + mesh + C2M settlement UX out of the box. (4) **The settlement-grounded reputation graph** — proprietary, can't be replicated cold. Open protocol grows the pool bitterbot sits at the center of; that is the "own the tollbooth" thesis stated correctly.

### 12.7 Phase impact

- Phase 1: publish the protocol spec (schemas + `.well-known` descriptor + test vectors) and stand up `clearinghouse-http.ts` (intent/offer/offers/syndicates/events) so a non-bitterbot agent can submit and observe from day one — agnosticism is cheapest to keep if it's there at the start, not retrofitted.
- Phase 1: `bridge.ts` HTTP↔gossip sync.
- Phase 3: ensure `aubaine/commit` accepts an externally-signed EIP-3009 auth from any wallet (no CDP assumption in the verify path); emit SettlementReceipts.
- Naming decision (12.5) settled before the spec is published, since the namespace is hard to change after third parties adopt it.
