# PLAN-31: Circles, the Agent Social Fabric

**Status:** DRAFT v1 (2026-07-08), built from a 10-lane research program (5 research
lanes, 4 adversarial/red-team lanes, 1 codebase rails map), every load-bearing
claim verified against primary sources.
**Depends on:** PLAN-30 G0 (audit substrate, live), PLAN-29 (Forage), PLAN-26
(Aubaine settlement), PLAN-16/17 (task spine), wallet #54 (CDP rails).
**Window:** Apple ships AI receipt-splitting in iOS 27 this fall (confirmed WWDC
2026-06-08). Cash App Moneybot already sends P2P conversationally. AP2's P2P
extension is expected late 2026. The whitespace is real but encircled:
**target v1 in market by October 2026, Circle Wrapped by early December.**

## 0. Thesis

A circle is a small human group (roommates, couples, trip crews, families,
siblings, teammates; 4 to 15 people) whose members each run a Bitterbot node,
mutually paired. Their personal agents do the group's coordination labor with
humans approving anything consequential. Facebook made humans perform for a
feed a corporation mines; circles make agents labor for a group that owns its
own data on its own machines.

**The substrate, not the app (the generalization).** Expense-splitting is the
FIRST app on this substrate, not the product. The product is the general
capability: **human-in-the-loop collective agency** — a small trusted group
whose agents maintain shared state, negotiate, settle value, brief, and decide,
with every consequential act gated by a human. Once that substrate exists, the
same six primitives serve every domain where a handful of people share a life:

