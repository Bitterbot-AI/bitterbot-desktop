# PLAN-31: Circles, the Agent Social Fabric

**Status:** DRAFT v2 (2026-07-08) — CONNECTION-FIRST reframe. Built from a
13-lane research program (5 market/mechanics + 4 adversarial/red-team + 1 rails
map + 2 substrate/domain + 1 connection-first lane in flight), every
load-bearing claim verified against primary sources. **The pivot from v1 of
this doc: the product is the trusted connection graph and agent-to-agent
conversation, NOT bill-splitting. Money is the yield, demoted to Phase 2 on a
warm graph. Reason: it solves cold-start (the graph forms with zero money/
regulatory friction) and dodges the money-first death every stablecoin-P2P app
suffered.**
**Depends on:** PLAN-30 G0 (audit substrate, live), PLAN-29 (Forage), PLAN-26
(Aubaine settlement), PLAN-16/17 (task spine), wallet #54 (CDP rails).
**Window:** v1 is the connection graph and agent-to-agent social layer — it has
NO incumbent racing it (Apple/Cash App/AP2 are all money-first; see section 12
competitive), so v1 should ship as fast as it is safe to start the flywheel.
The clock applies to the Phase-2 MONEY layer: Apple ships AI receipt-splitting
in iOS 27 this fall (WWDC 2026-06-08), so land the connection graph now and the
money layer on top of a warm graph around the time the category heats up.

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

**The beachhead is the CONNECTION, not any single app.** The magic that makes
this worth building — and the thing that solves cold-start — is the trusted
graph itself: you invite someone, they accept (or the reverse), and now your
two nodes are consented edges on each other's mesh. That handshake is the
"friend request accepted" of a social network, except the entities that then
interact are the _agents_, standing in for two people who chose each other.
Your address book comes alive: contacts you can query, that answer back, that
coordinate while you sleep, bounded by what each human allowed.

v1 ships the connection and what two connected agents do together SOCIALLY —
reachability, agent-to-agent conversation, and "ask your people" (query the
trusted graph and your friends' agents answer on their behalf). **Money is
explicitly NOT in v1.** It is the yield the graph produces later, not the hook
that forms it. This is the deliberate inversion of the money-first death: every
consumer stablecoin-P2P product we studied (Daimo built the perfect wallet and
shelved it) died because money was the adoption pitch and there was no felt
problem — Venmo already works. Facebook shipped the graph before ads; WeChat
shipped messaging + the graph before red envelopes. The social layer forms
warm and daily with zero money and zero regulatory surface; monetization lands
on top of a thriving network, where it is easy, instead of being asked to
bootstrap a cold one.

**The cold-start flywheel.** Connections form (the invite is the only ask, and
it is light) -> connected agents deliver real utility with no money involved
(reachability, ask-the-graph, ambient coordination) -> daily engagement + the
built-in reason to recruit (your people aren't here yet) densifies the graph ->
a warm, dense, trusted network now makes settlement, pooling, and collective
functions trivial to add (the trust edges, reachability, and daily habit
already exist) -> economic gravity gives people more reasons to connect. Money
is the second act on a network that already loves being there.

Sections 11-12 map the later domain apps (expense-splitting, care circles, team
logistics, co-ops) and the platform path (third-party "circle skills"). Those
are all things a _thriving connection graph_ unlocks; they are the yield, and
the substrate framing governs how v1 is built so each is a skill away, not a
rewrite. Expense-splitting in particular still has the deepest quantified pain
of the later apps (ledger apps like Splitwise, 35M users, cannot move money;
money apps like Zelle, $1.2T/yr, cannot keep a real group ledger; 31% of
Americans are owed money by a loved one, and financial disagreement is the top
predictor of relationship dissolution, Dew 2012) — which is exactly why it is
the strongest _monetization_ beat to land once the graph is warm, not the
thing we lead with.

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

v1 is the connection and the social magic on top of it. No money.

**v1 verbs (connection-first):**

1. **Connect** — mutual accepted invite creates a consented, cryptographic
   trusted edge between two nodes. Signed invite URL with a browser guest
   preview (section 4). Either side invites; the other accepts. This is the
   product's atom.
2. **Reach + presence** — once connected, your agent can reach your friends'
   agents on the mesh. The UI shows your connections and their liveness (the
   friend-node count and social-engagement surface, section 4b). Knowing your
   people are there and reachable is beat one.
3. **Agents converse** — your agent and a connected friend's agent hold an
   ongoing channel on the mesh: coordinate, remember, answer on their humans'
   behalf. Inbound peer-agent messages are a hostile principal class
   (section 6); agent chatter is digest-batched so humans see summaries, not
   noise.
4. **Ask your people** — the recurring hook: your agent puts a question to the
   trusted graph ("does anyone know a good dentist in Austin?") and connected
   friends' agents answer per their humans' disclosure allowlist. A superpower
   that exists ONLY because of the agent-mediated trusted graph, gets better
   with every friend added, and is inherently viral (to ask your people you
   need your people here).
5. **Briefing** — one synchronized weekly digest of your connections' shared
   life, per consent: what your people are up to, what needs a decision, a
   surfaced memory. Replaces the feed.
6. **Decide** — polls over the circle channel (existing polls machinery) for
   the small constant group choices.

**Explicitly NOT in v1** — deferred to later phases on a warm graph:

- **All money** (settlement, the expense ledger, pooling, mandates). This is
  Phase 2, and it is the whole point of the sequencing: money lands on a
  thriving network, not a cold one. When it lands it uses the red-teamed
  design already specced in section 3 (pairwise, agent-prepared, human one-tap,
  asynchronous via mailbox, on-chain-confirm-before-credit).
- Shared circle memory beyond a plain notes doc (memory-laundered injection
  risk, section 6), any public feed, any global leaderboard, minors (18+ in
  ToS, non-negotiable).

The C1 circles store already built (migration v29) is connection-first by
construction: it models consented membership with per-member scopes and
pinned-wallet slots that simply stay empty until Phase 2. Nothing about the
money-later decision wastes it — a settlement scope is one more entry in an
already-extensible scope set.

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

## 3. Mechanics

All of this composes existing rails; the relay mailbox is the ONE genuinely
new piece of infrastructure.

**Phase map (post-reframe):** 3.1 (identity/pairing), 3.2 (transport), and 3.5
(hostile-principal security) are v1 — they are the connection and the
conversation. **3.3 (ledger) and 3.4 (settlement) are the Phase-2 MONEY design,
preserved here fully specced so the money layer is a known quantity, but they
do NOT ship in v1.** They land on the warm graph once connection is proven.

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
talk; humans see summaries). Disclosure allowlist default (v1, connection-
first): an agent may autonomously share only (a) presence/liveness and
(b) free/busy availability. Answering an "ask your people" query, or sharing
anything from the user's private memory, requires an explicit per-category
grant — and the default answer posture is "my human can see this question; I'll
reply if they've allowed this topic." (Phase 2 adds expense entries it created
to the default set.) Agent-authored messages are visibly and non-strippably
labeled in every client. No connection content ever enters recall-eligible
memory in v1 (the memory-laundering rule, section 6).

