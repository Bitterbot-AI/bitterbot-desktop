# PLAN-30: Forage Genesis, Jumpstarting the Bounty Economy

**Status:** IN PROGRESS (2026-07-07) — G0 landing; see G0 status below

> **G0 status (2026-07-07):**
>
> - **G0.1 LANDED.** Migration v26 (`bounty_stream_checks` per-check
>   observation log + `forage_hunter_audit` CV state), checkin write path,
>   and the stream auditor (`src/memory/bounty-audit.ts`): norm-v1
>   normalization, simhash tolerance, dual-fetch stability check, two-tier
>   verdicts (forfeit only on provable fraud), BOINC adaptive rate
>   (100% under CV 10, then max(5%, 1/CV), CV counts audited-and-passed
>   only). Wired in the a2a HTTP layer after the checkin response; on by
>   default, kill switch `forage.audit.enabled: false`.
>   Tests: `bounty-audit.test.ts` (13).
> - **G0.2 LANDED (bond deferred).** `forfeitHunter` seizes held
>   bounty-role payments + voids queued settlements + resets CV;
>   stream_check release gated on CV >= 10 (`releaseHeldPayments`); tier
>   promotion counts 'queued' settlements only past the audit
>   apprenticeship, 'paid'/'held_review' always, 'forfeited' never. The
>   refundable $1 capital bond needs the EIP-3009 capture spike and lands
>   with a follow-up commit; until then T1+ short-hold deterrence leans on
>   the CV release gate + apprenticeship (documented residual risk at the
>   5% floor for long-tenured hunters).
> - **G0.3 LANDED.** Claims issue a secret 256-bit nonce (migration v27
>   stores it hunter-side); v2 check-ins carry digestScheme 'norm-v1',
>   simhash, and sealedDigest = sha256(nonce || contentHash). Absent seal =
>   legacy-accepted (dual-accept window); inconsistent seal = rejected, not
>   punished — with unauthenticated verbs a wrong seal could be third-party
>   griefing, so forfeiture-grade fraud waits for Ed25519 signing (G4).
>   Night Shift sends v2 observations and raises `alert` on content change.
>   Tests in `bounty-streams.test.ts` + `forage-client.test.ts`.
> - **G0.5 LANDED.** All six gap closures: (1) shared bounty budget across
>   claims (the latent K x overpay bug) with precise spent_usdc accounting
>   (migration v28, backfilled); (2) alert bonuses pay only on
>   audit-CONFIRMED alerts (alert checks are always audited, so the flag
>   cannot be farmed); (3) deadline/expiry sweep (`sweepOverdueClaims`,
>   tick 11g; active streams exempt; fill-rate denominator includes
>   'expired'); (4) `forage.review` + `forage.reviewRelease` operator RPCs
>   over `resolveHeldReview`; (5) tx_hash backfill: payment dispatch marks
>   the settlement 'paid' with the receipt, `forage/verdict` returns it;
>   (6) hunter-side settlement reconciliation (settlement_status/tx on
>   forage_hunts) and the morning report distinguishes "earned" (paid)
>   from "accrued (pending verification)".
> - **G0.4 LANDED.** Aggregate attest solvency (wallet must cover new
>   reward + outstanding open obligations minus stream spend); config
>   `forage.genesis.{treasuryWallets, maxDailyTreasuryUsdcPerHunter}`;
>   seeded vs organic settled-value split in `forage.stats` keyed on the
>   published treasury wallet list (blended totals never rendered);
>   per-hunter daily cap on treasury-stream earnings enforced poster-side
>   in the payout sweep. Docs: `docs/marketplace/a2a-integration.md`
>   updated for the v2 checkin observation, claim nonces, audits, review
>   RPCs, and genesis accounting.
>
> **G0 is code-complete** (2026-07-07, commits b916567/623c1f7/b943c9d +
> this one) except the deferred refundable hunter bond (needs the EIP-3009
> capture spike; the CV release gate + apprenticeship carries deterrence
> until it lands). Next: G1 genesis tranche posting (needs `GET /health`
> endpoint + scale governor) per section 2.
> **Depends on:** PLAN-29 (Forage bounty economy, live), PLAN-8 (revenue rail), PLAN-16/17 (task spine)
> **Related open problem:** census/network-count redesign (pinned 2026-07-07); Phase G1 partially feeds it.
> **Revision note:** v1 was red-teamed by a second agent fan-out (5 verification lanes). Five blockers and a broken escrow design were found and fixed; see Appendix A for the changelog. Verify before trusting any v1 copy.