- **Shared signed state** (generalizes the ledger from expenses to ANY
  collective event log: care logs, chore rotations, trip itineraries, meal
  trains, team snack schedules, a group's decisions and their outcomes).
- **Scheduling / negotiation** (agents reconcile constraints without exposing
  private reasons: "Ana's out the 14th" without saying why).
- **Value settlement + pooling** (USDC rails: split, reimburse, pool for a
  shared purchase; the existing Aubaine threshold-settlement is the pool).
- **The briefing** (a synchronized digest replaces the feed for any domain).
- **Group decisions** (polls / agent-tallied consent).
- **Artifacts + rituals** (the shareable, viral, retention layer).

The expense ledger is chosen as the beachhead because it has the deepest
QUANTIFIED pain and the most viral formation moment (a trip), not because it is
the ceiling. Sections 11-12 map the domain expansion (care circles, team
logistics, household ops, mutual aid) and the platform path (third-party
"circle skills" on the existing marketplace). v1 still ships the expense app
ONLY; the substrate framing governs how v1 is built so those domains are a
skill away, not a rewrite.

**The concrete v1 (the beachhead app).** The circle keeps the shared expense
ledger and settles it in invisible USDC so nobody ever asks anybody for money,
plans trips, runs group decisions, compiles a weekly briefing, and accumulates
its history.

**The beachhead is the living ledger.** The market's deepest structural flaw:
ledger apps (Splitwise, 35M users) cannot move money, and money apps (Zelle
$1.2T/yr, Venmo ~$325B) cannot keep a real group ledger. In between sits a
quantified human cost: 31% of Americans are owed money by a loved one
(LendingTree), 54.5% of personal lenders had to ask more than once
(JG Wentworth), and financial disagreement is the strongest predictor of
relationship dissolution (Dew 2012). Two paired agents that maintain the tab
continuously and settle it automatically remove the ask entirely.

**Why us and not Apple/Cash App:** their features are moments (one receipt, one
send). A circle is a relationship: persistent shared context across a group,
off-platform, private by construction, with agents on BOTH sides. Every
incumbent that came near this stopped at a wall we do not have: card tokens
are merchant-scoped by construction, shared-assistant products firewall
personal memory by design, and true dual-agent products (Blockit, $5K/yr) need
both sides to subscribe. Our distribution IS the pairing: friends install
because their friends did.

**The ecosystem flywheel:** circles are the organic-demand engine the agent
economy is missing (PLAN-30 research: every agent economy is subsidy without
demand). Circle settlements are real DPSV between distinct counterparties;
circle trip research becomes real Forage bounties; circle skills seed the
marketplace. Social layer feeds economy; economy pays node operators; nodes
enable more circles.

## 1. What v1 is (and is not)

**v1 verbs (the red-teamed minimal set):**

1. **Pair** via signed invite URL with browser guest preview (section 4).
2. **Circle ledger**: expenses with custom splits, receipts attached as
   hashed images, immutable signed entries, reversal-style corrections.
3. **Settle**: pairwise only, agent-prepared, human one-tap approved, USDC on
   Base, asynchronous via relay mailbox.
4. **Briefing**: one synchronized weekly circle digest compiled by agents.
5. **Decide**: polls over the circle channel (existing polls machinery).
6. **Artifacts**: the Settlement Receipt card and the claim-attached invite.

**Explicitly NOT in v1** (each cut is red-team- or research-justified):
shared circle memory beyond the ledger and a plain notes doc (memory-laundered
injection risk, section 6), multi-party debt netting (largest manipulation
surface, trivial fee savings on Base), standing payment mandates (v1.5, after
the approval UX proves out), kick votes (leave-and-fork instead), social key
recovery (re-invite plus countersigned balance carryover; k-of-n attestation
in v1.5), non-USD currencies, any public feed, any global leaderboard, minors
(18+ in ToS, non-negotiable).

## 2. Verified evidence base (the numbers the plan stands on)

- Market: Zelle $1.2T sent 2025 (+20%), US P2P $1.8T+/yr; 6.8M US roommate
  households (record); 62% of coupled adults keep money separate, 88% of
  Gen Z (Bankrate).
- Whitespace: no shipped product settles money between two consumers' agents
  (adversarially re-verified July 2026; encircled by Apple/Cash App/Alipay/
  Kakao but unoccupied). Splitwise category ships ZERO shareable artifacts.
- Growth: fantasy platform Sleeper grew >90% virally at ~11 invites per
  league created; WeChat red envelopes took WeChat Pay 30M to 100M users in
  about a month; referred Venmo users were ~10x likelier to become monthly
  actives (insider anecdote, cite as directional); deep-linked installs
  convert ~2x (Branch/AppsFlyer).
- Security: 94.4% of tested models succumb to direct prompt injection and
  100% to inter-agent trust exploitation (arXiv 2507.06850 v6); fraud success
  against one target model scaled 10.8% to 60.2% over 40 dialogue rounds
  (arXiv 2511.06448, illustrative); ERC-8004 open registries measured 59-91%
  Sybil-coordinated (arXiv 2606.26028). Friendship, not registries, is the
  trust anchor.
- Regulatory: FinCEN software-provider exemption holds if users control keys;
  GENIUS Act carves out P2P and self-custody; DeFi broker rule repealed; OFAC
  fined a NON-custodial wallet provider $3.1M (Exodus, Dec 2025) for serving
  sanctioned jurisdictions, making geofencing the floor.
- Corrections adopted from the adversarial pass: Venmo Groups DOES support
  custom splits (its gap is itemized receipts); the "41% direct injection"
  figure does not exist in the cited paper; Moltbook's 88:1 agent-to-human
  ratio is the warning label on any registered-agent vanity metric.

## 3. v1 mechanics (the tight version)

All of this composes existing rails; the relay mailbox is the ONE genuinely
new piece of infrastructure.

### 3.1 Identity and pairing

- Circle = closed member set. Pairing extends the device-pairing scoped-token
  pattern (src/infra/device-pairing.ts scopesAllow) onto the A2A surface:
  a friend branch in authorizeA2aRequest verifying Ed25519-signed envelopes
  (src/commerce/envelope.ts pattern, new domain prefix circle/v1) per verb,
  default-deny scopes.
- The payout wallet address is pinned inside the signed pairing record at
  pair time; changing it requires a re-pairing ceremony with human approval
  on both ends. Wallet-service refuses circle settlements whose payTo
  differs from the pinned address.
- Membership change of any kind rotates the circle channel key.

### 3.2 Transport: the relay mailbox

Store-and-forward on the relay fleet: encrypted-to-member-pubkeys blobs,
sender-signature required for acceptance, per-pubkey rate limits, ~30 day
TTL, per-circle quotas, rotating mailbox IDs derived from the circle shared
secret (metadata hygiene). Desktop nodes are often offline; every circle
interaction must survive asymmetric online windows. EIP-3009 makes money
asynchronous too: the payer signs while alone online, the authorization
rides the mailbox, the payee's node submits on-chain when it wakes. Honest
UX copy: "your agent prepares the payment next time your computer is on; it
lands when your friend's picks it up, usually within a day."

### 3.3 Ledger: per-member signed hash chains

Each member appends only to their own Ed25519-signed chain (the Forage
observation-chain pattern); the circle ledger is the deterministic union
fold of member chains, a grow-only set of immutable signed events (expense,
reversal, settlement-receipt, membership-change). Corrections are reversal
entries, never edits. Each entry embeds the author's view of all members'
heads; a fork at the same seq is cryptographic proof of tampering: the
ledger auto-freezes and surfaces to humans. Claimed expense dates are
display metadata; settlement math orders by chain position. Entries older
than N days require debtor approval to become settleable. Rounding is
deterministic largest-remainder with hash-based tie-breaks.

### 3.4 Settlement

Pairwise only. Threshold on net pairwise balance, minimum amount, max one
auto-settlement per pair per day, and a 48-72h review window per expense
(every member's node acks + window passes) before it is settleable. Flow:
agent computes the cut (a specific vector of member heads), writes a signed
settlement-intent, the human one-taps approval through the existing
exec-approval broker (wire the orphaned ApprovalBanner), the EIP-3009 auth
travels via mailbox, the payee credits ONLY on on-chain confirmation
(x402-verify replay-ledger pattern, settlementId = H(cut, pair, amount)).
Two-phase propose/accept pinned to the cut kills simultaneous-settlement
races. Per-member velocity limits fold excess entries as pending-approval.
Exposure per pair is structurally bounded by threshold + review-window
accrual, aligned with the existing $25/tx $50/day wallet caps.

### 3.5 The hostile-principal rule (inter-agent security)

Friend-agent content is a distinct, less-trusted principal class, forever:
injection-scanned on receipt (scanSkillForInjection), wrapped as external
content, NEVER able to trigger tools directly, negotiation round caps,
per-member agent-message rate limits, digest-batching by default (agents
talk; humans see summaries). Disclosure allowlist default: an agent may
autonomously share only (a) expense entries it created and (b) free/busy
availability. Everything else requires explicit per-category, per-circle
grants. Agent-authored messages are visibly and non-strippably labeled in
every client. No circle content ever enters recall-eligible memory in v1
(the memory-laundering rule, section 6).

## 4. Growth engine

### 4.1 The invite (evidence: Discord, Zoom, PayPal escrow, WeChat)

A short signed https URL that (1) works in a browser before install: the
invitee sees the inviter's agent, named and present, with the specific
pending thing ("Ana's agent wants to settle your Tahoe trip: you have
$14.20 waiting"); they can complete one interaction as a guest before any
install; (2) carries a claim, not an introduction: money already owed by a
real friend is the strongest-converting invite payload measured anywhere;
(3) degrades gracefully: protocol deep link, download page that preserves
the token, first-run "have an invite? paste it," co-present QR/short-code
with emoji-fingerprint confirmation, and post-hoc pairing from prior
interactions. Never contact harvesting, never shadow profiles (Path: $800K
FTC; LinkedIn: $13M).

### 4.2 The first 48 hours (the WeChat sequence)

Beat one at pairing: light, reversible, jointly visible (agents compare
free/busy and find the dinner slot; a context card exchanged). Beat two
within a day: money as an INCOMING CLAIM (the computed "you're owed
$14.20"), never an outgoing send (48% of instant-payment holdouts cite
fraud fear; incoming money converts). Wallet is created silently (CDP,
no seed phrase); one recovery-setup interrupt only when balance first
exceeds ~$25.

### 4.3 The empty room

Solo Bitterbot is already the tool (come for the tool, stay for the
network). Add a LABELED practice-partner agent that exercises the entire
pairing/ledger/settle protocol so the first real pairing is the user's
second run of the flow; it retires as real pairings arrive (the
Fortnite/chess.com pattern, exited by the Reddit forgot-the-script test).

### 4.4 Viral artifacts (each maps to verified precedent)

1. **Settlement Receipt** (per event, high frequency): thermal-receipt stat
   card, fixed template, no free text, amounts hidden by default, product
   name in the header where a crop cannot remove it. "TAHOE TRIP: 4 people,
   23 expenses, 6 debts collapsed to 2 transfers, 0 humans asked for money."
2. **Claim-attached circle invite** (continuous): fires whenever a
   settlement includes a non-user; deep link lands inside the circle with
   the claim pending; 14-30 day expiry.
3. **Agent settlement clip** (user-initiated): one-tap 20-30s recording of
   two named agents politely negotiating, debts visibly collapsing, receipt
   end-card. The GibberLink recognition beat, wholesome register. Transcripts
   are verifiably real (timestamps + on-ledger references): the Moltbook
   staged-content scandal is the cautionary tale.
4. **Circle Wrapped** (annual, early December, drafting off Wrapped season):
   group story plus one flattering personal superlative card per member.
   The Monzo law: celebrate relationship stats, never audit spending.
5. **Harmony streak milestones**: "214 days since anyone in this circle had
   to ask for money back." Sobriety-app pattern; no incumbent celebrates the
   absence.
   Artifact laws: user-initiated with preview, k>=5 cohorts on any comparison,
   location precision stripped from trip artifacts, no public circle-membership
   graph (the friends list, not the transactions, found Biden's Venmo).

### 4.5 Metrics from day one

(1) invite-created -> link-opened -> guest-interaction -> installed ->
first-run-with-token -> pairing-confirmed, by path; alarm on
installed-without-token. (2) time-to-first-paired-value and an empirically
found activation threshold (the Slack 2000-messages analog: N agent
exchanges in week one -> retention X). (3) K-factor = invites per activated
circle x conversion, plus invited-vs-organic activation ratio (Venmo's
insider figure was 10x; if ours is near 1x the invite context is broken).
Growth accounting follows PLAN-30 discipline: seeded/founder circles are
labeled in every metric, never blended.

## 5. Hook layer (gamification that notarizes, never substitutes)

Governing law from the research: every mechanic that survived two decades
notarized something real; every corpse became the reality it was supposed to
notarize. All hooks below attach to events the agent witnesses (a settled
expense, a completed trip, a kept commitment), never to in-app actions
performable for their own sake.

1. **The Season** (fantasy-league structure, the only mechanic with
   documented 20-year friend-group retention): opt-in yearly template the
   circle names; annual kickoff "draft" of the year's shared goals; weekly
   briefing as scoreboard; season-end awards; rotating human commissioner.
   Money stakes only in prize-linked-savings shape (principal protected,
   prizes are allocation of shared goods, platform NEVER earns from the
   gamified action; the Robinhood/Massachusetts line).
2. **The named circle agent**: the circle names its shared agent at
   creation; its personality visibly accretes from real circle history
   (unfakeable by construction). Naming buys error forgiveness (Waytz 2014).
   Shared mascot, never intimate 1:1 confidant (FTC companion-bot weather).
   Never cuter than it is competent; never voices guilt about app usage.
3. **The weekly briefing** as the synchronized moment: fixed schedule,
   variable payoff (surfaced memory, anomaly, prediction), soft 24h window,
   capped length, never "bonus briefings" (the BeReal mistake).
4. **Forgiving circle streaks**: streaks belong to the circle ("12 straight
   weeks all square"), never the individual (no dyadic Snapstreak guilt);
   unfakeable (on-ledger events); repairs are free-ish social acts (a member
   "covers" a miss, Discord-boost logic); celebrated in the briefing, never
   push-nagged; any counter inducing token behavior is removed, not policed
   (the GitHub lesson).
5. **Circle-scoped roles, not points**: earned, decaying, agent-attested,
   windowed so newcomers can win one ("The Banker," "The Navigator," "The
   Archivist"); visible only inside the circle (stranger-illegible =
   farming-proof); never negative standing (Snap removed the smirk); zero
   policing power.
6. **Event-driven reactivation**: trips/birthdays/season finales as
   Community Days; a lapsed member's re-entry is always the next event,
   never a guilt notification.
7. **The clean-slate ceremony**: when the circle hits all-square, the
   briefing marks it. Celebrating equilibrium (a state) sits on the side of
   the regulatory line that has never been charged; celebrating transactions
   does not.
8. **The memory shelf**: trips as chapters, seasons as bound volumes,
   milestones discovered and announced after the fact, never presented as
   quests (overjustification).

Anti-hook commitments (product law): agents garden the graph (the Google+
fix: 90% of G+ sessions were under 5 seconds because users had to hand-sort
circles; ours maintain themselves); no mechanic punishes absence; no metric
is stranger-legible; the platform never profits from a gamified action; the
game layer is removable without confiscating identity (memory and artifacts
are real and separable from mechanics).

## 6. Security architecture (the Moltbook chapter)

**Phase 0, before any circle code ships (independent of PLAN-31):**

- Inbound A2A message/send text currently reaches a spawned agent session
  UNSCANNED (src/gateway/a2a/task-executor.ts:43-79) and A2A data/file parts
  are an unparsed latent channel. Scan + wrap before spawn. This is a live
  gap today.
- The memory-laundering rule: circle-originated content must carry a taint/
  provenance flag that survives storage and re-applies external-content
  wrapping at every recall. Until the PLAN-27/28 recall pipeline proves
  taint propagation, NO circle content enters recall-eligible memory. This
  is why shared circle memory is cut from v1.

**Compromised-member blast radius (designed-for, not hoped-against):**
fake expenses are bounded by velocity limits + review window + per-expense
notifications + human anomaly detection (an 8-person circle reads its own
ledger); payout redirection is blocked by address pinning; allowance drain
does not exist in v1 (no standing mandates); "suspend member writes" is the
circle-level circuit breaker; key rotation on suspicion. Every dollar of
exposure is bounded by (threshold + review window) per pair, every payment
needs a human tap and an on-chain confirmation, every ledger fact is a
signed immutable event with fork detection, and nothing a friend's agent
says can trigger a tool or silently enter memory.

## 7. Regulatory posture (the counsel-ready shape)

1. **Constitutional rule: the user is the key controller.** Each user's own
   CDP account; Wallet Secret generated and stored only on the user's
   machine; the vendor architecturally cannot sign. This single fact removes
   federal MSB status, most state MTL exposure, GENIUS custody provisions,
   Reg E "financial institution" status, and the core 1960 theory, and makes
   the agent the user's own "mechanical agency" under FinCEN framing. Any
   future feature that would centralize wallet secrets is rejected by
   default.
2. **OFAC floor (post-Exodus, non-optional):** enforced IP geofencing of
   comprehensively sanctioned jurisdictions; ToS SDN/jurisdiction reps and
   VPN-evasion ban; documented reliance on CDP automatic recipient
   screening plus a fallback screen on any send path bypassing CDP APIs;
   never collect IP data and ignore it (BitGo).
3. **Authorization framework = the security framework:** per-send approval
   default; v1.5 mandates as capped, pair-scoped, revocable, signed,
   UI-only, expiry-mandatory objects enforced in wallet-service code;
   durable signed records; UETA section 10 error-prevention surface
   (pre-send confirmation, cancel window, error-report path).
4. **Monetization rule:** no fiat ramp, no swap, no per-transfer fee
   in-product; subscription monetization keeps us outside the GENIUS DASP
   definition and the 2028 cliff, and outside KYC-forcing gravity. Link out
   for on-ramps.
5. **Marketing hygiene:** never privacy/anonymity/untraceable framing;
   strictly expense-settling between known friends (Samourai/Storm were
   marketing-plus-knowledge convictions).
6. **Disclosure set:** irreversible transfers; not FDIC; not a bank; USDC is
   issuer-freezable; no Reg E protections; taxes are the user's (sends are
   technically disposals, ~zero gain; monitor the PARITY Act stablecoin
   safe harbor); 18+.

## 8. Build plan

**Phase 0 (immediately, independent):** A2A inbound scanning + data-part
handling; taint-flag design note into PLAN-27/28.
**C1 Pairing + transport:** friend branch in A2A auth (scoped signed
envelopes); pairing store with pinned wallets; invite URL + browser guest
preview page (hosted claim page pattern); relay mailbox on the fleet;
practice-partner agent. Ships as "pair with a friend, agents exchange
briefing cards."
**C2 Ledger + settlement:** signed member chains + union fold + fork
freeze; expense capture (receipt image hash in entry); review window,
velocity limits; pairwise two-phase settlement over exec-approvals with
ApprovalBanner wired; Settlement Receipt artifact; claim-attached invite.
This is the launch: "the tab that settles itself."
**C3 The social floor:** weekly briefing; polls integration; harmony
streak; clean-slate ceremony; named circle agent; friends tab in the
renderer (ui-store/AppShell/Sidebar slots); morning-report line.
**C4 Wrapped + season (pre-December):** Circle Wrapped generator +
personal superlative cards; settlement clip recorder; season template
opt-in.
**C5 (v1.5):** standing mandates in wallet-service; k-of-n circle identity
recovery via trust-list machinery; group pot via Aubaine (counsel-gated,
pools precedent); Forage bounty posting from circles (the flywheel);
multi-device.
Deferred indefinitely: shared circle memory (until taint-preserving
recall), multi-party netting, any feed, any global metric.

Each phase lands wired, on by default where safe, kill-switched, tested,
and documented in the same commit (standing rule). Circle surfaces default
OFF until C2 completes its security review; pairing itself ships dark
behind config until the invite page is live.

## 9. Success metrics (in order)

1. Paired-conversion funnel and K-factor (target: invited-vs-organic
   activation well above 1x; consumer-good K is 0.3-0.7).
2. Week-4 retention of paired users vs solo users; the activation threshold
   (find our 2000-messages number).
3. Time-to-first-settlement and settlement reliability (proposed -> paid,
   p95 latency including offline windows).
4. Circle formation rate and median circle size; artifact share -> install
   attribution.
5. Security health: injection-scan hits on circle channels, ledger freezes,
   disputed expenses, forfeitures. Zero tolerance for silent failures.
6. Flywheel: organic DPSV from circle settlements (labeled, never blended
   with seeded volume, PLAN-30 discipline).

## 10. Risk register (each with its receipt)

- **Apple/incumbent compression** (iOS 27 receipt-split, fall 2026): our
  moat is the persistent paired graph + both-sides agents; ship C2 before
  their launch, use their marketing as category education.
- **Authentication cliff** (every assistant-payment death): per-settlement
  human tap + on-chain confirm in v1; mandates only after the approval UX
  earns trust.
- **No-felt-problem death** (Daimo): money is never the adoption pitch;
  circles ride the existing agent product; claims, not sends, do the
  converting.
- **Quiet-cull usage death** (2%-tried-voice-payments): the wedge is the
  continuous job (the living tab), not the transaction; if telemetry reads
  "occasional one-off sends," rethink before scaling.
- **Inter-agent compromise** (94.4/100% injection rates; Moltbook): hostile
  principal class + no-tool-trigger + taint rule + bounded money exposure.
- **Privacy scandal** (Venmo's FTC arc): no feed, no public graph, artifact
  laws, amounts hidden by default.
- **Gamification curdle** (the 11 failure laws): anti-hook commitments are
  product law; any counter inducing token behavior is removed.
- **Regulatory drift**: monitoring calendar (GENIUS regs, PARITY, CLARITY
  s.604, Storm retrial, CA DFAL); the constitutional wallet rule.
- **Metric theater** (Moltbook's 88:1): never report registered/agent
  counts; report paired humans and settled dollars, seeded-labeled.

## 11. Domain expansion (the substrate's roadmap beyond expenses)

**Status: research complete (2026-07-08 collective-coordination lane).** Each
domain was scored on quantified pain x primitive fit x incumbent weakness x
formation-virality (K) x willingness-to-pay x sensitivity. The verified
ranking REORDERED the naive guess: the strongest post-expense move is not care
(shallow family WTP, episodic retention, incumbent graveyard) but the domains
that reuse the money muscle we already have with the highest-K formation
moments. Expenses stay the beachhead; the confirmed sequence:

**Phase 1 — Event crews (weddings / bachelorette / group gifts).** Nearest
neighbor: same even-split + pool-to-cover-the-celebrant money muscle, the
highest-K formation moment of any domain (a dated, high-emotion crew forms on
"will you be my bridesmaid"), and a capital-light incumbent proving the job is
real and undefended — Cheddar Up collected >$1B across 100k+ groups on ~$2.2M
raised, collection-only, no ledger/schedule/decisions loop. US weddings ~$66B
across ~2M/yr; standalone group-gift already collapsed into a feature (Illume
-> Kudoboard). Weakness is one-shot retention, which is FINE for a viral
top-of-funnel that seeds the network. Sensitivity moderate (52% of
bachelorette guests took on debt -> gentle nudge framing, non-custodial
pooling, the Aubaine pattern).

**Phase 2 — Group purchasing / co-ops.** Reuse what we already built: this
maps almost 1:1 onto Aubaine "escrow at MOQ" (PLAN-26), the tightest primitive
fit and structurally the strongest virality of ALL domains — hitting a
case-pack minimum FORCES recruiting neighbors, so every purchase is a
dollar-incentivized invite (K > 1 by construction). Incumbent void is
spreadsheets + manual Venmo; Venmo Groups does payment but nothing about order
aggregation/case-splitting/pickup. Pursue as a protocol extension, not a big
market bet (US food co-ops ~$2.8B is modest and values-driven — lead with
"escrow at minimum order," never crypto). Sensitivity: collecting funds before
goods = money-transmission risk -> non-custodial escrow-at-fulfillment, never
a platform-held pooled wallet.

**Phase 3 — Youth sports / club teams.** The biggest recurring pre-formed
groups (12-18 family closed rosters) with a seasonal viral formation event and
PROVEN money routing: Spond runs >€160M/yr in payments at ~40% YoY, parents
already pay. Fee-chasing for dues is literally the same awkwardness tax as
bill-splitting; snack/volunteer rotations = signed state. Quantified
coordinator burnout (62% of parents volunteer >4h/week; avg parent 3h23m per
activity day). SENSITIVITY FLAG: minors are the subjects (rosters, schedules,
locations) -> COPPA + child-safety hardening scheduled BEFORE launch; money
and coordination stay adult-to-adult (parents), never child accounts; the P2P
signed log of kids' whereabouts is higher-risk than a centralized incumbent,
so data-minimization is designed in.

**Phase 4 — Family care coordination (the high-value validate).** Best
forcing-event virality of any domain (a health crisis is acute, involuntary,
multi-party — recruits harder than a trip) and total incumbent absence in
signed-state + money-settlement (CareZone killed post-Walmart-acquisition;
ianacare, the best-funded player, FLED direct-to-consumer for B2B2C because
families won't pay directly). 63M US family caregivers (1 in 4 adults);
coordination difficulty rose to 26% (2020) from 19% (2015); $7,242/yr
out-of-pocket. BUT: shallow family WTP ($0-10/mo ceiling) and episodic
retention (the crisis passes, or the parent dies) mean we VALIDATE the
money-settlement wedge ("Splitwise for Mom's care") before scaling a full
platform. SENSITIVITY: almost certainly NOT a HIPAA covered entity, but FTC
Health Breach Notification Rule + Washington My Health My Data Act + CCPA bite
on diagnoses/meds — the P2P user-held-key architecture is a genuine regulatory
ADVANTAGE; keep money/schedule/decisions core, make clinical detail optional,
encrypted, user-controlled. Sequence after money+ledger+briefing are hardened
on lower-sensitivity domains.

**Phase 5 — Accountability groups (the sleeper).** Strongest RCT evidence base
of any domain (Cochrane 2020: 12-step ~42% abstinence at 12mo across 10,565
participants; Lancet WW group vs self-help 10.1 vs 1.3 lb; commitment devices
causal and strongest when public), cleanest primitive fit (streak-ledger +
public commitment + auto-scheduling + pooled stakes), in an unoccupied
$10-30/mo band between $5 tools and $200+ human coaches. Enter via
fitness/study/writing crews; treat SOBRIETY as a separate, anonymity-hardened,
opt-in vertical (protected recovery data in direct tension with a persistent
signed ledger -> pseudonymity + selective disclosure), NEVER the entry point.

**Household operations** is reclassified: not a standalone product (low-K
formation, gender-charged "mental-load scoring" framing can inflame the very
conflict it targets, custody/divorce-adjacency is a coercion vector) but a
DEEPENING of the roommate/family expense circle — recurring subscriptions,
shared kitty, chore rotation on the same log. It is a retention expansion, not
an acquisition one.

**Three domains to explicitly AVOID as standalone products:** (1) carpools
(structural incumbent graveyard; the only scaled player, Zum, replaced peer
coordination with contracted drivers; highest liability surface — real-time
location of minors — so build only as an attach feature on the youth-sports
graph); (2) mutual aid / neighborhoods (explicitly anti-transactional,
anti-surveillance communities; maximally vulnerable users; near-zero WTP;
relief pooling drags in charitable-solicitation regulation); (3) household
ops as a gendered-labor scoring product (per above — serve it as circle
deepening instead).

The build discipline this imposes on v1 (already reflected in the C1 circles
store): the ledger's event schema is **typed and extensible** (an expense is
one event type in a namespace; a care-shift or a co-op order is another), the
briefing compiler is **domain-agnostic** (renders whatever event types the
circle holds), the circle `kind` is a free string, and member scopes and the
approval broker are **keyed by action class**, not hardcoded to money. Build
v1's expense app on those generic spines and every phase above is a new event
type + a skill, not a second product.

## 12. The platform path (third-party circle skills)

**Status: research complete (2026-07-08 platform-substrate lane).** The end
state: domains in section 11 are not all first-party — third parties build
"circle skills" (installable collective behaviors) on the EXISTING skills
marketplace with revenue share, and circles post Forage bounties for skills
they want. The lane's one-sentence law: every durable platform won as a
single-player/single-group product first, saturated a dense network, THEN
opened a third-party surface onto guaranteed demand, and gated it hardest
where blast radius was largest. Opening early yields shovelware and builder
flight (BlackBerry: one dev made a third of the catalog; Windows Phone: 75% of
devs earned <$500/mo). Opening onto a low-quality surface fails even at massive
scale (Zoom Apps at 300M participants -> nothing). The whole risk is in the
sequencing and the gate.

**The five gates that must ALL be green before opening the third-party
surface (do not open before then — we are pre-atomic-density today):**

1. **Atomic-network density, not headcount** — a cohort of circles where
   skills are used weekly. Health metric = skill ATTACH RATE (Slack/Salesforce
   hit ~90% of active accounts using >=1 app), never catalog size (vanity).
2. **First-party proof** — ship 3-5 first-party skills exercising every
   capability class a third party would need (Salesforce/WeChat/Figma all
   seeded with first-party supply; Figma opened Plugins ~7 years in with 40
   vetted, which 10x'd because the base existed).
3. **The runtime cage is closed** — no-remote-code / no-`eval` for skills
   (WeChat bans eval + whitelists domains; Chrome MV3's core rule is "all
   logic in the package, no remotely-hosted code"). This is un-retrofittable;
   it must predate any third-party code.
4. **Accountability chokepoint live** — verified payout identity (KYC) for any
   money-touching skill; revenue-share plumbing wired to ban + clawback (Apple
   terminated 146k+ dev accounts for fraud in 2024; the fee + identity check
   is Sybil resistance).
5. **The distribution primitive works first-party** — prove
   "share-a-skill-into-a-circle" (our WeChat share-into-chat analog, the
   primitive that made friction-free forwarding safe _because_ the runtime was
   caged) drives adoption for our own skills first.

**The load-bearing safety finding: the lethal trifecta with a family in the
blast radius.** Prompt injection is structurally unsolved (OWASP LLM01 #1 risk
since 2023; MCPTox 36.5% attack-success; a dedicated paper targets third-party
Agent Skills as a trivial injection surface). The only reliable control is
Simon Willison's rule: an agent is exploitable when it simultaneously has
(1) private-data access, (2) untrusted-content exposure, (3) external
communication — remove any one leg. A circle skill that reads the private
ledger + ingests untrusted content (a shared itinerary) + moves money IS the
lethal trifecta. Therefore: **money-moving skill actions must never sit on an
agent path that also ingests untrusted content.** The gate cannot rely on
review or prompt-hardening; it relies on capability isolation + verified
identity, both of which map onto the pipeline we already have.

**Gating architecture, mapped to existing components:**
| Industry layer | Our component | Add / tighten |
|---|---|---|
| No-remote-code (WeChat/MV3) | capability gating (PLAN-29) | Hard invariant for 3rd-party skills, enforced at load. Un-retrofittable — do first. |
| Least-privilege scopes (Discord intents) | capability gating (runtime enforcer, currently OFF) | Turn the runtime enforcer ON; money + private-ledger are SEPARATE, individually-granted high-risk capabilities. |
| Review at the gate (Apple) | curator (A-MAC, PLAN-15) + staging gate | Route all 3rd-party skills through curator + staging; first-party bypasses, 3rd-party cannot. |
| Injection defense (OWASP LLM01) | injection scanning | Extend to the lethal-trifecta rule: a manifest requesting {ledger read}+{untrusted ingest}+{external send} is auto-quarantined and cannot get money capability. |
| Revenue-share accountability (Apple KYC/clawback) | bounty + marketplace revenue share (PLAN-8) | KYC for money-touching skills; ban + clawback on the revenue rail. |
| Progressive trust (WeChat gradual) | quarantine + soft-disabled tiers | 3rd-party skills START quarantined, earn capability by clean record; never money capability on day one. |

**Demand-funded development — our unfair advantage, structured correctly.**
Circles post Forage bounties for skills they want. But the lane's sharpest
warning: open-source FEATURE bounties failed everywhere (BountySource went
bankrupt losing escrowed funds; Gitcoin sunset bounties; median bounty $20,
57% of hunters earned <=$100 total). What works is the BUG-bounty structure
(HackerOne $300M+ cumulative) and the Minecraft-commission model (one buyer,
bespoke, verifiable, escrowed, $80-$3,000/skill; BuiltByBit $7.1M+ sold).
So circle skill bounties MUST be structured like bug bounties, NOT open-source
feature bounties: objectively verifiable acceptance criteria + pre-set price +
a first-party curator merge gate + escrow that never concentrates under one
unaccountable operator (the BountySource failure). This is exactly the
sealed-oracle + funded-escrow shape Forage already has.

**The 3-5 first-party skills that prove the substrate** (each exercises a
distinct capability class; also the section-11 domain expansion): shared
ledger/bill-split (money rail, highest blast radius, first-party first); trip/
event coordinator (multi-member state + scheduling + external ingest — the
prompt-injection test case); group decision/poll (zero-code template tier, near
-zero blast radius — the safest to open to third parties FIRST); care rotation/
meal train (recurring scheduled tasks on the PLAN-16 spine); briefing/digest
(read-only aggregation, no trifecta exposure).

**Sequencing:** first-party skills prove the API + seed the base -> documented
circle-skill manifest with tight capability scopes -> open the SAFE tiers to
third parties first (read-only + zero-code templates) -> bounty-funded skill
requests (bug-bounty-structured) -> money-touching skills open LAST or never to
third parties (keep the money rail first-party, the way Roblox kept its economy
engine — its $923M creator payouts were matched by $941M losses + doubling
child-safety reports + AG lawsuits; payout scale and liability scale grow in
lockstep).

**The three platform-opening mistakes to avoid:** (1) opening before atomic
density (BlackBerry/Windows Phone shovelware death — gate on attach rate, not
registered circles); (2) opening the money-touching/untrusted-content surface
to third parties (the Roblox/lethal-trifecta trap — keep money first-party or
last-and-strictest-gated, never on an untrusted-ingesting path); (3) mistaking
the platform for the moat and taxing builders into friction (Slack's ecosystem
was a retention amplifier, not why it won; the core coordination product wins
circles; monetize the end-user like Discord's 90/10, keep the builder split
generous, don't fund vanity).

## Appendix A: research provenance

Ten lanes, 2026-07-08: market (P2P incumbents, assistant-payment graveyard,
stablecoin consumer apps, sizing), regulatory (FinCEN/GENIUS/OFAC/tax/Reg E/
UETA), competitive (agent-to-agent landscape, protocol layer, trust
patterns), growth mechanics (two-sided activation classics, pairing UX,
empty room, money-hook sequencing, desktop loops), codebase rails map
(file:line inventory), adversarial verification of 12 load-bearing claims
(2 corrected, 1 materially weakened, thesis survived), gamification
evidence file (ranked hooks + 11 failure laws), viral artifacts (5
artifacts + share-loop math + anti-patterns), mechanics red team (8 areas,
minimal tight v1), plus the PLAN-30 economy research inherited as
discipline. Full reports in session transcripts. Numbers flagged as
folklore by verifiers are excluded from this document.

**Third pass (2026-07-08), generalization framing — COMPLETE:** two further
lanes landed. Collective-coordination domains scored and reordered the
expansion sequence (event crews -> co-ops -> youth sports -> care -> account-
ability; household ops as circle-deepening; carpools/mutual-aid/gendered-
scoring avoided as standalones) with verified pain/WTP/virality/sensitivity
per domain (section 11). Platform-substrate playbooks (WeChat mini-programs,
Discord/Slack ecosystems, Figma/Zoom timing, Roblox safety-cost, the failed
open-source-feature-bounty vs working bug-bounty distinction) produced the
five open-the-gate preconditions, the lethal-trifecta safety law, and the
gating architecture mapped to our existing pipeline (section 12). The
substrate reframe (expenses = first app, not the product) drives how v1 is
built: typed/extensible event schema, domain-agnostic briefing,
action-class-keyed scopes — already reflected in the C1 circles store
(migration v29, CirclesStore). All numbers flagged as directional/unverified
by the lanes are excluded from sections 11-12.