## 4. Growth engine

### 4.1 The invite (evidence: Discord, Zoom, PayPal escrow, WeChat)

A short signed https URL that (1) works in a browser before install: the
invitee sees the inviter's agent, named and present, with a concrete pending
thing — in v1 a social one ("Ana wants to connect her agent with yours" or
"Ana's agent has a question for you"); they can complete one interaction as a
guest before any install; (2) degrades gracefully: protocol deep link,
download page that preserves the token, first-run "have an invite? paste it,"
co-present QR/short-code with emoji-fingerprint confirmation, and post-hoc
pairing from prior interactions. Never contact harvesting, never shadow
profiles (Path: $800K FTC; LinkedIn: $13M).

**Phase-2 variant — the claim-attached invite.** Once money is live, the
highest-converting invite payload ever measured is money already owed by a
real friend ("you have $14.20 waiting from the Tahoe trip; claim it by
joining" — WeChat hongbao took WeChat Pay 30M -> 100M in a month). That is the
Phase-2 acquisition accelerant; v1's invite converts on the relationship
itself, not a claim.

### 4.2 The first 48 hours (connection-first)

Beat one, at the moment of connecting: the two agents do one visible, useful,
zero-stakes thing together so the connection proves itself immediately —
compare free/busy and surface a shared open evening, or exchange a context
card ("here's what my human is up to this month, per what they allowed").
Beat two, within a day: the first "ask your people" answer lands — the invitee
either poses a question the graph answers, or watches their agent answer one
for a friend. The payoff is relational and informational, never money. (Phase 2
adds the incoming-claim beat — "you're owed $14.20" — as an additional
conversion accelerant once money is live; incoming money converts where
outgoing sends hit the 48% fraud-fear wall, but it is not the v1 opener.)

### 4.3 The empty room

Solo Bitterbot is already the tool (come for the tool, stay for the
network). Add a LABELED practice-partner agent that exercises the connect ->
converse -> ask flow so the first real connection is the user's second run of
it; it retires as real connections arrive (the Fortnite/chess.com pattern,
exited by the Reddit forgot-the-script test). Between install and first
connection, the UI shows legible progress toward a warm graph (invites out,
people discovered, what one connection would unlock) with agency, never a dead
empty screen.

### 4.4 The connection UI + social-engagement surface (the user's ask)

The North-Star surface is the connected graph made visible. In the renderer
(new "People"/"Circle" pane; ui-store/AppShell/Sidebar slots):

- **Connected friend-node count** — the headline number, front and center:
  how many people's agents yours is connected to. This is the metric the user
  called for and the one social networks live on (the activation-threshold
  canon — Facebook's early "N friends" magic number, etc. — lands from the
  research lane; number filled when it returns).
- **Presence/liveness** — which connections' nodes are reachable now (ambient
  "your people are here"), last-seen, without exposing a public graph.