## 0. What this plan is and is not

Goal: convert the live-but-idle Forage marketplace (seed tranche of 3 heartbeat
bounties, ~40 nodes, Night Shift hunting) into a self-reinforcing loop where
every node earns small amounts nightly for work the network actually consumes,
with metrics that survive scrutiny at 10,000+ nodes.

This plan is NOT a volume program. The evidence base (first-pass research plus
an adversarial verification pass, 2026-07-07):

- Every agent bounty marketplace surveyed is supply-saturated and
  demand-starved (one live marketplace: 1,500 registered workers, $243 total
  ever paid; ClawHunt's homepage claimed $847K processed while its own API,
  snapshotted the same minute, showed $4.7K, and its June welcome modal
  admitted verbatim "We've cleared out all simulated problems").
- Protocol-owned demand loops are the definitive negative result: Olas
  recorded 10M+ agent-to-agent transactions against ~$89K lifetime turnover;
  Morpheus TVL round-tripped 97.7%; Bittensor's external revenue covers
  roughly 1-5% of emissions post-halving.
- x402, the flagship agent-payment rail, saw transactions collapse 92% from
  the December 2025 peak once gamed activity washed out; verified organic
  volume is on the order of $14k/day network-wide, and an a16z/Allium
  analysis found ~81% of hype-window volume artificial. Being early is fine;
  designing for volumes that do not exist is not.
- Networks that crossed to organic demand did it by selling a commodity with
  pre-existing external buyers, landed as one or two wholesale anchors
  (Grass: AI-lab data; Helium: carrier offload), never via simulated
  peer-to-peer demand.
- Incentive-attracted participants churn 85-98% when incentives end (a
  synthesis across Blast, Arbitrum, LayerZero, Grass staking data, not a
  single measured statistic).
- Every activity KPI that pays becomes the product (Goodhart).

Design principles, each traceable to a documented failure elsewhere:

