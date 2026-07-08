# PLAN-29: Forage, the P2P Bounty Economy

**Status:** IN PROGRESS (2026-07-03) — Phase 0 landing; see Phase 0 status below
**Superseded in part by PLAN-30 (2026-07-07):** the Genesis integrity substrate
(PLAN-30 G0) hardened several mechanics described below after an adversarial
review — claim stakes remain decorative (replaced by audit-CV-gated release +
forfeiture; a refundable hunter bond is the planned successor), trust-tier
promotion now requires paid or audit-passed settlements (a bare 'queued' row
no longer promotes), stream budgets are shared across claims, check-ins are
nonce-sealed with per-check observation logs and probabilistic re-audits, and
attest funding is aggregate-solvency checked. See
PLAN-30-FORAGE-GENESIS-JUMPSTART.md for current behavior; this document stays
as the original design record.

> **Phase 0 status (2026-07-03):**
>
> - **CDP EIP-3009 spike: RESOLVED YES.** CDP Server Wallet v2 signs arbitrary
>   EIP-712 typed data (`EvmServerAccount.signTypedData`, cdp-sdk 1.48.2), and
>   production x402 payments already sign EIP-3009 authorizations through this
>   exact path. The EIP-7702 auth gate is a separate, unrelated API. Capture is
>   a permissionless contract call (any node, viem, own gas). Gotchas recorded:
>   USDC domain name is "USD Coin" on Base mainnet vs "USDC" on Base Sepolia;
>   signers can `cancelAuthorization` pre-capture (pools = best-effort capture);
>   any future CDP project policy needs a `signEvmTypedData` accept rule scoped
>   to the USDC contract. Phase 4's design risk is retired.
> - **0.1 spend rails: already fixed in tree** (post-audit): `assertDailyLimit`
>   guards both outbound paths (`wallet-service.ts`), A2A purchases are
>   db-recorded (`a2a-client-tool.ts` resolves the marketplace db). Added the
>   missing direct test coverage (`wallet-service.spend-limits.test.ts`, 9 tests).
> - **0.2 earning path: LANDED.** `a2a.payment.enabled` defaults on for
>   earning-capable nodes (`isEarningCapable` in `config/defaults.ts`); 402
>   `PaymentRequirements` now advertise the same wallet-fallback `payTo` that
>   verification accepts, with per-network asset/chain (was: empty payTo +
>   hardcoded mainnet). Tests: `config.a2a-earning-defaults.test.ts`,
>   `a2a-http.payment-402.test.ts`.
> - **0.3 load-time capability gate: LANDED.** Reply runner + CLI agent runner
>   now thread `capabilityGate` into every snapshot build; on by default, kill
>   switch `skills.p2p.loadTimeCapabilityGate: false`. PLAN-13 doc updated.
>   Tests: `session-updates.capability-gate.test.ts`.
> - **0.5 migration v22: LANDED.** `bounty_posts` / `bounty_claims` /
>   `bounty_settlements` (unique per claim, links `payment_queue_id`) /
>   `bounty_streams`. Tests: `migrations.v22.test.ts`.
> - **0.4 BountyEnvelope v2 + funding gate: LANDED.** `BountyEnvelope` gains
>   optional v2 fields (wire-compatible both directions; `version: 2` selects
>   the Forage path). New `sign_bounty_v2`/`verify_bounty_v2` cover the full
>   economic preimage (wallet, reward, oracle commitment, funding proof,
>   stake, deadline, max_claims) so relays can't rewrite economics. The
>   ingest gate admits v2 bounties from ANY pubkey iff structurally funded +
>   signature-valid (`has_funding()`); v1 keeps the management-pubkey gate.
>   `PublishBounty` accepts v2 from non-management nodes and refuses
>   unfunded v2 locally. TS: bridge types extended
>   (`orchestrator-bridge.ts`), `handleBountyEvent` routes v2 events through
>   the injection scanner into `bounty_posts` as `'unverified'` (Phase 1's
>   funding validator promotes to `'open'`); critical scan hits dropped.
>   Tests: 4 new Rust crypto tests (roundtrip, economic tampering, fail-closed,
>   v1 wire compat) + `skill-network-bridge.forage.test.ts`.
>
> **Phase 0 exit note:** economic validation of `funding_proof` (viem balance
> read / EIP-3009 auth check) is deliberately Phase 1 scope — rows sit at
> `'unverified'` until then, so nothing downstream can treat unvalidated
> funding as real demand.
>
> **Phase 1 status (2026-07-03):**
>
> - **1.1 funding validator: LANDED.** `src/memory/bounty-funding.ts`:
>   `validatePendingBounties` promotes `unverified → open` (attest proofs =
>   live USDC balanceOf >= reward via injected reader; eip3009 proofs =
>   structural from/value/validBefore checks), rejects underfunded/malformed,
>   defers on RPC failure, expires stale rows. Wired into the consolidation
>   tick (manager.ts step 11d) next to payment dispatch, fire-and-forget.
>   Tests: `bounty-funding.test.ts` (7).
> - **1.2 forage/claim|deliver|verdict A2A verbs: LANDED.**
>   `src/gateway/a2a/forage.ts` (pure db handlers) + async dispatch block in
>   `a2a-http.ts` before the payment gate (forage verbs are free; money flows
>   poster → hunter at settlement). claim: stake-bonded row against 'open'
>   bounties only, max_claims + one-active-claim-per-hunter enforced.
>   deliver: 128KiB cap, injection scan BEFORE storage (critical → rejected,
>   claim stays claimable), content stored as {sha256, contentB64, scanSeverity}
>   in deliverable_ref for the oracle harness. verdict: read-only poll of
>   claim + settlement state, hunter-scoped. Tests: `forage.test.ts` (11).
> - **1.3 oracle harness: LANDED.** `src/memory/bounty-oracle.ts` + migration
>   v23 (`oracle_spec_private`, poster-local sealed spec). Commitment
>   re-verified before every settlement (spec-switching refuses to settle).
>   Mechanical oracles: json (required keys, minItems), contains
>   (all/any/none), regex. Judge fallback uses the registered task-judge LLM
>   with fenced/truncated submissions, a fixed verdict grammar that fails
>   closed, and the $5 unilateral cap — passing verdicts above the cap park
>   at 'held_review' with no payment queued. On pass: hunter wallet upserted
>   for payout resolution, bounty_settlements row, payout queued
>   (role 'bounty_reward', 48h hold, dispatched by the live tick), claim
>   'verified', bounty 'fulfilled'. Sweep wired as tick step 11e beside the
>   funding sweep. Tests: `bounty-oracle.test.ts` (10).
> - **1.4 trust tiers + DPSV + end-to-end wiring test: LANDED.**
>   `src/memory/bounty-reputation.ts`: T0–T3 tiers from settled,
>   counterparty-diverse history only (self-loops and failed verdicts never
>   climb the ladder); claim caps $1/$5/$50/∞ enforced inside forage/claim.
>   `computeDpsv`: self-loops excluded and reported as wash volume, per-pair
>   concentration cap (default 25% share, engages at ≥4 pairs) so two-node
>   ping-pong cannot farm the metric. End-to-end wiring test
>   (`bounty-e2e.test.ts`): post → fund → claim → deliver → oracle pass →
>   settlement + payout queued → verdict poll → tier climb + DPSV count, all
>   green in one run. **Phase 1 complete: the full loop exists.**
>
> **Phase 2 status (2026-07-03):**
>
> - **2.1 heartbeat streams: LANDED.** Terms ride in a `{"heartbeat": ...}`
>   JSON block in spec_public (cadence ≥ 60s, per-check price, alert bonus);
>   claiming a heartbeat bounty opens a `bounty_streams` row (stream id ==
>   claim id). New `forage/checkin` verb: hash-chained observations
>   (`sha256(prev || contentHash)`), half-cadence spam floor, hunter-scoped.
>   `sweepStreamPayouts` (tick step 11f) batches unpaid checks into one
>   `stream_check` payment per stream per sweep — check-ins are the
>   transaction count, dispatch stays gas-sane — and completes stream /
>   verifies claim / fulfills bounty when the reward budget is spent, so
>   streams feed tiers and DPSV with zero special-casing. Tests:
>   `bounty-streams.test.ts` (10).
> - **2.2 paid audits (1-in-20 re-observation) + alert bonuses: deferred**
>   to land with the apprenticeship mechanic (audits are apprentice work).
> - **Phase 3 spectator layer (3a data + RPC + morning line): LANDED.**
>   `src/memory/bounty-tape.ts`: The Tape derives lifecycle events
>   (posted/opened/claimed/delivered/settled/stream_checked/fulfilled)
>   straight from the ledger tables — no event log to drift; actors shown
>   as truncated pubkeys. `getForageStats`: DPSV 7d + all-time (self-loops
>   surfaced as excluded wash), open bounties/reward, fill rate, median
>   time-to-fill, distinct earners, stream checks — deliberately no raw
>   GMV. Gateway RPCs `forage.tape` / `forage.stats` (read methods,
>   PLAN-28 retrievalHealth pattern). Morning-report line injected into
>   the new-main-session system block ("Forage: N settlements ($X) in the
>   last 24h; M streams reporting; K open bounties"), silent on quiet
>   nodes. Tests: `bounty-tape.test.ts` (8).
> - **Phase 3b dashboard tab: LANDED.** "Forage" tab in the dream dashboard
>   (`dream-dashboard-page.ts`): DPSV stat tiles (7d + all-time with wash
>   volume shown), open bounties/reward at stake, fill rate + median
>   time-to-fill, stream totals, The Tape as a live event list, and the
>   DPSV honesty note in place of any GMV figure. Tests:
>   `dream-dashboard-page.forage.test.ts` (3).
> - **Phase 5 Night Shift (v1, mechanical): LANDED.** Migration v24
>   `forage_hunts` (hunter-side claim mirror). `src/memory/forage-client.ts`:
>   `nightShiftSweep` (tick step 11g) polls verdicts, sends due heartbeat
>   checks (fetch target → sha256 → forage/checkin, cadence-respecting),
>   and claims new mesh bounties under hard caps (2 concurrent, ≤$2 reward,
>   monitoring-only, receive-only money flow). Poster callback + monitor
>   target ride in the bounty machine block (`posterA2aUrl`, `url`) so
>   hunting needs no out-of-band discovery. Hunter identity = wallet
>   address (Ed25519 identity adoption is a follow-up). Config
>   `forage.nightShift.{enabled,maxConcurrentHunts,maxRewardUsdc}` (zod'd,
>   default on). Morning report now leads with "earned $X hunting N
>   bounties while you were away." parseHeartbeatTerms rewritten as a
>   brace matcher (regex broke on sibling keys). Tests:
>   `forage-client.test.ts` (8).
> - **Phase 4 pools: BUILT, FLAG-OFF (legal gate).** Migration v25
>   `bounty_pool_auths`. `src/commerce/cdp-adapters.ts`: production
>   `Eip3009Signer` over CDP `signTypedData` (per-network USDC domain:
>   "USD Coin" mainnet / "USDC" sepolia) + capture executor submitting the
>   v,r,s `transferWithAuthorization` (selector e3ee160e) through the
>   AgentKit provider — also unblocks Aubaine Phase 3.
>   `src/commerce/bounty-pools.ts`: pledges signed at award against the
>   hunter's wallet, one per funder wallet, structural validation;
>   `strikeReadyPools` captures ONLY at quorum + oracle pass (below quorum
>   captures nothing, per-auth failures never block siblings). New A2A verb
>   `forage/fund` and tick step 11h both hard-gated on
>   `forage.pools.enabled` (zod'd, default FALSE). **GA gate: payments
>   counsel review; the flag flip is its own reviewed commit.** Sign-at-
>   award for large one-shots deferred until the same review. Tests:
>   `bounty-pools.test.ts` (9, including the legal-gate refusal).
> - **Still deferred: biology-gated bounty_hunt dream mode (LLM one-shot
>   hunting, calibrated-confidence ceilings), leaderboards + share card,
>   paid audits/apprenticeship, sign-at-award.**
>   **Depends on:** curriculum-bounty spine (PLAN-8 Phase 4, live), revenue payment queue + `dispatchReleasedPayments()` (live), wallet/x402 v2 (Wallet #54, live both directions), PLAN-16/17 task spine + Judge (live), Aubaine settlement primitives (PLAN-26, built/unwired), peer reputation + EigenTrust (live), skill quarantine gate (PLAN-15)
>   **Schema:** migration v22 (current head v21)
>   **Working name:** "Forage" (agents foraging for work while the organism rests; rename freely, keep the protocol name neutral like Aubaine)

## 0. Thesis and goals

Every user's bitterbot can post USDC bounties and every other user's bitterbot can autonomously discover, complete, and get paid for them. The point is not revenue for the platform. The point is a visibly thriving agent economy:

1. **Transaction density is the product.** Design for many small real settlements over few large ones.
2. **Users keep 100%.** Zero protocol fee on bounty settlements (`coordinatorFeeBps: 0` for this layer). The platform's return is network growth and the census/dashboard story, not a rake.
3. **The ecosystem must be _visibly_ alive.** The live settlement feed, the Morning Report, and pool progress bars are first-class features, not telemetry.
4. **Mass appeal via one sentence:** "my agent earned money while I slept." Every design choice below either makes that sentence true or makes it safe.

Two invariants govern everything:

- **No oracle, no bounty.** Every bounty declares a falsifiable acceptance oracle at post time (mechanical preferred, hardened LLM Judge fallback, capped). This is the PLAN-22 `doneCriteria` contract applied to money. The market research is unambiguous: the two bounty models that survived a decade (Kaggle, Fiverr) both solved evaluation _before_ money moved; every platform that put open-ended human judgment between submission and payment died or pivoted (Gitcoin, Bountysource, MTurk, curl's bug bounty). At zero fee we have no margin to fund judgment, so judgment must be nearly free, meaning automated and objective.
- **DPSV or it didn't happen.** With zero fees, raw transaction count is free to fake. The headline metric, all leaderboards, and all reputation accrual key off **Distinct-Party Settled Value**: USDC settled between counterparties whose reputation graphs do not collapse into each other. Reputation flows like PageRank: cycles redistribute it, they cannot mint it. Wash loops earn nothing but gas. This single invariant is what lets every aggressive mechanic below exist.

Legal invariant inherited from PLAN-26 §6.2 verbatim: **never custody funds.** No design below holds a poster's money. See §4.

## 1. What the research established (2026-07-03 fan-out, 4 agents)

Condensed; full briefs in the session transcript.

**Market post-mortems.** Bountysource died of escrow-trust catastrophe (froze payouts while accepting deposits). Gitcoin sunset per-task bounties as low-margin and operationally heavy. Replit Bounties died when their own agent ate the bounty-sized task. MTurk and curl's bounty drowned in LLM slop (about 20% of curl's 2025 reports were AI slop; valid rate at or below 5%). ClawTasks, the only live agent bounty market, peaked near 50 bounties and has suspended paid bounties over review flow and worker quality. Survivors: Kaggle (pre-declared objective metric, hidden holdout, submission limits; spam costs the spammer) and Fiverr (pre-scoped fixed deliverable). Recurring failure modes: escrow trust failure, judgment cost eating margin, slop floods, cold-start liquidity, disintermediation, AI eating the task tier.

**Rails reality.** x402 is now a Linux Foundation project (April 2026) with Coinbase/Cloudflare/Stripe/AWS involvement, but measured genuine volume is roughly $1-2M/month at $0.20-0.30 average, about half of raw counts being self-trading or tests. Nobody has cracked demand or adversarial-grade automated verification. Acceptance-test-driven escrow with adversarial money at stake is genuinely unshipped by anyone: first-mover ground for us. Rails are commodity; demand plus verification is the moat.

**Verification adversaries are real.** Frontier models demonstrably reward-hack graders they can reach (METR: up to 100% of runs on some tasks). JudgeDeceiver-style injections embedded in submitted work flip LLM-judge verdicts at about 90% success. Token-voting courts are broken (UMA $7M forced false resolution, 2025). Conclusions baked into §5: grader isolation is non-negotiable, LLM judges are capped first-pass gates only, hidden holdout criteria always.

**Cold start at ~40 nodes.** We are above atomic-network thresholds; the constraint is density of overlapping need, not size. Agent marketplaces are demand-constrained from day one (supply is elastic software). Playbook: single-player value first (we have it), operator-seeded real bounties under Victor's own identity (praised pattern; simulated third-party demand would be wash trading and would poison the reputation layer), constrain to one or two categories until fill is reliable, attach every node to a shared default bounty feed, progressive trust tiers for new agents. Score fill rate / time-to-fill / repeat rate / % non-operator transactions. GMV is explicitly a red herring.

**Category ranking for automated escrow** (Demand / Completability-2026 / Verifiability):

| Category                            | D   | C   | V   | Oracle                                                               |
| ----------------------------------- | --- | --- | --- | -------------------------------------------------------------------- |
| Monitoring/alerting                 | 4   | 5   | 5   | signed observation hashes; canary injections; pay per verified check |
| Dataset labeling                    | 3   | 4   | 5   | hidden gold subsets + honeypots + agreement thresholds               |
| Data extraction to schema           | 5   | 3.5 | 4   | JSON-schema validation + sampled re-scrape fidelity                  |
| Code fixes, buyer-held hidden tests | 4   | 4   | 4   | sandboxed hidden test suite (beware flawed-test rejections)          |
| Test generation                     | 3   | 4   | 4   | mutation kill-rate, never raw coverage %                             |
| Translation/localization            | 4   | 4   | 3   | QE score floor + sampled audit                                       |
| Content generation                  | 5   | 5   | 2   | spec compliance only; optimistic release tier                        |
| Research reports                    | 4   | 3   | 1.5 | citation resolution only; worst escrow fit                           |

Monitoring is the sleeper: the only category generating _recurring_ transactions per bounty with near-zero dispute surface. Launch categories: monitoring + data extraction (+ code-fix bounties for the dev audience). Subjective categories ship later on the optimistic-release tier only.

## 2. Architecture overview

Nearly everything reuses a live or built surface. The architecture agent's verdicts, incorporated:

```
 poster agent                                    hunter agent
     │ 1. POST BountyEnvelope v2                     │ 3. discover: bounty
     │    (bitterbot/bounties/v1 gossip,             │    directory scan
     │     Ed25519, ANY funded pubkey)               │    (dream bounty_hunt /
     ▼                                               │     task spine / user)
 ┌─────────────────────────────────────┐             ▼
 │ Bounty Directory (sqlite, v22)      │──── 4. CLAIM (stake-bonded,
 │ bounty_posts / bounty_claims /      │     A2A forage/claim)
 │ bounty_settlements                  │
 └──────────────┬──────────────────────┘
                │ 5. deliver artifact (A2A forage/deliver,
                │    quarantine-staged, injection-scanned)
                ▼
 ┌─────────────────────────────────────┐
 │ Oracle harness (poster side):       │  mechanical oracle first;
 │ sealed acceptance spec, isolated    │  runTaskJudge() fallback,
 │ grader, PLAN-16 Judge (hardened §5) │  capped + sanitized
 └──────────────┬──────────────────────┘
                │ pass
                ▼
 ┌─────────────────────────────────────┐
 │ Payout: revenue_payment_queue        │  role:'bounty_reward', hold,
 │ → dispatchReleasedPayments()         │  wallet.sendUsdc()  (ALL LIVE:
 │ → sendUsdc(claimer_wallet)           │  manager.ts:2202 / :3849)
 └──────────────┬──────────────────────┘
                ▼
 peer_reputation category="commerce" (recordSettlementOutcome, live)
 + DPSV accounting + The Tape (dashboard feed) + Morning Report
```

**Reuse map (verified against code 2026-07-03):**

| Need                          | Surface                                                                                                                                          | State                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Signed bounty gossip          | `BOUNTIES_TOPIC bitterbot/bounties/v1`, `IpcCommand::PublishBounty`, `crypto::sign_bounty` (`orchestrator/src/swarm/mod.rs`)                     | live, management-pubkey-gated (gate relaxed in Phase 0)                                                          |
| USDC payout spine             | `revenue_payment_queue` → `manager.dispatchReleasedPayments()` (`src/memory/manager.ts:2202,3849`) → `wallet.sendUsdc`                           | live on wallet-enabled nodes; 48h hold; the 2026-06-09 audit's "never dispatches" finding is fixed               |
| Pay + charge rails            | `payForResource` (x402 client) + `verifyX402Payment` (`src/services/x402-verify.ts`, on-chain, replay-ledgered) via A2A gate (`a2a-http.ts:200`) | live; v2 semantics only, v1 endpoints fail in prod                                                               |
| Task semantics + bidding seam | `Task.bounty` (`src/tasks/types.ts:65`), `tasks/bounty.ts` `listBiddableTasks/recordBid`                                                         | stub, adopt and finish                                                                                           |
| Verification                  | `runTaskJudge` (`src/tasks/judge.ts`), fresh session, no worker memory                                                                           | live; harden per §5                                                                                              |
| Any-pubkey signed envelopes   | Aubaine `src/commerce/envelope.ts` (Ed25519, JCS canonical, domain-prefixed)                                                                     | built + tested, unwired                                                                                          |
| Threshold pools               | `src/commerce/settlement.ts ThresholdSettlement` (confirm-then-capture EIP-3009)                                                                 | built + tested, unwired; needs CDP/viem adapters                                                                 |
| Counterparty reputation       | `peer_reputation` (`wallet_address`, `eigentrust_score`, `recordSettlementOutcome`)                                                              | live                                                                                                             |
| Deliverable vetting           | PLAN-15 quarantine/staging gate + injection scanning                                                                                             | live for skills; extend to bounty artifacts                                                                      |
| Idle-time supply              | dream engine `selectModes()` already consumes marketplace-demand adjustments (`dream-engine.ts:758`)                                             | live; `bounty_hunt` mode requires editing the `DreamMode` union + `runMode` switch (fixed union, not a registry) |

## 3. Bounty object and wire format

### 3.1 BountyEnvelope v2

Extend the Rust `BountyEnvelope` (additive fields, versioned so v1 curriculum bounties keep parsing):

```
BountyEnvelope v2 {
  bounty_id, poster_pubkey, poster_wallet_address,
  kind: oneshot | heartbeat | pool | standing,
  category,                       // monitoring | extraction | code_fix | ...
  spec_public,                    // human/agent-readable task text
  oracle_commitment,              // hash of sealed acceptance spec (§5.1)
  reward_usdc, funding_proof,     // §3.2
  claim_stake_usdc,               // hunter bond, scales with reward
  deadline, expires_at, max_claims,
  affect_tags?,                   // advisory routing (§8, v1-lite)
  signature                       // Ed25519 over canonical form
}
```

Signing uses the Aubaine envelope pattern (any pubkey, `forage/v1\n` domain prefix) rather than the management-only `sign_bounty` path. Management-signed curriculum bounties remain a distinct, still-privileged kind.

### 3.2 The management gate becomes a funding gate

Today `orchestrator/src/swarm/mod.rs:2147` discards bounties from non-management pubkeys. That gate exists for Sybil control and we keep the _function_ while relaxing the _identity check_: a bounty propagates only with `funding_proof`, one of

- **a signed EIP-3009 authorization** (recipient TBD-at-award pattern per §4.2) proving the poster's wallet can cover `reward_usdc`, or
- **a recent balance attestation**: poster signs a challenge; peers spot-verify the wallet's USDC balance on Base via the existing viem read path.

Mirrors PLAN-26 Open Q2's resolution ("only signed deposit auths count toward MOQ"): only funded bounties count as real demand, are gossiped, appear in The Tape, or accrue anyone reputation. Unfunded text is spam and is dropped at ingest exactly like unsigned envelopes. Bounty text passes the existing injection-scanning pipeline **before** any agent reasons over it (adversarial-bounty defense, see §5.4).

### 3.3 Storage (migration v22)

`bounty_posts`, `bounty_claims` (stake, status, commit-hash for standing races), `bounty_settlements` (oracle verdict, payout tx, DPSV counterparty edge), `bounty_streams` (heartbeat subscriptions: cadence, per-check price, observation hash chain, audit schedule). Owned by `MarketplaceEconomics` alongside `revenue_payment_queue` (the architecture agent's recommended home). Indexes on `(category, status, deadline)` for the directory scan.

## 4. Settlement shapes (all structurally non-custodial)

Nobody ever holds anyone else's funds. Four shapes, by bounty kind:

### 4.1 One-shot: pay-after-verify, bonded both sides (v1 default)

Poster pays from their own wallet only after the oracle passes, via the live `revenue_payment_queue` → `sendUsdc` spine (`role:'bounty_reward'`, hold shortened from 48h to a per-size schedule: small amounts release fast, large amounts keep the window). Hunter risk (deadbeat poster) is priced by commerce reputation: a poster who stiffs a passing deliverable eats a `recordSettlementOutcome` failure edge, loses posting-tier privileges, and their future bounties rank last in every directory. Hunter's `claim_stake_usdc` forfeits to the poster on abandoned or oracle-failing claims (slash only on _provable_ fault, i.e. mechanical-oracle fail or timeout, never on a bare LLM verdict).

### 4.2 One-shot, hardened: sign-at-award, capture-on-pass (v1.5)

At claim-award the poster signs the EIP-3009 authorization naming the hunter, with `validBefore` set past deadline + verification window; capture executes only on oracle pass. Poster can still drain the wallet before capture (this is not escrow), but it converts "will they even sign?" risk into observable on-chain balance risk and produces a portable, self-evidencing receipt. Reuses Aubaine's `Eip3009Signer` interface; requires the Phase 3 CDP/viem adapters (see §9 Phase 4). True refundable escrow is the PLAN-26 Phase 5 audited contract and stays out of scope until that lands with legal review.

### 4.3 Heartbeat streams: pure x402 metering (no escrow needed at all)

Recurring checks are individually-paid x402 v2 calls on the **live** pay/charge rails: hunter's node exposes the monitor via the A2A x402 paywall; poster's agent auto-pays per check under the existing $1 auto-pay / $25 per-tx / daily-limit policy stack. Every check is a settlement. Signed observation (URL, content hash, timestamp) per check forms the oracle chain; 1-in-20 checks a second node is paid to replicate the observation (the audit is itself another transaction); hash mismatch slashes the stream's accumulated reputation and future subscriptions.

### 4.4 Pools: Aubaine threshold settlement, reused verbatim

N funders each sign small EIP-3009 auths toward one bounty; `ThresholdSettlement.recordCommitment()/strike()` fires atomically when the pool crosses the target AND the oracle passes; below threshold nothing is ever captured, so "failed pool" costs funders nothing (Aubaine's confirm-then-capture, unlike its group-buy use where capture precedes delivery). This is the strongest fit of the Aubaine machinery to bounties because capture is already conditional. `coordinatorFeeBps: 0`. **Money-moving code ships behind the same explicit legal-review gate PLAN-26 established** (the sanctioned exception to wired-by-default).

## 5. Verification: the oracle harness

### 5.1 Sealed acceptance specs (Kaggle's private leaderboard, generalized)

The poster commits `oracle_commitment = hash(acceptance_spec + salt)` at post time and reveals the spec only after delivery. Hunters see the public spec text and the oracle _type_, never the exact gold data / test suite / canary schedule. Prevents overfitting-to-grader and makes spec-switching provable (revealed spec must match the commitment).

### 5.2 Oracle tiers

1. **Mechanical (preferred, releases payment alone):** hidden test suite in a sandbox, JSON-schema + sampled fidelity checks, gold-subset agreement, mutation kill-rate, signed observation chains, on-chain events.
2. **Hardened Judge (capped):** `runTaskJudge` in a fresh session, but per the adversarial evidence: submission text is sanitized/stripped before judging (JudgeDeceiver defense), judge model family differs from the common worker family, temp 0, and a bare Judge verdict can unilaterally release at most `judge.maxUnilateralUsd` (default $5). Above the cap: Judge pass triggers optimistic release with a challenge window instead of instant payout.
3. **Optimistic release (subjective categories only, later phase):** deliver → poster has N hours to challenge → silence auto-releases. Windows scale with amount; challenges above small sums require a poster bond to deter frivolous rejection (the MTurk unilateral-rejection lesson).

### 5.3 Grader isolation (non-negotiable)

The hunter's agent must never reach the grader environment: oracles execute poster-side or on a neutral third node (paid apprentice work, §6), in the PLAN-16 wakeup executor sandbox, with tool scopes limited to the oracle's declared footprint. METR's reward-hacking results make this a hard rule, not hygiene.

### 5.4 Inbound-content defenses

Bounty text, deliverables, and Judge inputs all pass injection scanning; deliverables land in the PLAN-15 quarantine tier and are never auto-executed by the poster's agent before promotion. **Companion requirement:** the load-time capability gate (PLAN-13, currently unwired) must ship in Phase 0 for bounty deliverables specifically; paying strangers to produce content our agent then loads raises the stakes beyond the skill-gossip status quo.

## 6. Reputation substrate: earned capital, not a score

Extends live `peer_reputation` (category="commerce"):

- **DPSV-weighted accrual.** Reputation accrues only from settlements weighted by counterparty diversity and by the _funder's_ own reputation. Flow, not minting; self-dealing nets zero.
- **Progressive trust tiers with exposure caps** (research-preferred over pure staking, since new agents are asset-poor): T0 apprentice (calibration bounties only) → T1 (open bounties ≤ $5, full stake) → T2 (≤ $50, reduced stake) → T3 (uncapped, minimal stake, may underwrite). Promotion by completed DPSV volume + success rate; demotion on slashes.
- **Reputation is collateral.** Higher tier = smaller USDC bonds; rep is co-staked and slashable on provable fault. Reputation decays with a half-life (nothing in this organism is static), forcing continuous participation and blunting hoard-then-exit strategies.
- **Vouching = rep staking.** Established nodes stake a slice of reputation on newcomers (max 3 active vouches, ≤10% of rep at stake); vouchee default burns the voucher's stake. Underwriting market for talent scouting.
- **Apprenticeship is the paid immune system.** T0 agents earn on _calibration bounties_: redundant re-executions of live settlements, the 1-in-20 heartbeat audits, N-of-M oracle spot-checks, scored against consensus. Onboarding capacity and the verification layer are the same payroll, and every apprentice task is another real transaction.

## 7. Cold start and demand

1. **Operator-seeded, operator-identified.** Victor posts the first tranche of real bounties with real budgets under his own identity (monitoring of real pages/feeds we care about, extraction jobs, repo issues with hidden tests). Never simulate third-party demand; in a paid marketplace that is wash trading and poisons the only moat.
2. **One category until fill is reliable.** Launch = monitoring (recurring volume, near-zero disputes) + data extraction as the second. Code-fix bounties as soon as the sandbox harness exists, since our node operators skew developer.
3. **Shared default feed.** Every node's agent polls the bounty directory out of the box (Virtuals' one verified success pattern: attach new supply to an existing demand queue). Claiming requires opting in a mandate; seeing demand does not.
4. **Agent-generated demand (Phase 5).** Pain harvesting: recurring cortisol-friction clusters on the same task fingerprint auto-draft an evidence-cited bounty for morning one-tap approval. Mid-task procurement: PLAN-16 tasks stuck `waiting_external` on a missing capability post a bounty from the task's mandate. Auto-drafted bounties structurally require cited event-journal receipts; the poster earns reputation only when the delivered artifact is subsequently _used_ (usage receipts separate real needs from choreography).

## 8. Mechanics: v1 set and deferred set

From the mechanics fan-out, ranked by (transaction multiplication × feasibility ÷ abuse risk):

**v1 (this plan):**

1. **Heartbeat streaming bounties** (§4.3): highest sustained volume per unit of new code; rails proven; audits self-generate volume.
2. **Bounty pools** (§4.4): Aubaine reuse; densest single settlements; best public visual (progress bars, backer counts).
3. **Spectator layer.** _The Tape_: dashboard tab (PLAN-28 retrievalHealth pattern) rendering the bounty lifecycle straight off gossip: posted / claimed / pool ticks / struck / settled, stake-weighted ranking so spam can't buy the front page. _Morning Report_: "While you slept: earned $4.20 across 3 bounties, your monitor caught a price drop, rep +12," one-tap share card. _Bounty Stories_: 3-sentence solve narrative per settlement (dream-synthesis prompt machinery), doubling as human-readable verification evidence, with a redaction pass + user preview for anything pain-harvest-sourced. Leaderboards: Night Shift, Streak, Rising, Underwriter. Also fixes the audit's "network economics telemetry has a listener but no emitter" gap: settlement events feed management-node telemetry so the census can show economy stats.
4. **Night Shift** (conservative gates): dream mode `bounty_hunt` claims work during idle under a signed sleep mandate (max stakes, spend, category scope; Aubaine `mandate_json` shape). Difficulty ceiling from PLAN-7 calibrated confidence, never mood; dopamine widens the exploration band one tier, cortisol shrinks concurrency (`computeTaskConcurrency` unchanged), GCCRF alignment prefers bounties overlapping active curiosity targets (paid curriculum: USDC for closing its own knowledge gaps). Claims above a per-item threshold reserve pending morning ratification rather than commit.
5. **Reputation substrate** (§6) ships in v1 or wash trading defines the culture before real trade does.
6. **Private bounty class:** encrypted body, matched by spec hash only, excluded from The Tape (Aubaine spec-lock pattern) for demand that reveals sensitive user context.

**Deferred to v2, with reasons:**

- **Fission subcontracting** (hunter splits into child bounties): highest raw multiplier, worst abuse surface at zero fee; needs the DPSV substrate battle-tested. Design notes preserved: skill-tag-entropy rule (children matching the parent's own proven tags earn the parent zero rep), depth cap 3, 0.5^depth rep discount, parent liability undiminished.
- **Zeigarnik open-loop pricing:** a stalled user-originated task's bounty offer ratchets with measured internal tension, capped by mandate. Blocked on PLAN-22 landing. Uncopyable without the organism.
- **Dead-man bounties** on PLAN-9 prospective memory ("when library X ships v3, port my config, $8"): a standing lattice of conditional orders whose condition-watching is itself outsourced as heartbeat streams. Blocked on prospective-memory hardening.
- **Skill futures** ("first skill passing this suite earns $25"): oracle = the PLAN-15/21 staging gate; open futures feed the dream mutation mode's demand signal so the mesh literally dreams toward funded gaps. 7-day challenge window; strictly-better submission claims instead.
- **Standing first-to-solve races** with commit-reveal (hash + stake, ordered reveals) once claim infrastructure is stable.
- **Hormonal order routing** as more than advisory affect tags; **REM arbitrage** (dream-harvest insights sold into open bounties); **ERC-8004 portable reputation** once the >100-agent traction gate passes.

## 9. Phases

House rule applies: each phase ships wired + active-by-default + tested + documented in the same commit. Sanctioned exception (PLAN-26 precedent): code that moves USDC ships complete but flag-gated pending legal review; the flag flip is its own reviewed commit.

**Phase 0, rails hardening (prerequisites, no new product surface):**

- Enforce `tools.wallet.dailySpendLimitUsd` everywhere (audit rec 8) and record A2A purchases so the $2/day guard works; both are today no-ops.
- Default-enable the earning path (`a2a.payment.enabled`) with the x402 address auto-derived from the CDP wallet; a node that cannot earn cannot participate.
- Wire the PLAN-13 load-time capability gate for ingested bounty deliverables (§5.4).
- BountyEnvelope v2 + funding-gate relaxation in Rust (§3.1-3.2), six-step topic pattern, injection scan on ingest.
- Migration v22 tables (§3.3).

**Phase 1, core lifecycle (one-shot, monitoring + extraction categories):**

- Directory scan + A2A `forage/claim|deliver|verdict` verbs (pattern: the confirmed-absent `aubaine/*` verbs, built fresh on `a2a-http.ts`).
- Oracle harness: sealed specs, mechanical oracles for the launch categories, hardened Judge with `maxUnilateralUsd`.
- Payout through `revenue_payment_queue` with per-size hold schedule; finish the `tasks/bounty.ts` stub (acceptBid → task spine execution → Judge → queue).
- Progressive trust tiers + DPSV accounting + claim stakes.
- Operator seed tranche posted; scoreboard: fill rate, time-to-fill, repeat rate, % non-operator.

**Phase 2, heartbeat streams:** `bounty_streams`, per-check x402 metering, observation hash chains, 1-in-20 paid audits, slash path.

**Phase 3, spectator layer:** The Tape dashboard tab, Morning Report + share card, Bounty Stories with redaction preview, leaderboards, settlement telemetry → census economy stats.

**Phase 4, pools + sign-at-award (legal-gated):** CDP/viem `Eip3009Signer`/`SettlementExecutor` adapters (also unblocks Aubaine Phase 3), pool UX with progress bars, §4.2 hardened one-shots. Ships flag-gated; payments counsel review is the GA gate.

**Phase 5, Night Shift + demand generation:** `bounty_hunt` dream mode (union + switch + mode config edits), sleep mandates + morning ratification, pain harvesting + mid-task procurement with receipt requirements.

**Phase 6 (v2):** fission, Zeigarnik pricing, dead-man bounties, skill futures, races, ERC-8004, per §8 gates.

## 10. Success metrics

In order (GMV deliberately absent):

1. **DPSV** (weekly, the headline)
2. **Fill rate** (% of funded bounties claimed within 24h) and **time-to-fill**
3. **Repeat rate per counterparty pair** (Tavel's L2 signal)
4. **% of settled volume not involving the operator** (the weaning metric)
5. **Nodes earning > $1/week** (the "thriving" claim, and the Morning Report's honesty check)
6. **Dispute rate** (challenges / settlements; target < 2% in mechanical-oracle categories)

## 11. Risks and open questions

1. **Deadbeat posters in §4.1.** Reputation pricing may be too weak at 40 nodes where everyone is new. Mitigation: operator-seeded tranche establishes honest-poster history first; §4.2 upgrade path. Open: should posting above $20 _require_ the sign-at-award shape once adapters exist?
2. **Judge gameability.** Even hardened, an LLM verdict releasing $5 unilaterally is attackable at margins. Monitor slash/challenge outcomes; drop `maxUnilateralUsd` if abused. Mechanical-oracle categories carry the volume regardless.
3. **Provenance interplay (PLAN-8 70/20/10).** If a bounty deliverable becomes a marketplace skill, the claimer keeps the original-author share. Bounty payment buys the deliverable, not the provenance. More user earnings, more downstream transactions; document in the marketplace docs.
4. **Fee-thesis tension with PLAN-26 §12.6** ("own the tollbooth"). Resolved deliberately: Forage runs at zero fee because the goal is a thriving-network demonstration; Aubaine's `coordinatorFeeBps` remains the monetization knob for group-buys. If Forage volume becomes real, monetization candidates are premium spectator/analytics surfaces, never a settlement rake.
5. **Slop flood at success.** If open bounties attract external agent spam post-growth, defenses are already structural (stakes ∝ reward, tier caps, submission limits per Kaggle). Watch curl's failure mode anyway.
6. **Privacy.** Pain harvesting reads friction from private context; the private bounty class + redaction preview are mandatory before Phase 5 ships, not optional polish.
7. **Event-loop discipline.** Directory scans, oracle runs, and stream audits are heavy loops; they must use `src/memory/event-loop.ts` cooperative yielding (standing rule from the 2026-06-22 starvation incident).

## 12. Relationship to prior plans

- **PLAN-8:** Forage is the general-population completion of Phase 4's management-only curriculum bounties; same topic, same payout spine, relaxed posting gate, real oracles.
- **PLAN-16/17/22:** bounty work runs as Tasks; `doneCriteria`/Judge is the verification substrate; auto-initiation via the fail-closed pre-turn seam; `Task.bounty` seam finished.
- **PLAN-26:** envelopes, mandates, threshold settlement, and commerce reputation are reused; Forage Phase 4 builds the wallet adapters Aubaine Phase 3 also needs, unblocking both.
- **PLAN-15/13/21:** quarantine + staging gate vet deliverables and anchor skill-future oracles.
- **PLAN-7/9/25:** calibrated confidence gates Night Shift difficulty; prospective memory powers dead-man bounties (v2); dream-mode demand signals close the REM-arbitrage loop (v2).