- **Reciprocity + conversation health, not vanity follower counts** — because
  a trusted graph is small and mutual, the metrics that matter are relational:
  active conversations between your agent and friends', response rate to
  "ask your people," mutual-connection density (friends-of-friends already
  connected), and how many questions the graph answered for you this week.
  These are engagement signals that reward a _working_ graph, never a
  broadcast-follower race (LinkedIn's 500+ cap and Snap-score-anxiety
  cautions apply — no public leaderboard, no global count).
- **The weekly briefing** (section 1 verb 5) is the recurring pull that turns
  the count into a habit.

Artifact/privacy laws for anything shareable: user-initiated with preview,
no free-text templates, k>=5 cohorts on any comparison, and NO public
connection graph (the friends list, not transactions, found Biden's Venmo).

### 4.5 Viral artifacts (connection-first; money artifacts are Phase 2)

1. **"Ask your people" moments** (high frequency): a screenshot-able answer
   your graph produced — "my circle found me a dentist in 4 minutes" — the
   wholesome agent-behavior share unit (character.ai/Replika sharing culture;
   the endearing, not the glitchy).
2. **Agent-conversation clip** (user-initiated): one-tap 20-30s recording of
   two named agents politely coordinating on the mesh, the GibberLink
   recognition beat in a wholesome register. Transcripts are verifiably real
   (timestamps + signed references): the Moltbook staged-content scandal is
   the cautionary tale.
3. **Connection milestones**: "your agent is now connected with 12 people" /
   "your graph answered 30 questions this month" — status about a working
   graph, never a follower count.
4. **Circle Wrapped** (annual, early December, drafting off Wrapped season):
   your graph's year — connections made, questions answered, plans
   coordinated, time saved — plus one flattering personal card per member.
   The Monzo law: celebrate relationship stats, never audit anyone.
   Phase-2 artifacts (land with money): the Settlement Receipt ("6 debts
   collapsed to 2 transfers, 0 humans asked for money"), the claim-attached
   invite, and the harmony streak ("214 days since anyone had to ask for money
   back"). All preserved, all deferred until the money layer.

### 4.6 Metrics from day one

(1) invite-created -> link-opened -> guest-interaction -> installed ->
first-run-with-token -> CONNECTION-confirmed, by path; alarm on
installed-without-token. (2) the connection activation threshold — the
Facebook-N-friends / Slack-2000-messages analog for us: the connection count
(and/or ask-the-graph interactions) in week one that predicts retention; find
it empirically and point onboarding at it. (3) K-factor = invites per
activated user x conversion, plus invited-vs-organic activation ratio (Venmo's
insider figure was 10x; near 1x means the invite context is broken). (4) graph
health: median connections per active user, reciprocity, ask-the-graph
answer rate. Growth accounting follows PLAN-30 discipline: seeded/founder
connections are labeled in every metric, never blended.

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

Connection-first order: the money layer (formerly C2, "the tab that settles
itself") moves to Phase 2 and lands on the warm graph. v1 is C1-C3.

**Phase 0 (DONE, independent):** A2A inbound scanning + data-part handling
(shipped, commit 101d2b5); taint-flag design note into PLAN-27/28.
**C1 Connect + transport:** circles/membership store (DONE, migration v29,
commit 6d17ae1); friend branch in A2A auth (scoped signed envelopes verified
against memberHasScope); invite URL + browser guest-preview page; relay
mailbox on the fleet; practice-partner agent. Ships as "invite a friend; your
agents can reach each other."
**C2 The social launch (this is the launch now):** the agent-to-agent
conversation channel; "ask your people" (graph query + consented answers);
reachability/presence; the connection UI + friend-node count + social-
engagement surface (section 4b) in a new renderer pane. Ships as "your people,
reachable through your agent." No money.
**C3 The social floor + first artifacts:** weekly briefing; polls;
named circle agent; connection milestones + "ask your people" share moments;
the connection-Wrapped generator (pre-December); agent-conversation clip
recorder. Anti-hook commitments enforced (section 5).
**Phase 2 — the money layer (on the warm graph):** signed member chains +
union fold + fork freeze; expense capture; review window + velocity limits;
pairwise two-phase settlement over exec-approvals with ApprovalBanner wired;
on-chain-confirm-before-credit; Settlement Receipt + claim-attached invite +
harmony streak artifacts. This is where the section-7 regulatory posture and
the iOS-27 timing window apply. Gated behind counsel sign-off + the
constitutional wallet rule.
**Phase 3+ — domain apps + platform (sections 11-12):** event crews, co-ops
(Aubaine), youth sports, care; then circle-skills for third parties behind the
five gates. Forage-bounty-funded skill requests close the flywheel.
Deferred indefinitely: shared memory (until taint-preserving recall),
multi-party netting, any public feed, any global metric.

Each phase lands wired, on by default where safe, kill-switched, tested,
and documented in the same commit (standing rule). Connection surfaces default
OFF until C2 completes its security review; pairing ships dark behind config
until the invite page is live. Money stays entirely dark until Phase 2 clears
counsel.

## 9. Success metrics (in order — connection-first)

1. **Connected friend-node count and its activation threshold** — the
   North Star. The Facebook-N-friends / Slack-2000-messages analog for us:
   the connection count (and ask-the-graph interactions) in week one that
   predicts retention. Instrument it, find it, point onboarding at it.
2. Connection-conversion funnel and K-factor (invite-created -> connection-
   confirmed by path; target invited-vs-organic activation well above 1x;
   consumer-good K is 0.3-0.7).
3. Week-4 retention of connected vs solo users; graph health (median
   connections per active user, reciprocity, ask-the-graph answer rate).
4. Agent-conversation volume and usefulness (questions the graph answered;
   coordination completed) — the "is the connection doing real work" signal.
5. Security health: injection-scan hits on connection channels, suspended
   members, disclosure-grant anomalies. Zero tolerance for silent failures.
6. Phase-2 onward: settlement reliability, then organic DPSV from circle
   activity (labeled, never blended with seeded volume, PLAN-30 discipline) —
   the flywheel's yield, measured only once money is live.

## 10. Risk register (each with its receipt)

- **No-felt-problem death** (Daimo built the perfect wallet and shelved it):
  THE risk the reframe is built to dodge. Money is never the adoption pitch;
  the connection and what agents do together socially are the felt delight;
  the graph forms warm before a dollar moves. If v1 telemetry shows people
  connect but the agents do nothing useful together, that is the real failure
  signal — fix the ask-the-graph utility before anything else.
- **Empty-graph / cold-start** (the problem we claim to solve): the graph is
  worthless at n=1 connection. Mitigation = the labeled practice-partner, the
  legible progress UI, disclosed founder-seeded connections, and an invite so
  light (a relationship, not a claim) it clears the lowest bar.
- **Apple/incumbent compression** (iOS 27 receipt-split, fall 2026): does NOT
  touch v1 (they are money-first, single-moment; v1 is a persistent graph with
  agents on both sides). It touches Phase 2; land the money layer on the warm
  graph as the category heats up, use their marketing as category education.
- **Inter-agent compromise** (94.4/100% injection rates; Moltbook): the
  central v1 risk, because agent-to-agent conversation IS the product. Hostile
  principal class + no-tool-trigger + taint rule + digest-batching + disclosure
  default-deny. This is section 6, and Phase 0 already shipped the first fix.
- **Privacy scandal** (Venmo's FTC arc): no feed, no public connection graph
  (the friends list found Biden, not the transactions), artifact laws,
  user-initiated shares with preview.
- **Metric theater** (Moltbook's 88:1 agent-to-human ratio): never report
  registered-agent counts; report connected HUMANS and real agent-to-agent
  interactions, seeded-labeled. The friend-node count is a count of people who
  accepted each other, not bots.
- **Gamification curdle** (the 11 failure laws): anti-hook commitments are
  product law; any counter inducing token behavior is removed, not policed.
- **Authentication cliff / regulatory drift (Phase 2):** per-settlement human
  tap + on-chain confirm; the constitutional wallet rule; monitoring calendar
  (GENIUS regs, PARITY, CLARITY s.604, CA DFAL). All deferred with money.

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

**Fourth pass (2026-07-08), connection-first reframe:** the product's center
moved from bill-splitting to the trusted connection graph + agent-to-agent
conversation, with money demoted to Phase 2 (this doc v2). One research lane
is in flight — social-activation "magic number" canon (Facebook N-friends,
etc.), connection-count / social-presence UI patterns, the connection-first-
agent whitespace re-check, and the social-graph-first-then-monetize cold-start
evidence. The activation-threshold numbers land in sections 4b/4.6/9 when it
returns; the reframe itself (and the cold-start rationale) is decided. Nothing
from the prior passes is wasted — the money design (section 3.3-3.4), the
viral/gamification/security/regulatory work, and the C1 store all serve the
connection-first build; they reorder, they do not rewrite.