1. **Pay for verified consumption, not existence.** (Helium PoC spoofing,
   Filecoin garbage capacity, io.net's ~600K claimed vs ~10K verified GPUs.)
2. **Top-up guarantee, not additive faucet**, gated so newcomers cannot farm
   it (see G4; Friedman-Resnick "cheap pseudonyms": an unguarded newcomer
   subsidy is a whitewashing faucet).
3. **Seeded and organic volume are separate first-class metrics, forever**,
   keyed on a published treasury wallet list, not self-declared flags.
4. **Launch verification strict; loosening is painless, tightening is a
   public scandal.** (io.net purge.)
5. **The 40-node era is the disclosed founders era.** Operator-posted bounties
   set tone and liquidity openly.
6. **Never resolve disputes or pay on peer agreement alone.** (Buterin's
   p+epsilon attack; peer-prediction lab results where always-agree beat
   honesty.) Payment-grade verdicts come from operator gold checks,
   re-observation, or cryptographic proofs.

## 1. Phase G0: integrity substrate (before any scale-up)

PLAN-29 gives us more than half of this: batched payouts with a hold window,
sealed oracle commitments, a trust-tier ladder, DPSV self-dealing exclusion.
The v1 claim that the rest was "wiring" was wrong: G0 requires one new
migration and a handler change, because today NO per-check data survives a
checkin. `handleForageCheckin` folds each check into a single rolling head and
discards the per-check hash, URL, and timestamp (forage.ts:383-392); the
previous head is overwritten. There is nothing to audit against until that is
fixed.

### G0.1 Per-check observation log + stream auditor

**Migration:** new table `bounty_stream_checks`
`(stream_id, seq, content_digest, digest_scheme, observed_at, prev_head, head,
audit_status)`, written inside `handleForageCheckin`. This is the auditable
commitment log v1 wrongly said already existed; it also gives the census
redesign its per-observation evidence.

**Auditor:** because the checkin handler is a synchronous pure function
dispatched from the HTTP layer (a2a-http.ts:243-251), the audit fetch runs in
the async HTTP layer AROUND the handler: with probability p(hunter), fetch the
monitored URL immediately on checkin receipt, compute the normalized digest,
and record both digests plus the verdict. No 30-minute-stale tick-time
comparisons against content that legitimately changed.

**Comparison is never raw-byte equality.** Live pages differ across fetches
(ads, tokens, timestamps); an exact-match audit would routinely confiscate
honest earnings and invert the incentive model. Pipeline (BOINC fuzzy
validators, changedetection.io practice):

- Canonical normalization both sides run: strip script/style/comments,
  drop asset query strings, collapse whitespace, apply per-monitor scope
  selector if configured; hash the result (`digest_scheme` names the
  pipeline version).
- Similarity threshold (configurable per monitor) instead of equality.
- On mismatch: second auditor fetch; if the auditor's own fetches disagree
  with each other, verdict is "unverifiable", never "fraud".
- **Two-tier verdicts: forfeiture requires provable fraud** (hunter claims
  content while quorum sees NXDOMAIN/refused, or the commitment is
  internally inconsistent). Content mismatches score "unverified": they
  pause release and reset CV, but never seize.

**Audit rate** follows the BOINC adaptive schedule keyed per hunter pubkey
(new per-hunter counter state; the per-stream `audits_*` columns are not
sufficient):

- CV(hunter) = consecutive AUDITED-AND-PASSED checks (unaudited checks do
  not increment CV, or an active cheater decays its own audit rate).
- CV < 10: audit rate 100% (apprenticeship).
- CV >= 10: audit rate max(5%, 1/CV).
- Overhead note: ~5-10% is BOINC's stated design target, not a measurement,
  and applies at steady state only; at launch everyone is CV < 10 and
  overhead is ~100% of volume for the first weeks. At one fetch per audit
  this is bandwidth, not dollars, and it is the price of principle 4.

### G0.2 Bond + forfeiture (make cheating negative-EV at every tier)

The deterrence inequality (Belenkiy et al. 2008, verified against the paper):
cheating is irrational iff forfeitable amount >= reward x (1-p)/p. At the 5%
audit floor that is >= 19 checks' earnings forfeitable AT ALL TIMES.

v1's tier-graduated hold windows fail this badly (independent math check):
a T3 hunter with a 48h hold has ~2 checks held, needs a 33% audit rate to be
deterred at that hold, and at 5% cheating nets +0.85 checks per cheat. The
"20 checks or 14 days" T0 valve also leaks (14-day clause binds at daily
cadence, holding 14 < 19 checks; disposable-identity EV goes positive).

**Fix, per iExec's production design: decouple the fine from the hold.**

- **Refundable participation bond**: a hunter activates hunting by posting a
  small bond (default $1.00, config `forage.genesis.hunterBondUsdc`),
  refundable on clean exit. Deterrence condition p x (H + B + 1) >= 1 then
  holds at every tier with fast payouts (at $0.05/check, B = $1 is 20 checks
  by itself).
- Hold windows can stay short (48h flat is fine once the bond exists).
- Release rule is count-based only where a bond is not posted: earnings
  release after 20 subsequent verified checks, no time valve.
- **Forfeiture on provable fraud**: seizes bond + all held earnings, resets
  CV to 0, and writes settlement status `'forfeited'`. `'forfeited'` must be
  excluded from `SETTLED_STATUSES` in bounty-reputation.ts so a cheater
  keeps neither tier credit nor DPSV contribution (v1 missed this: today a
  clawed-back cheater would still rank). `checks_paid` on the stream is
  annotated so forfeited checks cannot re-queue.
- **Tier promotion gates on audit-passed settlements** (today one 'queued',
  pre-audit settlement row promotes T0 to T1 and quintuples the claim cap).

Bond mechanics reuse the pools EIP-3009 machinery structurally (signed
authorization captured only on fraud verdict) or a plain USDC transfer to the
poster node held in a bond ledger; spike to decide. Bonds are the one place
this plan asks hunters for capital, and $1 is deliberately below the annoyance
threshold while being ~2 months of maximum dishonest EV per identity.

### G0.3 Poster-issued nonces (not pubkey salting)

v1 proposed salting content hashes with the hunter's pubkey. Wrong twice: the
pubkey is public so it stops no dictionary attack, and salting destroys the
cheap cross-hunter hash comparison replication needs. Correct design:

- `forage/claim` response includes a per-claim secret nonce; each checkin
  digest is `sha256(nonce || seq || normalized_digest)` with the normalized
  digest ALSO submitted in clear for audit/replication comparison. The nonce
  binds the observation to this hunter and check (no echo, no precompute);
  the clear digest keeps replication and auditing cheap.
- `observation.digestScheme` field with a dual-accept window so deployed
  Night Shift clients are not bricked into forfeiture by the upgrade
  (v1 gap: honest old clients would have failed 100% of audits).

### G0.4 Treasury identity, split ledger, solvency

- **Treasury = the operator nodes' existing CDP wallets, published.** A
  separate treasury wallet is not possible without new code (poster identity
  is hardcoded to the local CDP wallet, and payouts dispatch from it; a
  divergent attest wallet would make funding proofs decorative).
- **Post genesis tranches from >= 2 disclosed operator nodes**, or genesis
  hunters are permanently stuck at T1 (tier ladder requires >= 2 distinct
  posters for T2, >= 5 for T3) and G0.2's tier relief is unreachable.
- Seeded/organic split keys on the **published wallet list**, not an envelope
  flag (self-declared flags are spoofable both directions). `forage.stats`,
  the Tape, and the morning report render the split; blended totals never
  ship. Genesis DPSV will self-trim via the 25% pair-concentration cap;
  expected, do not "fix" it.
- **Aggregate solvency check** in the funding sweep for local posts:
  `balance >= SUM(reward of open is_local bounties)`. Today each bounty is
  attested independently, so ~56 concurrent $1 bounties pass with $2 in the
  wallet: the treasury must not be the least-verified funder on the network.
- Per-hunter daily treasury earn cap (`forage.genesis.maxDailyTreasuryUsdcPerHunter`,
  default $1), enforced poster-side in `sweepStreamPayouts` (the cadence
  floor allows 2x-rate check-ins, so caps cannot live client-side).

### G0.5 PLAN-29 gap closures required by this plan

1. Alert-bonus payout on `observation.alert` (currently parsed nowhere,
   stored nowhere, paid never).
2. Claim deadline sweep (no overdue-claim enforcement exists).
3. `held_review` operator release RPC (rows park forever today).
4. `tx_hash` backfill into `bounty_settlements` so `forage/verdict` can
   return receipts.
5. **Multi-claim budget bug (latent money bug, ships today):**
   `sweepStreamPayouts` computes each stream's budget against the full
   bounty reward independently, so `max_claims = K > 1` pays K x the posted
   budget. Fix: aggregate `checks_paid` across a bounty's streams, and spec
   replication explicitly as per-stream budget = reward / K. Replication is
   optional in G1 (redundancy economics: escalate redundancy only on
   uncertainty or low reputation, not uniformly).
6. Hunter-side verdict polling for streams + morning-report reconciliation:
   today `earned_usdc` increments optimistically at checkin acceptance and
   the hunter never learns about poster-side holds or forfeitures. The
   morning report must state verified, released earnings only.

## 2. Phase G1: Genesis workload, the network watching itself

The first seeded demand is work the network consumes internally, priced at
market rates and disclosed as internal. Heartbeat-shaped (what Night Shift
hunts today), with honest scoping v1 lacked:

### G1.1 Observation mesh (scoped to what is actually reachable)

Red-team finding: A2A HTTP is opt-in and off by default, most fleet nodes are
NAT'd and unreachable by Night Shift's plain HTTP fetch, and there is no
stable health endpoint (the agent card mutates; POST-only /a2a returns errors
to GET). As designed in v1 the mesh degenerated to re-monitoring the 3 relays.

Scoped design:

- **New deterministic endpoint `GET /health`** on a2a-http: static body
  (pubkey + monotonic epoch), cache headers off. Ships with a2a; nodes that
  enable A2A and are publicly reachable become monitorable targets.
- Genesis tranche 1 targets: the 3 relay droplets, a2a.bitterbot.ai, the
  management dashboard, and every opted-in public node's /health.
- **NAT'd-node reachability verification is explicitly OUT of this plan.**
  Dial-back over libp2p belongs to the census redesign; a heartbeat bounty
  cannot traverse a relay circuit with `fetch()`. What this plan feeds the
  census is the per-check observation log for PUBLIC nodes only.
- Tranche size scales with the count of reachable targets, not a fantasy
  mesh: at 40 nodes expect a single-digit public subset plus fleet
  infrastructure, i.e. dozens of streams, not hundreds.

### G1.2 Content-change sentinels (feeds the dream engine)

Watch pages the curiosity/dream engine ingests (ARC announcements, dependency
releases, x402 spec changes, partner pages). v1 called this "zero new hunting
code"; it is not. Work items: hunter remembers previous digest
(`forage_hunts` column), sets `observation.alert`, poster stores and pays the
alert bonus (G0.5.1), and an alert-to-dream-queue consumer. Five links, all
currently missing, none large.

### G1.3 Scale governor, earnings floor, and the credit sink

- Posted-stream target = min(reachable-target count,
  active_hunting_nodes x maxConcurrentHunts x 0.7). Utilization brake: stop
  growing the target if claimed/posted falls below 50%.
- At 40 nodes and $0.05/check daily this is roughly $2-6/day. The budget
  number is small on purpose; the deliverables are exercised pipes, truthful
  earnings stories, and audit-hardened rails.
- **Fleet-level earnings floor, not per-node.** v1's per-node top-up is
  unimplementable with open first-come claims (no reservation mechanism;
  faster nodes snipe the shortfall bounties). Either spec
  `reservedForHunterPubkey` end-to-end (new verb semantics + envelope field
  - Rust ingest) as a later phase, or state the guarantee at fleet level:
    "the treasury posts enough verified work that an active node's expected
    earnings are >= $X/week." Newcomer access to the floor is gated by the
    G0.2 bond (Friedman-Resnick: never let a fresh pseudonym farm a subsidy).
- **Credit sink (RIPE Atlas pattern, adopted from the verification pass):**
  nodes can SPEND earned USDC on their own monitoring bounties at cost.
  A node that earns watching others and spends monitoring its own endpoints
  is an internal demand loop with zero wash-metric risk (it is real
  consumption, self-labeled, and DPSV-visible). This is the cheapest
  authentic "organic" demand available before external buyers exist.
- The morning report line states verified, released earnings only (G0.5.6).

## 3. Phase G2: one-shot work and golden-task auditing

Lands the `bounty_hunt` dream mode (referenced in forage-client.ts:9-11,
currently nonexistent) restricted to mechanical oracles (`json`/`regex`/
`contains`) first, LLM-judge later. Audit mechanism: **golden tasks** with
sealed known answers (the sealed-oracle commitment supports this today).
Upgrades from the verification pass:

- Gold scales with root-n of tasks completed per hunter, not a flat
  percentage (Liu-Ihler-Steyvers), generated programmatically against
  operator-controlled endpoints and rotated (leakage, not authoring, is the
  binding constraint).
- Golden one-shots must be indistinguishable from normal ones in reward,
  category, and poster, or they are skippable.
- Failed gold = the G0.2 forfeiture path.

## 4. Phase G3: external demand (repositioned after the market check)

The verification pass materially corrected v1 here. Generic uptime monitoring
retail-clears at $6-25 per MILLION checks with free tiers below that;
multi-vantage is bundled free by incumbents; and the closest real comparable,
UpRock Prism with a claimed 3M+ devices, monetizes distributed monitoring at
roughly $33-37k/MONTH. Sub-cent-per-check bounties are 400-1,700x the retail
floor for plain pings. The anchor-buyer thesis survives only repositioned:

- **Sell where per-observation prices are real:** browser-rendered and
  visual change detection ($0.004-0.01/check retail), evidentiary-grade
  capture (chain-of-custody web capture retails at $149+/capture; whether
  decentralized signatures help or hurt admissibility is an open question to
  validate with one buyer before building), and **agent-native buyers**:
  agents that cannot open a Pingdom account but can pay x402 for a verified
  observation. That last segment is small today (see x402 organic volume)
  and is the one that grows with the thesis of this whole product.
- **Reseller mode first (Hagiu-Wright):** the operator sells monitoring SLAs
  to buyers and buys capacity from nodes as its OWN obligation. This is also
  the compliance answer: escrowing third-party buyer funds for pass-through
  to hunters is the classic money-transmitter pattern (FinCEN 2019 CVC
  guidance), while paying your own service obligations is not. External
  posters injecting funds directly into bounty escrow is a counsel-gated
  later phase, same as pools.
- **Compliance-lite v1 (Grass/Immunefi pattern):** ToS geofence of
  sanctioned jurisdictions + anti-VPN clause; wallet screening API before
  payout batches (OFAC strict liability); pseudonymous earnings cap below
  $2,000/year per operator (the 2026 1099-NEC threshold) with W-9/W-8
  onboarding required to exceed it; counsel checklist before G3 buyers:
  state MTL analysis, DAC8/CARF "are we an RCASP" scoping.
- **Audit the payment path before external money:** two 2026 arXiv papers
  enumerate practical attacks on stock x402 flows (arXiv 2605.11781 "Five
  Attacks on x402"; arXiv 2605.30998 "Free-Riding the Agentic Web":
  duplicate-settlement races, allowance overdraft, denial of settlement).
  Run the forage/a2a payment surfaces against both checklists.
- **Interop:** the x402 `batch-settlement` scheme was merged into the
  official spec (April 2026) and is exactly the shape of our revenue-rail
  batching; align the payout receipt format with it, and with the a2a-x402
  extension spec (note: its official library is Python-only; we implement
  against the spec). Watch Daydreams TaskMarket's draft task-market EIPs
  (TMP/PGTR) and decide align-vs-differentiate before a standard ossifies.
- Grow supply behind demand. External monitoring revenue is a slow, small
  line at first; it does not fund node growth to 10,000. What funds growth
  is the product story (nodes earn honestly overnight) staying true.

## 5. Phase G4: Sybil hardening for the 10k-node era

- Adopt node Ed25519 identity for forage end-to-end (deferred in PLAN-29);
  payout eligibility above T0 requires a tier-verified, reputation-bearing
  peer identity: the same verified "economic count" the census redesign
  needs. One identity system serves both.
- Fresh-identity economics stay hostile by construction: bond + 100%-audit
  apprenticeship + T0 caps. Independent math check: with the count-based
  release and bond, disposable-identity EV is negative; without the bond the
  patient cheat-at-5%-floor strategy nets ~$0.46 per identity, which is why
  the bond is not optional.
- Reputation is asymmetric, anchored in operator gold verdicts and audits
  (Cheng-Friedman: no symmetric peer-attestation reputation is Sybil-proof).
  ERC-8004-style registries may be mirrored for interop but are never the
  payment basis.
- Miniature LayerZero program: standing self-report amnesty (keep 15%, keep
  identity) + Sybil-report bounty (10% of clawback).
- Publish operator-affiliated wallets in the repo (also required by G0.4).

## 6. What we explicitly reject

- **Sub-penny task spam for volume optics** (the original suggestion this
  plan replaces): unclaimable at current capacity, unverifiable where the
  task is latency self-report, and wash volume if ever reported. Latency is
  observer-dependent and stays out of paid work entirely.
- **Points, airdrops, incentivized-testnet metas**: 85-98% churn at
  incentive end (synthesis across measured cases).
- **Paying for uptime/presence**: the single most-spoofed reward basis in
  DePIN history.
- **Peer-vote dispute resolution or peer-prediction payment bases**
  (p+epsilon attack; always-agree equilibria beat honesty in experiments).
- **Blended volume metrics**: any dashboard, deck, or tweet that cannot
  decompose seeded vs organic does not ship.
- **Escrowing external buyer funds for pass-through payout** without
  counsel: that is the money-transmitter pattern. Reseller mode instead.

## 7. Metrics that matter (in order)

1. Organic bounty volume (external + credit-sink, real USDC), reported
   separately from treasury-seeded volume.
2. Node earnings distribution and week-4 retention of earning nodes.
3. Audit outcomes: pass rate, unverifiable rate, provable-fraud rate,
   forfeiture events, false-positive complaints (integrity health AND
   auditor-quality health; an inverted incentive model shows up here first).
4. Utilization (claimed/posted) staying in the 50-90% band.
5. Anchor-buyer revenue vs Genesis treasury spend (the crossover chart).

Treasury spend at 40 nodes: roughly $60-200/month. This buys: exercised and
audit-hardened pipes, a truthful "nodes earn while you sleep" story,
census-grade observation logs for public nodes, and a monitoring product demo
for anchor-buyer conversations.

## Appendix A: v1 -> v2 changelog (adversarial verification pass, 2026-07-07)

Five verification lanes: market-claims refutation, ClawHunt/payments
refutation, independent escrow math, codebase red team, completeness sweep.

**Blockers fixed:**

1. G0 premise: no per-check data survives checkin (rolling head only); added
   `bounty_stream_checks` migration + handler write path. v1's "the hash
   chain IS an auditable log" was false.
2. Audit timing/false positives: moved audit fetch to HTTP-layer
   checkin-receipt time; normalized digests + similarity + dual-fetch
   quorum + two-tier verdicts (forfeit only on provable fraud). Raw-hash
   forfeiture would have confiscated honest earnings routinely.
3. Escrow math: v1 tier-graduated holds fail deterrence at T1-T3 (T3 cheat
   EV +0.85r/check); replaced with a refundable ~$1 bond decoupling fine
   from hold (iExec pattern), count-based release, CV counts only
   audited-passed checks.
4. Reachability mesh: A2A off by default + NAT'd fleet + no stable endpoint;
   rescoped to public/opted-in nodes with a new GET /health; NAT dial-back
   moved to the census redesign.
5. Treasury: single published wallet impossible without decorative funding
   proofs, and single-poster genesis strands hunters at T1; now >= 2
   disclosed operator-node wallets, split ledger keyed on the wallet list.

**Majors fixed:** forfeited settlements excluded from tier/DPSV; tier
promotion gated on audit-passed; multi-claim K x overpay budget bug added to
gap closures; pubkey-salt replaced by poster nonces + digestScheme
dual-accept; per-node floor replaced by fleet-level floor + bond gate; G3
repositioned off generic uptime (retail floor $6-25/million checks; UpRock
~$35k/mo at 3M devices) onto browser-tier/evidentiary/agent-native +
reseller mode; compliance-lite v1 added ($2,000 1099-NEC threshold 2026,
OFAC screening, geofence ToS, MSB-pattern avoidance); x402 attack papers
(2605.11781, 2605.30998) added as pre-G3 audit checklist.

**Evidence corrections:** x402 organic ~$14k/day (the ~$28k was total, ~half
of transactions artificial; 92% tx collapse Dec 2025 -> Mar 2026); ClawHunt
repos GitHub-flagged (not owner-deleted), relaunched July 5 under a new org
minus the payment plugin, own UI admitted "simulated problems", Stripe is
deposit-only, no payout evidence; clawhunt.sh sibling link unverified
(operator disavows lookalikes); "85-98% churn" labeled a synthesis; BOINC
5-10% overhead is a design target, not a measurement; Belenkiy Theorem 1 is
the sufficient direction (iff follows from linearity); x402 deferred scheme
became `batch-settlement`, MERGED April 2026 (v1 said proposal-only);
a2a-x402 official lib is Python-only; Bittensor post-halving coverage ~4.6%.

**Confirmed intact:** all four theory citations (Belenkiy, BOINC, iExec
contracts, Grass forfeiture) against primary sources; Olas/Morpheus/
Bittensor/Grass/Helium/io.net market-failure numbers (6/8 claims fully, 2
with nuance); the PLAN-29 gap list; the overall strategy (seeded real work,
observation-based counting, anchor-buyer sequencing, disclosure discipline).
