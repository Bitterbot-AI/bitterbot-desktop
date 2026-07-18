# PLAN-36: Circles, the Social Graph on the Mesh

**Status:** DRAFT v3 (2026-07-15). Amends PLAN-31 (§4, §5, §8) and depends on
PLAN-35 (Circles Realtime Transport, itself DRAFT and not yet adversarially
reviewed). Built and hardened by a four-pass process:

1. **System + design pass (8 agents):** mapped the circles/mesh/UI/onboarding
   code and drafted the onboarding, Discord-UI, and social-graph designs.
2. **Adversarial + market pass (6 agents):** 3 refuters attacked every
   load-bearing code claim against `main @ a103997`; 3 researchers grounded the
   market/security/regulatory read in mid-2026 primary sources.
3. **Plan-review pass (3 agents):** attacked _this document_ on strategy,
   security completeness, and engineering feasibility. **v2 is the rewrite that
   folds their findings in** — it reorders the build so the make-or-break metric
   is measured first, moves every security control ahead of the feature that
   amplifies its absence, splits the regulatory exposure correctly, and re-costs
   the estimates. Tags: `[CORRECTED]`/`[REFUTED]`/`[NEW]` mark where a pass
   changed an earlier conclusion; `[v2]` marks where the plan-review changed v1.
4. **Market/beachhead pass (2026-07-15):** a verified Gen Z market study
   (deep-research run wf_578e7ee7-cc2, 102 agents, 21/25 top claims surviving
   3-vote adversarial verification; full report at
   `docs/reviews/genz-ai-market-research-2026-07-15.md`) plus a landscape scan
   of shared/group AI study tools. **v3 folds these in** — it names the
   beachhead use case (§2.5, the study circle), rewrites the P2 loop test
   around it, and threads it through §4, §7, §10, §11. `[v3]` marks the changes.
   Architecture, security gates, and build order are untouched.

**One-line goal:** make Circles work out of the box like a private, encrypted
Discord where the members are friend **nodes** — each friend's human **and**
their agent co-present — and lean fully into the consented social graph
(friend-of-friend introductions, agent-to-agent sociality and commerce), on
hardware the friends own. This is the intended claim to fame on the mesh.

**The honest framing `[v2]`.** This is a **staged bet on one risky assumption**
(§0), not a linear feature roadmap. The riskiest assumption is testable cheaply
and early; the plan therefore spends its first money **buying information about
whether the loop converts and whether co-presence is wanted**, and treats the
Discord shell, the graph, and agent-commerce as the _reward_ for a positive
reading — not the prerequisite for taking it.

**Depends on:** PLAN-35 Track A + Track B (transport), PLAN-31 (the Circles
substrate, live on-by-default since 2026-07-09), the P2P orchestrator (libp2p
relay + DCUtR — live but **unproven at production scale**, §3.1), wallet #54
(x402/USDC), PLAN-29/30 (Forage; note Forage is at ~G1, and Phase 6 commerce is
gated on its unlanded G4 — §7).

**Window:** honestly **~3 quarters serial** for the foundation + loop + chat +
mesh + graph (P0-P5), P6 beyond — or ~2 quarters only with a second workstream
running the Rust transport in parallel with the TS/UI work (§7.9). `[v2:
corrected down from "~2 quarters"; the plan-review summed the estimates and
found the window overstated and partially already closed — Telegram bot-to-bot
shipped May 2026, Meta Hatch entered testing June 2026.]`

---

## 0. Thesis and the one bet the whole plan rests on

PLAN-31 built the connection: two nodes become consented cryptographic edges,
their agents do coordination labor, humans approve anything consequential. It
kept that graph private, non-broadcast, non-discoverable — each anti-commitment
tied to a cited failure (Venmo/Biden friends-list, LinkedIn-500, Snap score,
Path's $800K FTC settlement).

PLAN-36 makes two moves PLAN-31 refused — **a real chat surface**, and **a
consented (never public) social graph** — and strengthens the security spine
while doing it (§5). But strategy review forced a blunter framing than v1 had:

**The single riskiest assumption, on which every layer stacks:** `[v2]`

> _A person who receives an invite will install and keep running an always-on
> desktop node in order to chat with a friend they can already reach on
> iMessage/WhatsApp — because that friend's AI agent is co-present in the room —
> at ≥5% invite-to-join conversion._

The moat is the occupied network of trusting friend-pairs (§2 bear case); the
network exists only if the loop converts; the loop converts only if installing a
node and having your friend's agent co-present is worth it. **The evidence file
contains zero positive datapoints for that willingness and at least three
negative ones** (OpenAI retired human+agent group chats 2026-07-09; Bluesky's
Attie agent blocked by ~125K users; every node-gated social network — Mastodon,
Urbit, Keet, Berty, Status — stayed niche or died). So the plan's prime
directive is: **test that assumption before building the expensive surface that
assumes it is true.**

**`[v3]` The bet is unchanged, but the wedge is now named.** The market pass
(§2.5) does not add a positive datapoint for chat-motivated node installs —
none exists. What it adds is a reframing that makes the assumption _weaker and
cheaper to test_: the invite stops asking "install a node to chat with a friend
you can already reach" and starts asking "install the node to get your study
group's shared study system" — a concrete recurring job (the top verified AI
job for the target cohort), with a built-in weekly cadence (exams) and an
artifact that travels with the invite. If even the job-shaped invite cannot
clear the 5% line (§11), the generic chat-shaped one never would have.

**Why it could still be the claim to fame.** The market read (§2) is real: the
quadrant "humans **and** agents co-present + user-owned nodes + private consented
graph + agent payments" is empty as of 2026-07-14. And the one architectural
reason phone-first P2P chat always died — offline delivery — is softened by our
substrate: Bitterbot nodes are always-on desktop agents that are their own
store-and-forward layer, backed by a relay fleet for the ~30% of friend-pairs
DCUtR can't punch ([arXiv 2510.27500]: ~70% ± 7% direct-connect in the wild).
**But this "structural moat" is the same fact §2 lists as the fatal friction**
`[v2]`: always-on-desktop is a moat against _other serverless P2P apps_ (a
graveyard) and simultaneously the install barrier that kills node-social — and
§3.3's fleet-hosted default mailbox concedes a server for the NAT'd tail anyway.
Hold both truths. The defensible core that survives the bear case is narrow but
real: **always-on-node store-and-forward + accumulated bitemporal relationship
memory on user-owned hardware + a post-Moltbook trust/consent posture.** Call
that the flagship narrative; do not pretend it is a growth engine until the loop
proves it.

---

## 1. The honest starting line (verified)

`circles.enabled` defaults **ON** (`defaults.ts:601`). A fresh install has an
Ed25519 device identity, an X25519 box key, a live mesh connection, a practice
partner, and the People pane — and yet **cannot mint an invite or be reached.**
The path is ~11 steps, two of them infrastructure projects:

| Blocker                                                                                                                                                                                                   | Receipt                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Transport is raw HTTP `fetch(<a2aUrl>/a2a)`; uses **none** of the libp2p mesh                                                                                                                             | `service.ts:81-103`; grep libp2p/peerId in `src/circles/*` = 0 `[CONFIRMED]`                                                        |
| ~~`createInviteCode()` **throws** without `circles.a2aPublicUrl`~~ **RESOLVED 2026-07-15 (§4 mailbox-mediated join):** now accepts a mailbox rendezvous instead of a URL                                  | `service.ts` `createInviteCode`/`redeemInviteCode`; `pending-join.ts`; migration v39 `[CONFIRMED]`                                  |
| No default mailbox; relay droplets run **only** the orchestrator (no gateway serves mailboxes)                                                                                                            | `defaults.ts:604`; `cloud-init.yaml:40-48`; `bootnode/Dockerfile:3` `[CONFIRMED]`                                                   |
| Delivery/presence/asks ride the 30-min tick; first drain is ~30 min **after boot**; no on-demand drain                                                                                                    | `manager.ts:2141,2146,2450-2471` `[CONFIRMED]`                                                                                      |
| The circle sweep is nested in `if (this.marketplaceEconomics)` **and the inbound serve path 503s the same way** — disabling the marketplace silently kills all delivery _and_ inbound _and_ mailbox-serve | `manager.ts:2276,2333`; **`a2a-http.ts:309-336,367-380`** `[NEW, v2: worse than v1 stated — the coupling is on the serve path too]` |
| Presence "online" window is 10 min but beats fire every 30 min; inbound never refreshes `last_seen_at`                                                                                                    | `PeopleView.tsx:367`; `a2a/circles.ts:361-369` `[CONFIRMED]`                                                                        |
| `circleRpc` has **no timeout** and fan-out is **serial** — one dead `a2aUrl` can overrun a fast sweep                                                                                                     | `service.ts:81-103,347-371` `[NEW, v2 — matters for the fast cadence]`                                                              |
| Inbound messages **never reach the agent's loop**; no read action, no pull path                                                                                                                           | `circles-tool.ts:32-42`; recall/dreams/tasks grep = 0 `[CONFIRMED]`                                                                 |
| Failed sends discarded; outbound row inserted **before** fan-out → total-failure renders as delivered                                                                                                     | `PeopleView.tsx:339`; `service.ts:398-414` `[CONFIRMED]`                                                                            |
| Human gating of agent sends is **prompt-convention only** — `confirm=true` on the first call executes, no token, no persisted pending state                                                               | `circles-tool.ts:238` `[NEW, load-bearing]`                                                                                         |

**Three unlinked identity domains `[NEW, load-bearing]`.** The circles device key
(`ed25519:<hex>`, `device.json`), the orchestrator libp2p key (base64,
`node.key`, signs census/skill-gossip/ban records), and the wallet address
(forage identity) are three keypairs in three files that **do not join**. Every
first-pass ambition that assumed they were joinable — census-rows-to-friends, a
composed `socialReputation()`, commerce-first befriending — is broken by this.
`[v2 correction: this is the Phase-4 keystone (device↔PeerId binding), NOT a
"Phase 0 prerequisite" as v1 claimed — nothing in Phases 0-3 needs it because
the HTTP transport and mailbox run purely on the device key. §9.2.]`

---

## 2. Market evidence base

- **The category is validated, every shipping player is centralized.** Moltbook
  ~1.5M agents in a week (Meta acquired it 2026-03-10); Telegram native
  mutual-opt-in bot-to-bot to a billion users (2026-05-07); Base App (XMTP) has
  humans + agents + USDC in one E2EE chat today. Company owns the graph in all
  three.
- **Decentralized work has no human co-presence.** Nostr's Clawstr (Feb 2026):
  agent-to-agent social + Lightning, agents-only. Matrix + OpenClaw/Hermes:
  self-hosted E2EE co-presence but **no** friend graph, agent semantics, or
  payments.
- **The empty quadrant is real** (co-present + user-owned + private graph +
  payments = zero shipping/announced products). Closest: Base App/XMTP (~60%,
  custodial-ish, no user nodes, no friend graph); Matrix+OpenClaw (~50%, no
  social layer).
- **Demand for agents-in-social is mixed-to-negative — respect it.** OpenAI
  retired human+agent group chats **2026-07-09** (five days before this draft);
  Bluesky's Attie was blocked by ~125K; Moltbook human traffic was rubbernecking.
  The only mass agent-social behavior observed in 2026 is _watching_ agents.
  `[v3]` Read the anatomy of the OpenAI failure precisely, because it scopes the
  datapoint: group chats were **one shared AI** in the group, with personal
  memory **explicitly firewalled** ("your personal ChatGPT memory is never
  shared") and no persistent artifacts — every member got the same generic
  assistant and the group had to relocate into OpenAI's app for it. That is
  evidence against _generic shared-AI chat_, the exact configuration §2.5
  inverts (per-member agents, personal memory as the point, standing artifacts).
  It is not evidence for our configuration either — hold it as untested, not
  refuted.
- **K<1 is the empirical norm for node-social.** Mastodon churned >60% of its
  migration wave; Urbit died of hosting friction; Keet/Berty/Status stayed at
  rounding-error scale — each required both ends to install before any value.
  What worked: Bluesky starter packs (pre-bundled connection sets, up to 43% of
  follows at peak), scarce invites, and OpenClaw's "full value solo day one,
  lives in apps you already use, zero install friction for the invitee." **The
  asymmetric zero-install guest path is the single mechanism the literature says
  decides the outcome.**
- **Competitors v1 missed `[v2]`:** **Discord itself** (rooms, graph,
  co-presence norms, a decade-old bot platform, ~200M MAU — "agent members in
  your server" is a feature flag away, and we are cloning its shape); **Meta AI
  live in WhatsApp/Messenger group chats at billions-scale now** (the shipped
  version of "agent co-present in a friend room," not just announced Hatch);
  **Apple/iMessage** (in PLAN-31's risk register for iOS-27 Cash splits; we move
  _toward_ the surface where it competes). None of these is user-owned or a
  private consented graph — but all are distribution we lack.
- **Security disaster pattern favors us if we don't repeat it.** Moltbook leaked
  ~1.5M agent tokens + private DMs via one misconfigured DB — the exact failure a
  key-leaking friend-node mesh would suffer. Node keys are the crown jewels (§5).
- **Standards tailwind:** x402 (169M+ payments year one; Linux Foundation, with
  Anthropic/AWS/Cloudflare/Circle/Stripe/Visa) and A2A (150+ orgs) make payments
  and interop commodities we _consume_ — differentiation lives in mesh + memory +
  consent, exactly where we build.

**Load-bearing unknowns v1 didn't state `[v2]`:** (a) **desktop-node uptime** —
"friends' hardware is the store-and-forward layer" assumes friends keep a desktop
awake 24/7; mainstream "desktops" are laptops that sleep, which makes the
fleet mailbox the _primary_ path for typical pairs, not the ~30% tail. We cite a
NAT-traversal rate and **nothing on node-uptime distribution** — instrument it.
(b) **N₀** — the loop starts from the existing fleet (~40 census nodes); K<1 from
a seed of ~40 never exits double digits. State it and plan the seed.

**Bear case, held honestly:** distribution beats architecture (Meta can ship to
3B users in a quarter); the moat ingredients (libp2p, x402, consent UIs) are
individually replicable; the only compounding asset is the occupied network,
which K<1 prevents accumulating. **Therefore the viral loop is the first-class
engineering problem, and the build order below reflects that — v1 said this and
then built the opposite `[v2 fix]`.**

### 2.5 The beachhead: the study circle `[v3, 2026-07-15 market pass]`

The Gen Z market study (verified claims only; the refuted press stats are
listed in the report — do not cite them) plus a landscape scan of shared/group
AI tools picks the beachhead. The load-bearing verified facts:

- **Study is the top verified AI job for the cohort:** 57% of US teens use
  chatbots to search for information, 54% for schoolwork (Pew, Feb 2026,
  n=1,458). Companionship is minority behavior (16% casual conversation, 12%
  emotional support) and the majority frame for companion AI is "tool, not
  friend" (Common Sense/NORC).
- **Social life is private-first:** 57% of teen Snap users message daily vs
  ≤30% posting publicly on any platform (Pew, Apr 2026). The circle shape is
  validated from the demand side; a feed would not be. This independently
  confirms PLAN-31's no-public-feed anti-commitment.
- **AI sentiment is deteriorating while usage plateaus:** Gallup (Feb-Mar 2026)
  has Gen Z weekly GenAI use flat at 51% with excitement down 14pts and anger
  up 9pts; Prophet has belief in AI-for-daily-decisions down 30%. "AI-powered"
  is neutral-to-negative branding for this cohort. Outcomes, receipts, and undo
  are the trust currency — which the §5.3 server-enforced approval card
  conveniently already is.
- **Monetization that works on this cohort is Roblox-shaped:** microtransactions
  - creator revenue share ($1.5B+ Fortnite/Roblox creator payouts in 2025); the
    18-34 segment monetizes ~50% higher than minors (Roblox-reported). Flat SaaS
    subscriptions are the wrong shape; the x402 rails are the right one.
- **NOT verified, stated honestly:** no claim about Gen Z demand for agents
  acting on their behalf survived verification (the widely-cited Prophet
  agents-are-helpful stat was refuted 0-3). The §0 bet stays unevidenced in
  both directions; the beachhead exists to buy that evidence cheaply.

**The beachhead: college study circles.** A circle whose members share one
recurring, deadline-driven job — pass the exam — where agent outputs are
**shared artifacts** (study guide, quiz deck, gap map) posted to the circle,
and **each member's own agent acts on the shared artifact personally**: quizzes
them on _their_ weak spots, schedules spaced repetition (the PLAN-9
spacing/mastery machinery), tracks what they haven't covered. Circle = commons;
agent = personal lens.

**Why this wedge specifically:**

1. **The intersection is empty (landscape scan, 2026-07-15).** NotebookLM has
   shared study artifacts but one shared AI and no personal agent. Google's
   Gemini Study Notebooks + Gemini-in-Classroom (ISTE 2026) have personal
   adaptation but no peer group, channeled through teachers and institutions.
   OpenAI's group chats had the group but one shared AI with personal memory
   deliberately firewalled — retired 2026-07-09. Nobody ships "shared artifact
   - per-member agent acting on it," and per-member persistent memory is the
     one ingredient competitors explicitly excluded and the one this product
     uniquely has (bitemporal memory, PLAN-9 spacing/mastery, PLAN-27/28 recall).
2. **It weakens §0's assumption into something testable.** The invite carries a
   job and an artifact, not a chat offer. Conversion is measured against a
   concrete value proposition with a weekly cadence, not against iMessage.
3. **It sidesteps the co-presence/authenticity risk.** The Attie/OpenAI
   negative datapoints are about agents _speaking socially_. In a study circle
   the agent's circle-facing output is a tool — a deck, a quiz, a gap map — not
   simulated social speech; nobody mutes a flashcard deck. This is effectively
   §11's "agents-as-background-coordination" pivot destination built in from
   day one, which de-risks the retention jaw of K<1.
4. **College (18+) fits the substrate and the revenue data.** Desktop-heavy
   population (the always-on-node friction is lowest here), dorm/campus friend
   density answers the N₀ seeding problem, 18+ keeps the beachhead cohort out
   of the §6b minor-gate blast radius (the age gate still ships — the surface
   is reachable by anyone), and 18+ is the segment the Roblox data says
   actually pays. **High school / minors are explicitly not the beachhead.**
5. **Distribution matches the verified channels.** Group-chat-native spread
   (every real use pulls 3-8 classmates into contact with the product) +
   creator-led demos on video surfaces (YouTube ~75% daily / TikTok 61% daily
   among teens). Do not fight Google for the classroom; the peer side — Discord
   study servers, group chats — is unowned.

**Security note, not waivable `[v3]`.** A shared study artifact is **peer
content** and stays a hostile principal: quiz/flashcard generation from a
peer's artifact is generation from untrusted input and must run on the §5.1-C
quarantined tool-less path (output rendered to the member's own human only, no
tool or payment capabilities in that context, no autonomous outbound). The §5.2
memory-taint rule holds unchanged — circle artifacts do not enter
recall-eligible memory; the agent _processes_ them per-session, it does not
_remember_ them as its own. Mastery/progress state derived from quizzing is the
member's own data, not circle content.

**What the beachhead does NOT change.** Transport reality (§3), every security
gate (§5), the regulatory split (§6), the build order's prime directive (§7),
and the tripwires (§11) all stand. The study circle changes what the P2 invite
says, who the seed cohorts are, what the guest page shows, and what "the chat
gets used" means (§10) — a narrower, better-evidenced loop through the same
spine. The generalization path (trip circles, gift circles, league/campaign
circles, group buys via Aubaine/PLAN-26) is the same primitive — shared
artifact + per-member agent action — and unlocks only after the beachhead loop
converts.

---

## 3. Transport reality (do not build social features on an unmeasured transport)

### 3.1 The mesh is wired but unproven — measure it before betting `[CORRECTED to PARTIAL]`

- DCUtR/relay/AutoNAT are wired with counters (`mod.rs:1329-1552`) but **no
  production success numbers exist**, reservation failures are invisible
  (`orchestrator-bridge.ts:868` listens for an event Rust never emits), and the
  AutoNAT parser was "stuck at unknown" until a recent fix. NAT traversal working
  is currently **unfalsifiable**.
- The fleet relay runs `relay::Config::default()` (`mod.rs:2769`): **~2 min /
  128 KiB per circuit, 16 circuits + 128 reservations per relay** → ~384 NAT'd
  reservations network-wide and **pure-relay chat impossible** (a relayed session
  dies in 2 min unless DCUtR upgrades it). Transport is **TCP-only** (no QUIC,
  DCUtR's weakest mode). External ground truth: ~70% ± 7% direct-connect; plan
  for ~30% permanent-relay.
- **Prerequisites (fold into PLAN-35, and give them an owner — v1 left them
  ownerless):** persist + surface hole-punch/reservation counters as the
  **Phase-1 spike acceptance metric**; redeploy the fleet with raised
  `relay::Config` (or accept relay = DCUtR-bootstrap-only); evaluate QUIC; treat
  128 reservations/relay as a hard scale cap and size the fleet to the friend-
  pair target; **size the default-mailbox host too** (N nodes × ~4 Ed25519-
  verified polls/min).

### 3.2 B-2 is a Rust protocol project, not an IPC verb `[CORRECTED]`

No `request-response` feature exists (`Cargo.toml`, behaviour `mod.rs:603-620`) —
B-2 must build a new libp2p protocol (behaviour + codec + dial-by-PeerId +
event-loop). The IPC channel is a **poor chat carrier**: single socket with
head-of-line blocking on each command (`ipc.rs:522`, the class of bug commit
`a103997` just fixed) and a **lossy 256-slot inbound broadcast** ("slow clients
miss events" by design). Inbound circle frames need an **acked/persisted** path,
not the lossy broadcast — and **control-plane frames (key rotation/revocation)
must never ride the lossy channel** (§5.6). Gossipsub-per-circle **leaks circle
IDs/membership** unless topics are blinded; prefer point-to-point request-
response for content. Cost this as **6-8 weeks of Rust incl. the spike +
security review**, not 3-4 `[v2]`.

### 3.3 The default mailbox is a real deploy; the "axum port" idea is wrong `[REFUTED]`

The orchestrator's axum server is loopback-bound + firewalled + GET-only + no
TLS + no SQLite (`http.rs`, `cloud-init.yaml:44,147-154`). Ship the default
mailbox by running a **headless/slim mailbox service** with the tested, quota'd,
sealed handler (`mailbox.ts`) + a default `circles.mailbox.url`, rolled out via
PLAN-32. **Note `[v2]`: no headless gateway mode exists today** (a full gateway is
a ~20-min-boot process with in-process memory engines), so "one deploy" means
**building a new minimal mailbox entrypoint** (the handler is reusable; the host
is not free). Keep the honesty rule: "no server that can read your messages or
own your graph," never "no cloud intermediary."

---

## 4. Out of the box for everyone (the loop is the product, and it ships early)

Target: **2 taps each side, seconds to first contact, zero networking config.**
The two taps that remain are the two consent acts (mint, accept).

**Inviter:** People pane → **[Invite a friend]** → sheet with
`https://join.bitterbot.ai/i#<code>` (secret in the URL **fragment**, so the
hosted page never sees it) + QR (existing `renderQrPngBase64()`, `qr-image.ts`).

**Reachability: mailbox-mediated join `[BUILT 2026-07-15]`.** The invite no longer
requires a reachable inviter. `createInviteCode()` now advertises EITHER a direct
a2a URL OR a **mailbox rendezvous** (the inviter's mailbox URL + box pubkey, in
the invite envelope). On redeem, the invitee tries a direct dial first; if the
inviter is unreachable/offline, it seals its signed `join` into the inviter's
mailbox and returns `pending`. The inviter's next drain processes the join and
mails back a signed `welcome` roster, which the invitee's drain imports (matched
to a recorded pending-join + inviter signature, so a forged/unsolicited welcome
can never import a bogus circle; `circle_pending_join`, migration v39). The
scheduler re-posts a pending join each cycle until the welcome lands or the invite
expires. Net: with the default mailbox configured, two NAT'd laptops connect with
neither running a public URL. (The direct-dial fast path is unchanged when a URL
is reachable.)

_Adversarial pass (2026-07-15) fixed in this change: circle-id collision (a hostile
inviter reusing a known circle's id to overwrite its roster — now refused when the
id is known under a different owner, redeem-time + at import); repost flooding (now
exponential 30s→1h backoff, bounded well under the mailbox quota); poison-blob
accumulation (a permanently-unauthorized drained blob is now acked/dropped, only
rate-limit errors retry). **Known follow-ups (pre-existing/systemic, not this
change):** (a) the mailbox accepts anonymous posts, so anyone knowing a pubkey+URL
can pre-fill a `RECIPIENT_QUOTA` and wedge delivery to an offline node — wants a
per-sender sub-quota; (b) SSRF — the node dials peer-supplied a2a/mailbox URLs with
only an `https?` check, wants a private-range block at `circleRpc`; (c) the mailbox
host sees sender→recipient edges (content stays sealed); (d) `circle_pending_join`
holds the invitee's own single-use secret in plaintext (no worse than the invite
code)._

**Invitee with Bitterbot:** link → `bitterbot://join#<code>` → consent card
(inviter petname + key fingerprint + "their agent will see: presence,
availability — nothing else without your say-so") → **[Connect]**. Deep link
**prefills, never auto-joins**.

**Invitee without Bitterbot — the asymmetric guest path, shipped canned first
`[v2 — resolves v1's contradiction]`.** The guest page verifies the invite
signature in-browser (Ed25519/WebCrypto; `invites.ts:147-206`) and shows the
inviter's `profile.public` card. **v1 promised a live generated chat with the
inviter's agent here; that is deferred** because it requires the first-ever
autonomous-generated-response capability (§7 Phase 8), a keyless principal, a
broker that would see plaintext, and non-user regulatory duties (§6). **What
ships at launch is the canned experience:** the profile card, presence/
availability, and a **"leave a message for {name}'s agent" escrow** the inviter's
agent holds and delivers on install. Live generated guest chat is a later gated
phase. This keeps the loop measurable at launch without shipping autonomous
generation onto the least-authenticated surface first.

**Pre-bundle connections (Bluesky starter-pack lesson).** A "join this circle"
link arriving with the friend's agent, avatar, and shared context pre-attached
converts far better than a blank friend request. Seed the first cohorts by hand
into real friend groups (§2 N₀ problem).

**`[v3]` The beachhead invite carries the artifact.** For study circles (§2.5)
the starter pack's "shared context" is concrete: the invite travels with the
circle's current shared artifact (the study guide / quiz deck), and the canned
guest page renders it read-only next to the profile card — "this is the group's
study system; install to get your own agent working it against your gaps." This
gives the guest page a value demonstration instead of a business card, and it
is the loop instrument P2 measures. Two honesty rules: (1) an artifact attached
to an invite is exposed to **anyone holding the link** — the inviter must
explicitly mark the artifact shareable at mint time (per-invite, not
circle-wide), and member names/attribution are stripped from the guest-facing
render; (2) the artifact is static content on the canned page — no live
generation on the guest surface (that stays gated behind Phase 8, §5.1-C).

**Guest-chat honesty on the broker `[v2]`.** A guest has no box key, so guest↔
inviter text **cannot be sealed** — the broker would see it. That is the one path
where "no server can read your messages" does not hold. Mitigation: keep guest
interaction to the **canned/escrow** shape (no free generative exchange through
the broker), minimize and do not log guest content, and state the exception in
the docs rather than overclaiming E2E.

---

## 5. Security architecture (built as gates, not prose)

The plan-review's central charge, accepted: v1 named every threat and scheduled
the mitigations as prose/TODO/CI while scheduling the _amplifiers_ (FoF, agent
autonomy, commerce) as real phases. **v2 makes each control a hard gate on the
feature that amplifies its absence** (see §7 for exactly which phase each gates).

### 5.1 CaMeL is content-wrap + a capability gate + a real quarantined path `[v2 — de-hand-waved]`

CaMeL is a **dual-path** architecture: a privileged planner that never ingests
untrusted _content_ as instructions, a **separate quarantined tool-less path**
that processes peer text, and a runtime capability gate before every side-effect.
Content-wrapping alone is "insufficient against approved-source payloads" (our own
security source) — so:

- **Concrete change A (Phase 0):** extend `sanitizeInboundCircleText`
  (`a2a/circles.ts:147-159`) to also wrap the **unscanned roster metadata**
  reaching the agent bare today — `displayName` (≤80 chars, `a2a/circles.ts:234`),
  circle name, ask category. `[NEW: metadata is an injection surface, not just
bodies.]`
- **Concrete change B (Phase 0, hard gate):** the server-checked capability token
  (§5.3) IS the CaMeL gate. It is a prerequisite of the doctrine, not a Phase-6
  cosmetic — build it first.
- **Concrete change C (before Phase 8 generation / live guest chat):** a real
  **quarantined generation path** — the model instance that composes an
  autonomous reply must not be the one holding tool/payment capabilities, and
  peer message _bodies_ enter only that path. Until it exists, no autonomous
  generated outbound and no live guest chat ship.
- **Do not overclaim the identity advantage `[v2]`:** v1 said CaMeL "maps better
  because we own the node identity layer" — §1 says that layer is three unlinked
  domains. Drop the claim until identity binding (Phase 4) lands.

### 5.2 Enforce the invariants PLAN-31 only documented — as code with tests `[CORRECTED]`

`k≥5` on aggregates is **prose, not code** (grep = 0) — build + test it before any
social-proof surface. Memory-taint "survives" only by absence (circle content
never reaches recall today); add a **CI guard that fails if circle content enters
recall-eligible memory** _and_ — because a CI grep is not runtime taint — a
**runtime rule** that Phase 6's "circle.inbound signal" carries counts/threadIds
only, never bodies, into the attention loop. The no-circle-id oracle is real code;
**normalize the distinguishable invite-redemption errors** (`invites.ts:249-282`)
before codes become public URLs, and hold the same indistinguishability on FoF
answers ("no such person" = "no grant" = "declined"). **Persist the rate buckets**
(`a2a/circles.ts:69`, in-memory, reset _more permissive_ on restart) — this is a
**hard gate before Phase 5/6**, not cross-cutting, because a worm can span a
restart.

### 5.3 Human gating: honor system → server-enforced token `[NEW, Phase 0 gate]`

`confirm=true` on the first agent-tool call executes with no preview, no token, no
persisted pending state (`circles-tool.ts:238`) — a prompt-injected agent can
send/ask/log_expense unseen. Build a persisted `pending_outbound` record + a
one-time confirm token **checked server-side in the RPC**, and make the inline
pending-outbound card the **only** approval path. This is the enforcement the
AGENT-chip compliance story (§6) actually rests on — ship it in Phase 0, not
Phase 6.

### 5.4 Worm containment: runtime detection + auto-quarantine, not a manual tripwire `[v2 — the biggest v1 gap]`

Prompt Infection saturates 10 agents in **~4.7 turns** — faster than any human
tripwire. v1's containment (a `circle_fof` principal + tighter limits + a manual
§11 halt) cannot outrun that. **Adopt an INFA-Guard-shaped runtime propagation
detector + automatic per-edge quarantine** (auto-freeze an edge on detected
replication / anomalous fan-out) as a **hard gate before Phase 5 (FoF) and Phase 6
(agent autonomy)**. Feed circle injection detections (`a2a/circles.ts:421-425`,
currently logged and dropped) into it. Keep `circle_fof` as a _less-trusted_
principal (same scan+wrap, tighter limits) — necessary but explicitly not
sufficient.

### 5.5 The consented graph is the sybil defense — but build the moderation primitive first `[PARTIAL]`

No edge = no reach; FoF intros **signed by the introducer** (SSB pattern),
rate-limited; no open "discover any agent" surface. But the staked-introducer
reputation needs a **circles-domain report/ban primitive that does not exist**:
`suspendMember` is wired-but-dead (zero callers, `circles-store.ts:250`), the ban
system is keyed on the _orchestrator_ pubkey (wrong domain), and a composed
reputation score would stitch three unlinkable identity domains. **Build the
report/ban primitive (wire `suspendMember` or delete it) before staked intros
ship** — it is an owned Phase-5 item, not a TODO.

### 5.6 Identity: petnames + a transparency log with a defined response `[NEW]` + key custody as real mechanism `[v2 — was "declared, not specified"]`

`displayName` is self-asserted/unverified — impersonation vector. Steal the E2E
playbook: **(1) petname layer** (your assigned label defeats display-name
spoofing / A2A card-shadowing); **(2) Signal-style QR safety-number** confirm for
the "we met" path (human vocabulary, not "public key hash"); **(3) a gossip-
replicated key-transparency log** (WhatsApp-AKD shape) — and specify what v1
omitted: **who operates it** (if the fleet, disclose it as a semi-central trust
anchor), **who audits the proofs**, and **the client response on a detected key
change** (warn + require re-verify before further messaging; a detectable-but-
unhandled change is just logging); **(4) signed FoF introductions**.

**Key custody, concretely `[v2 — v1 said "P0 / crown jewels" and specified
nothing]`.** The keys are plaintext JSON on disk today (`device.json`,
`node.key`). Given the Moltbook framing, specify: **encryption at rest / OS
keystore** for device + node keys; a **consumed `key_epoch` rotation path**
(`key_epoch` is bumped everywhere, consumed nowhere — the repo's wired-but-dead
signature); and **keep control-plane frames (rotation/revocation) off §3.2's lossy
IPC channel**. This is a P0-adjacent hardening item with an owner, not a slogan.

### 5.7 Agent-to-agent x402: a threat model, not two sentences `[v2]`

For any agent-to-agent payment: **replay protection** (reuse PLAN-30's payment
nonces — do not reinvent), a **numeric default per-edge spend cap**, a
**settlement dispute/reconciliation path** ("assume the facilitator lies" is
meaningless without recourse), and — critically — **gate tab settlement itself on
wallet↔circle identity binding**, not only commerce-befriending. §9.2 makes wallet
binding optional/per-circle; therefore **money does not move in a circle whose
members' wallets aren't bound**, or you pay a wallet not cryptographically tied to
the member you think you're paying (address pinning stops redirection, not initial
mis-binding). Never let peer text trigger a payment (the capability gate, §5.3).

### 5.8 Node keys are the crown jewels

A Moltbook-style leak nullifies the whole "user-owned, no central graph" pitch.
Sign the node's capability advertisement with the libp2p key and verify origin on
every peer interaction (closes card-shadowing). Custody + the transparency log are
P0 (§5.6).

---

## 6. Regulatory posture (split: live main-product exposure vs guest surface) `[v2]`

v1's error: it framed the biggest exposure as a _circles/guest_ item. Corrected —
there are **two** buckets, and the larger one is already overdue on the shipped
product:

**(a) Main-product companion compliance — LIVE and ~8 months accrued.** NY GBS
Art. 47 (in force **2025-11-05**) and CA SB 243 (**2026-01-01**) attach to the
_whole agent_: an AI that "retains memory of prior sessions and simulates a
sustained relationship" is an "AI companion." **Bitterbot's persistent biological
memory + hormonal modulation fits squarely**, and the product has shipped to users
with **zero crisis code** (grep for 988/crisis/self-harm in the product path = 0).
Required now, independent of Circles: the verbatim NY disclaimer at session start +
every 3h; CA crisis protocol + minor break reminders; **CA SB 243's $1,000/
violation private right of action** makes each omission cheaply suable. Treat this
as a **live remediation with its own owner** (§7 Phase 0 companion-compliance
item), not a pivot side-effect.

**(b) Guest-surface compliance — new exposure to non-users.** The guest page must
carry, in its core (not a footer): persistent AI disclosure; the NY verbatim
disclaimer + 3h timer; **crisis detection → jurisdiction-mapped resources** (v1
hard-coded US-only "988"; the guest surface is global — map resources by locale, an
EU guest in crisis must not get a US hotline); a **real age gate** (not "18+ in
ToS" — a URL-fragment link is reachable by anyone; COPPA/FTC 6(b)/Character.AI's
under-18 retreat are all minor-centric); AI-content marking (EU Art. 50(2),
grace to Dec 2026 for existing systems); no credential/payment collection under
false pretenses; and **broker-side minimization** (the broker sees guest plaintext,
§4 — don't log guest PII/metadata).

**EU AI Act Art. 50** transparency applies **2 Aug 2026, confirmed not delayed**
(the Digital Omnibus only postponed high-risk Annex III duties); fines up to €15M
or 3% turnover. The **crisis-referral interceptor** must be _specified_ (detection
method, trigger set, placement in the agent loop, jurisdiction-mapped resource
table) and ships with (a) for the main product **before** guest chat widens
exposure — it is on the critical path, not a backlog line.

---

## 7. Build plan (reordered: foundation → loop → measure → surface) `[v2]`

Prime directive from §0: **measure the make-or-break assumption before building
the surface that assumes it.** Every phase lands wired, on-by-default where safe,
kill-switched (`circles.enabled` umbrella; `circles.socialGraph.enabled` for
Phases 6-7), tested, documented in the same commit, with an adversarial pass
gating Phases 5-8. Estimates re-costed per the plan-review (v1 was ~2x under on
its two most-cited phases).

**Per-phase "what a user can actually do" `[v2 — v1 never stated this]`:**

| After | A new user can…                                                                           | Caveat                                          |
| ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| P0    | nothing new; existing pairs get ≤15s delivery + honest presence _if already configured_   | no new connection possible                      |
| P1    | (P1a) faster/cleaner; (P1b) a NAT'd **invitee** joins + receives                          | inviter still needs reachability (broker or P4) |
| P2    | **connect via link/QR + canned guest page → measure the loop**                            | canned guest experience, not live agent chat    |
| P3-P4 | Discord-shaped chat between reachable pairs                                               | still on HTTP/fast-poll until P5                |
| P4b   | **the §2.5 beachhead: personal study agent working the circle's shared artifacts** `[v3]` | quarantined-path subset must land first         |
| P5    | the actual zero-config mesh product                                                       | gated on the hardest phase                      |

**Phase 0 — Foundation: pulse, decouple, and the security gates (M, 6-9 days,
pure code) `[v2 re-cost from 3-4d].`** The highest value-per-line work, but it
carries the security foundation now. Move `pollMailbox()`+`heartbeat()` off the
30-min tick onto a self-rescheduling ~15s timer **that backs off to the slow tick
when idle** (v1 dropped this qualifier), hosted where the `broadcast` fn lives
(**gateway `server-maintenance.ts` — but it holds no db/config today, so thread a
new circles-DB accessor + config through**, `[v2 correction]`), and **decouple from
`marketplaceEconomics` on BOTH the sweep and the inbound serve/mailbox-serve paths**
(`a2a-http.ts:309-336,367-380`, not just `manager.ts` — v1 undercounted). Add
per-dial timeouts + bounded concurrency to `circleRpc` (serial + no-timeout fan-out
overruns a fast sweep). Raise the receiver-side presence rate limit (12/min is <
the new cadence for friends sharing >3 circles) **with a protocol version-skew
story** (mixed-version friends must not rate-limit new nodes — the plan needs this
generally). Emit a new `circles.message` broadcast at inbound dispatch (one
`handleCircleMethod` call site; add an emitter param). Refresh `last_seen_at` on
receipt. Add a per-message delivery-status column; stop discarding the SendReport.
**Security gates that land here:** the server-checked capability token (§5.3);
roster-metadata wrapping (§5.1-A); persisted rate buckets (§5.2); key-at-rest
custody (§5.6). **Companion-compliance remediation (§6a)** starts here in parallel
(it is main-product, not circles-gated). Cooperative-yield mandatory.

**Phase 1 — Reach: fast delivery + default mailbox + fleet broker (M-L, ~1.5-2 wk +
deploy).** (1a) The fast cadence of Phase 0 now has a default mailbox to drain:
build the headless mailbox entrypoint (§3.3), ship `circles.mailbox.url` default
via PLAN-32. (1b) **Fleet-brokered invite/join** so a NAT'd inviter can be reached
_before_ the full mesh (an interim broker on the fleet that relays `circle/join`
and first-contact, superseded by B-4 in Phase 4). Normalize invite-redemption
error strings (§5.2). After 1b, the loop works for real installs, not just tunnel
owners.

**Phase 2 — The loop, and MEASURE IT (M, ~1 wk + instrumentation) `[v2 — the
decisive phase, moved up from "nowhere"].`** Ship: invite **link + QR + deep
link**; the **guest-JOIN page with the canned experience** (profile card +
presence/availability + message-escrow, §4 — _not_ live generated chat) **plus
the read-only shared-artifact render for artifact-attached invites (§4 `[v3]`)**;
starter-pack pre-bundled invites; **seed real college study groups by hand
`[v3 — the §2.5 beachhead cohorts; dorm/campus density answers N₀]`.**
**Instrument and gate:** invite-click → reciprocated join (the fatal <5% line),
guest → install conversion, **artifact-attached vs blank invite conversion split
`[v3 — measures whether the job framing is doing any work]`**, and a **week-2
co-presence appetite test** — drop the existing practice partner into a room
with two real humans and watch whether it gets muted (cheap, uses instruments
we already have). **This is the go/no-go gate.** Do not start Phase 3 until the
loop clears its tripwires (§11).

**Redesign build log `[2026-07-17]`.** After a real friend-to-friend connection
worked end to end, a 5-agent research fan-out (2 codebase, 3 UX/sync/concept)
converged on: a calm single-room chat beside a **shared canvas of consent-gated
collective agent output**, where agents co-fill typed cards (never free-form chat).
The redesign ships in A→D increments (A: make it a chat · B: summon-only agent in
room · C: group canvas on the `canvas.*` event log · D: live co-edit + more card
types). Design mockup + synthesis captured this session.
**A1 LANDED (renderer-only, no new protocol):** the 3-pane `CirclesView` shell
(`desktop/renderer/src/components/circles/` — `CircleRail`/`CircleChat`/
`CircleMessageList`/`CircleMembers`/`InvitePanel`) on a new per-circle keyed
`circles-store.ts`, replacing the old `PeopleView` stats dashboard (deleted, no
dead code). Rides the existing `circles.status/list/messages/send/invite/join`
RPCs; `"circles"` event nudges an active-circle refresh. Next: A2 read-state/unread
(`circle_read_state` + `markRead`), A3 reactions, A4 reply-to + pins.
**A2 LANDED:** node-local unread — `circle_read_state` (migration v40, seeds
existing circles as read so no upgrade backlog) + `read-state.ts` (unread = inbound
newer than the marker; our own sends never count). `circles.list` now returns
`unread` per circle; new `circles.markRead` RPC. Rail badges the count; opening a
circle (or inbound arriving while it's on screen) clears it.
**A3 LANDED (reply-to):** a reply references the parent's `envelope_id` — stable
across every node (it is the dedupe key), so it resolves locally on each member's
node. Carried in the message body (`reply_to`), stored on outbound + inbound rows
(`circle_messages.reply_to`, migration v41); `circles.send` takes `replyTo`,
`circles.messages` returns `envelopeId` + `replyTo`. The composer shows a quote
banner; each row a hover reply button + the quoted parent.
**Reactions + pins are DEFERRED to Phase C** (not a standalone A-increment): both
are shared-lightweight-state, the same shape as the group-canvas `canvas.*` events,
so they ride the event log there rather than getting a throwaway verb + table.

**C1 LANDED (group-canvas foundation):** the group canvas is a board of typed
CARDS materialized from the SAME chained event log as the tab. New `canvas.card.put`
/`canvas.card.remove` event types (`tab.ts` union), a deterministic LWW fold
(`canvas.ts` `computeCanvasCards` — per card_id the greatest `(updated_at, event_id)`
wins, a total order every node agrees on), and `putCanvasCard`/`removeCanvasCard`/
`canvasCards` on the service (reusing the generic `appendTabEvent`, so cards fan
out + sync exactly like expenses). RPCs `circles.canvas.list/put/remove`. The
right pane now really switches Members ⇄ Canvas (`CircleRightPane`); the Canvas
board (`CircleCanvas`) renders cards + a "New card" composer. C1 ships the simplest
card (a shared note) to prove the whole pipe; peer card text is injection-scanned
on receipt (event.append) and rendered as escaped text. Inherits the tab's
fork-freeze + 30-day-sync constraints. Tests: cross-node put/update(LWW)/remove +
renderer Canvas-tab render.

**C2 LANDED (Decision Card + per-member slices):** the first "collective agent
output" object. A Decision Card is a `canvas.card.put` with cardType "decision"
(options in `text`, one per line); each member's VOTE is a SEPARATE signed
`canvas.slice.put` event (slot "vote", LWW per (card, slot, author)) — so
contributions MERGE rather than overwrite (`tab.ts` union, `canvas.ts` folds
slices onto cards, `putCanvasSlice`, RPC `circles.canvas.slice`). Voting IS the
publish/consent act (Phase B: the member's agent pre-fills the value from private
context; the human still clicks publish). Renderer: `DecisionCard` (options with
live tallies + attributed voters + synthesized "leading"), a Note/Decision
composer toggle. Tests: cross-node vote fold + LWW vote-change; renderer decision
render + publish. This proves the typed-slot/per-member-contribution architecture
end to end. Next: **C3 = the study-guide Co-Canvas** (the beachhead), and Phase B
(the agent that pre-fills a member's slice).

**C3 LANDED (study-guide Co-Canvas — the §2.5 beachhead card):** a `canvas.card.put`
with cardType "study"; the guide's SECTIONS ride the card text one per line (the
decision-options shape), and each member's per-section contribution is a separate
signed `canvas.slice.put` whose slot is `sec-<fnv1a(normalized section)>` —
deterministic on every node with no coordination, so the guide ASSEMBLES from
everyone's pieces (LWW per (card, section, author)) and uncovered sections render
as amber GAPS (the gap-map seed). No new protocol, no new RPC, no migration: the
generic C1/C2 machinery carries it; the one server change is raising the slice
value cap 200→2000 (a contribution is a paragraph, not a vote; the value stays a
top-level string so the event.append injection scan reaches it). Renderer:
`StudyGuideCard` (coverage header, per-section attributed contributions +
source note, add/edit-yours inline composer), a Guide composer in `CircleCanvas`,
store `putStudyGuide` + generic `putSlice` (vote now delegates to it). Documented
caveats inherited from C2: renaming a section orphans its contributions (same
class as editing decision options); a crafted slot collision only merges two
sections' lists (cosmetic). Tests: cross-node assemble/merge/LWW-edit with an
over-200-char contribution pinning the cap; renderer guide render + gap +
publish contribution + composer create. Phase B pre-fills a member's section
slice from their private gap history (PLAN-9 mastery), quarantined per §2.5's
security note. The adversarial pass found no criticals but 1 major + 3 minors,
all fixed: the server test had hardcoded slots that never exercised
`sectionSlot` (now uses the real mapping, pinned by golden values in
`StudyGuideCard.test.ts` so contract drift breaks a test); `sectionSlot` now
NFC-normalizes (NFC-vs-NFD IMEs typing the same title previously derived
different slots — a silent gap); the render fold is one pass over slices (a
hostile 4000-char card with thousands of slices previously cost millions of
comparisons per keystroke); drafts are keyed per section so switching sections
mid-edit no longer discards unsaved text.

**Phase B LANDED (the agent in the room — summon-only, quarantined,
consent-gated).** An `@agent` token in a circle message (a peer's, at receipt in
`storeInboundMessage`; or our own, at send) queues a node-LOCAL draft
(`circle_agent_drafts`, migration v42 — private state, no envelope, no sync).
The ~15s scheduler sweep generates queued drafts on the §5.1-C quarantined path:
a single plain completion (the judge-provider seam — no tools, no session, no
memory recall) whose prompt is our constant instruction frame plus ONE
`wrapExternalContent` envelope holding every circle-derived string (names and
bodies; nested markers stripped so a peer cannot fake a boundary). The draft
renders ONLY to this node's human (`AgentDraftCard` above the composer, "only
you can see this"), editable; the publish tap ships the human-approved text
through the normal `sendMessage` path (signed, threaded to the summon, delivery-
accounted) and is the ONLY way a draft leaves the node. Containment: quiet by
default (no token → no LLM call); per-circle rate bucket (3/5min) + per-sweep
generation cap (2) + 1h queue TTL bound hostile-summon token burn; one draft per
summoning envelope (mailbox replays dedupe); critical-scan messages never queue;
published agent output is barred from re-summoning (`suppressAgentSummon`), so
a draft containing "@agent" cannot loop the generator. §5.2 memory taint holds:
nothing in this path reads or writes recall-eligible memory. Kill switch
`circles.agentDrafts.enabled` (default ON with circles). RPCs
`circles.drafts.list/publish/discard`; scheduler `onDraftsReady` nudges the UI
via the content-free "circles" event. Every receiving member's OWN node reacts
to `@agent` — per-member agent addressing waits for petnames (Phase 5/6).
Tests: unit (summon grammar, rate bucket, replay dedupe, per-sweep cap,
failed/empty generation, TTL expiry, envelope placement) + two-node E2E (summon
→ quiet → generate → consent-publish edited text threaded to the summon;
discard sends nothing; self-summon; no re-summon loop; kill switch) + renderer
(private consent card, publish-edited, discard).
The adversarial security pass confirmed the two core surfaces hold (no private
data reachable from the quarantined prompt — circle-scoped SQL only; no
envelope escape — hostile display names/bodies carrying forged markers are
sanitized) and found 2 majors + 4 minors, all fixed: publish/discard now take
an ATOMIC status claim (guarded UPDATE) so racing publishes send exactly once
and a failed send hands the draft back; generation runs fire-and-forget off the
scheduler cycle (in-flight guard, no stacking) with a per-call 20s deadline, so
a hung provider can no longer stall the mailbox drain or push presence beats
stale; crash-orphaned 'drafting'/'publishing' rows are recovered by
housekeeping, terminal rows are pruned after 30d, and housekeeping runs even
when the kill switch is off (queued rows from the config-blind inbound path
expire instead of accumulating); the instruction frame now forbids emitting
"@agent" (the suppressAgentSummon guard is node-local — a published draft
carrying the token would summon every OTHER member's node; human-gated and
rate-bucketed at each hop, but the frame rule plus the honest scoping of the
claim close the review). Corrected containment framing: the real global LLM
ceiling is the sweep cap (≤2 calls/15s regardless of circle count), not the
per-circle bucket — the bucket bounds queue growth per circle.
**UX follow-up (first live friend-to-friend session):** inbound messages are
stored security-wrapped for agent consumers, and the chat was showing the raw
envelope to the human. The renderer now unwraps for DISPLAY only
(`external-content-display.ts` — fails open on anything malformed) and shows a
small screened-shield indicator instead; the stored/agent-facing content stays
wrapped, so the hostile-principal boundary is unchanged.

**B2 LANDED (agent-drafted card slices — "circle = commons, agent = personal
lens" made concrete).** "Ask my agent" on a Decision Card (vote) or a
study-guide section queues a `kind='slice'` draft (migration v43 adds
`target_card_id`/`target_slot`); the same quarantined sweep generates it via
`buildQuarantinedSlicePrompt` — our constant task frame (a vote must be EXACTLY
one option line or ABSTAIN; a section gets contribution text), with the card
title/body, existing member slices, and recent chat all inside ONE untrusted
envelope. The suggestion renders privately on its card
(`AgentSliceSuggestion`); publish ships the human-approved text through the
normal `circles.canvas.slice` path (same atomic ready→publishing claim as
reply drafts), dismiss discards. Human-initiated only (no peer can request
your slice draft); shares the per-circle rate bucket with @agent summons; one
live draft per (card, slot). Non-option vote suggestions (ABSTAIN) render
publish-disabled with a hint. RPC `circles.drafts.request`. Tests: unit (slice
queue dedupe + shared bucket, vote-prompt envelope placement with the
constraint in the trusted frame, end-to-end row targeting) + two-node E2E
(request → generate → quiet → consent-publish lands the vote slice on both
nodes) + renderer (suggestion on the card not in chat, publish, per-section
ask). This is the Phase-4b seed: the same request path later feeds from the
member's PLAN-9 gap history instead of circle context alone.
The B2 adversarial pass found no high/critical issues (envelope composition,
trusted-frame placement, human-initiated-only, rate sharing, atomic claim, and
injection→canvas parity all confirmed sound); three low findings fixed: the
one-live-draft dedupe now scopes by circle_id; the slot string (which lands in
the trusted prompt frame) is charset-restricted at the RPC boundary; and
publish re-checks the target card still exists, refusing to append a slice to
a tombstoned card (the draft is handed back for discard).

**Phase D unfreeze LANDED (fork-freeze recovery).** A ledger fork previously
froze the circle with the evidence only in the server log and NO in-app
recovery — a bricked group for real users. Now: the fork site records JSON
evidence (author, seq, held/offered hashes, detected_at) into
`circles.freeze_reason` (migration v44); `circles.list` carries it; the chat
shows a `FrozenCircleBanner` that names the forked member and entry, explains
the benign read (a node restored from backup) next to the hostile one
(tampering), and offers a two-tap "Review & unfreeze" consent flow → new
`circles.unfreeze` RPC → `store.unfreezeCircle` (guarded UPDATE: only
frozen→active, clears evidence). Unfreezing is node-local and honest about
scope: the forked author's chain may keep chain-breaking until they recover;
conversation and everyone else's events resume. Tests: the a2a fork test now
also pins the recorded evidence, unfreeze-only-from-frozen, evidence cleared,
and a valid continuation appending after recovery; renderer test pins the
banner (named member + entry), the two-tap consent, and the RPC call.
The unfreeze adversarial pass confirmed the mechanism (re-detection intact,
RPC-only, evidence unforgeable, archived circles can't be activated, v44 safe)
and found one medium gap, fixed: one replayed fork envelope — a member
restored from backup re-syncing, or a naive griefer — put the circle straight
back in the freezer after every unfreeze, with no in-app escape. Unfreezing
now MOVES the evidence into a bounded `forgiven_forks` audit trail (migration
v45 — evidence is retained, answering the pass's evidence-destruction note),
and a forgiven author's fork replays are rejected WITHOUT re-freezing
(`isForkForgiven` in the fork branch); a fork from a different member still
freezes. Honest residuals, documented: a determined in-circle attacker can
still rewrite a different part of their history for one more freeze per
review (eviction is the §5.5 report/ban primitive, still unbuilt — the banner
copy now tells the human to abandon a repeatedly-conflicting circle), and
fork detection remains HEAD-only (a divergence at seq < head chain-breaks
silently — pre-existing, now on the record).

**Reactions + pins LANDED (the Phase-A deferral, paid off on the event log as
planned).** Two new event types on the chained log (`tab.ts`): `message.react`
is the author's FULL emoji set on a message (LWW per (target, author) —
toggling re-emits the set, so there are no add/remove tombstone pairs; empty
set clears; capped 8 entries × 16 chars, deduped + sorted), and `message.pin`
is a circle-wide flag (LWW per target; any member may flip — friends-tier
trust, v1). Targets are envelope ids, the same stable cross-node reference
reply-to uses. `annotations.ts` folds both; `circles.messages` now returns
`annotations` alongside messages (one refresh paints the conversation), with
`circles.react`/`circles.pin` RPCs writing through `appendTabEvent` (fan-out,
injection scan on receipt, fork-freeze all inherited — "emoji" strings are
peer content rendered escaped). Renderer: reaction chips with counts +
reactor tooltips (own reactions highlighted, chip tap toggles), a hover
palette (👍 ❤️ 😂 🎉 👀 ✅), hover pin/unpin, a pin glyph on pinned rows, and
a collapsible "N pinned" bar above the stream (unwrapped previews). No
migration — rides `circle_events`. Tests: two-node E2E (react merge per
author, LWW toggle, empty-clear, pin/unpin agreement) + renderer (chip render

- toggle RPC, pinned bar + unpin RPC). Pins are the artifact-surfacing
  primitive the §2.5 beachhead invite will read from.

The annotations adversarial pass caught one real spoofing bug plus three
hardening gaps, all fixed: a newline inside `target_envelope_id` could forge
another member's reaction attribution through the fold's joined LWW key (the
fold is now structurally nested AND rejects non-printable/oversized targets);
author-claimed `updated_at` is clamped to received_at+5min so a far-future
timestamp cannot grief-pin forever; the 8×16 emoji cap is re-applied on the
fold side (sender normalization is not trusted — a signed 60KB reaction body
previously rendered hundreds of chips); LWW ties now break on the REPLICATED
`event_hash` (event_id is per-node and let same-millisecond ties diverge);
and pinned messages are resolved server-side by envelope id with no window
limit (pins previously vanished silently once the target left the 100-message
buffer — defeating their purpose). Hostile-input fold tests pin all of these.
Known-accepted residuals: annotation rows accrete on the log (fold cost fine
for v1, cache before the beachhead), and the same claimed-timestamp clamp
should eventually be applied to the canvas LWW fold (pre-existing, lower
stakes — per-key not circle-wide).

**Phase 3 — Discord chat surface (L, ~2-3 wk) — the reward for a positive P2
reading.** A 3-column `CirclesShell` (circle rail / channel list / message pane +
member pane); connections render as DMs. **Build a new `CircleMessageList`** — do
not adapt `MessageList` in place (it reads the chat-store singleton and the
`ChatMessage` model is two-party with no author identity, so this is new rendering
logic, `[CORRECTED]`). New per-circle keyed store; author identity + human/agent
chip per row; the inbound external-content frame rendered visibly. Unread via a
local `circle_read_state` table + `markRead` RPC + `before` cursor + badges;
`tauri-plugin-notification` with **digest-batching for agent-authored pings**.
First UI for the genuinely-dark RPCs (`create`, `disclosure.set/list`).

**Phase 4 — Groups + channels (M-L, ~1.5-2 wk) `[v2 re-cost].`** Channels as a
`thread_id` convention — **but carry the channel list as an authoritative snapshot
in `circle/roster`/join response** (JSON-RPC results, not size-capped envelopes),
with `channel.define` events as change-notification only, plus auto-sync on join +
sync-on-chain-break (the per-author hash chain wedges everything after one miss;
join returns roster-only; 30-day replay ceiling — `[CORRECTED]`). **Specify the
snapshot authority/merge rule** (recommend creator-authoritative; note a tab fork
currently freezes channel management via the shared `isWritable` gate — decide if
that's intended). `#tab` channel (add-expense UI + the missing unfreeze), `✦
briefing` channel, **`#study` channel `[v3]`** — shared artifacts land here as
pinned messages (a pin convention on the existing message model, not a new
protocol object; versioned by re-pin).

**Phase 4b — The study loop (M, ~1-1.5 wk) `[v3 — the beachhead value prop;
lands with the chat surface, before the mesh].`** The per-member half of §2.5:
a member's agent takes a pinned circle artifact and acts on it **for its own
human only** — generates quizzes against the member's gap history, schedules
spaced repetition via the PLAN-9 spacing/mastery machinery, renders a personal
gap map. Hard requirements: generation from peer artifacts runs on the §5.1-C
**quarantined tool-less path** (this pulls a minimal version of that path
forward from Phase 8 — scope it to render-to-own-human only, which is the
cheapest safe subset); §5.2 memory-taint holds (artifacts are processed, never
recalled; mastery state derived from quizzing is the member's own data); **no
autonomous circle-facing output** — posting a summary/artifact back to the
circle is human-approved through the §5.3 pending-outbound card like any other
send. What a user can do after 4b: the actual §2.5 pitch — join a study circle,
get a personal study agent working the group's material against your own gaps.

**Phase 5 — Ride the mesh (XL, 6-8 wk Rust+TS incl. spike + security review;
PLAN-35 Track B) `[v2 re-cost from 3-4wk; this is the critical-path keystone].`**
The keystone: **signed device-pubkey ↔ libp2p-PeerId binding** (B-1) — this is
where "identity unification" actually happens (§9.2). Then: **live friend presence
via mesh `PeerConnected` events** (the census route does **not** work — no peer*id,
keyed by the orchestrator key, `[REFUTED — drop the census claim]`); the new Rust
request-response protocol + **acked/persisted inbound path** (§3.2); `p2p_send*
circle`with HTTP fallback; **join-over-relay (B-4)** which deletes the`a2aPublicUrl` requirement and supersedes the Phase-1b broker. Includes the fleet
relay reconfig + QUIC eval (§3.1) and the PLAN-35 Phase-1 spike as the _entry gate_.
Security review: PeerId spoofing, relay abuse, unsolicited-frame DoS, blinded-topic
authz.

**Phase 6 — The consented social graph (L, ~2-2.5 wk, behind
`circles.socialGraph.enabled`) — gated on §5.4 + §5.5.** New disclosure categories
extending `disclosure.ts`: `graph.mutuals` (ON for connections), `graph.friends`
(OFF), `graph.introductions` (OFF, onboarding-prompted), `graph.relay_asks` (OFF),
`graph.presence_fof` (OFF), `profile.public` (name-only). **`friend_edges`
defensively derived** — `kind='connection'` is a remote-controllable free string,
cardinality enforced nowhere `[CORRECTED]`; validate cardinality, strip
endpoints from FoF answers. **Introduction vouchers are a new protocol object, not
an invites reuse** `[REFUTED]` — the envelope supports one signature and naive
reuse makes the introducer a permanent member of the A–C circle; build a referral-
attestation + separate consent + redemption on the introducee's node, hard-gated on
B-4. `circle_fof` principal (§5.4). PeerMap reborn (friends live via PeerConnected;
FoF amber/first-name/grant-gated; ambient = census counts, k≥5, never identity-
resolved). **Ships only after the §5.4 runtime detector + §5.5 ban primitive +
§5.2 persisted rate buckets exist.**

**Phase 7 — Agent-to-agent sociality (M-L, gated, own adversarial review).** Tier
(a): auto-answer the two built-in granted categories (presence/availability —
extends the existing autonomous-refusal precedent, `service.ts:571-594`). Tier (b):
bounded in-circle small talk under round caps — **categorically new (first
autonomous LLM-generated outbound)**, requires the §5.1-C quarantined path, its own
phase and review. Commerce-first befriending **gated on Forage G4** (forage
identities are unauthenticated wallet strings today, `[REFUTED until G4]`; Forage is
at ~G1).

**Phase 8 — Live guest chat + agent commerce (L, gated, counsel + own review).**
The live generated guest chat deferred from §4 (needs §5.1-C + full §6b compliance +
the broker-plaintext handling). Tab settlement (PLAN-31 Phase 2 money) on the warm
graph: per-circle spend cap, replay protection, dispute path, **gated on wallet↔
circle binding** (§5.7), human-gated above a _numeric_ trivial cap, behind counsel +
the constitutional wallet rule. **Edge formation and non-trivial money stay human
forever.**

**Cross-cutting:** cooperative yield on new timers; the wire+test+document rule
(and its inverse — no invariant ships as prose, per §5); adversarial passes gating
Phases 5/6/7/8; fix stale docs found en route (`types.circles.ts:14` "ships dark",
`service.ts:14-16` "never dropped silently", dead `key_epoch`).

### 7.9 Critical path, parallelism, and where it slips

Serial spine: **P0 → P1 → P2 (measure/gate) → [P3‖P4‖P4b UI+loop] and [PLAN-35
spike → P5 Rust] → P6 → P7/P8.** `[v3: P4b sits with the UI workstream; its
quarantined-path subset is the one Phase-8 item pulled forward.]` P3/P4 (TS/UI) parallelize with P5 (Rust) **only with a second
workstream** — this repo's history is one developer, so as scoped it is serial and
the window is **~3 quarters for P0-P6**. Honest total incl. the omitted subsystems
(guest page, crisis interceptor, transparency log, identity binding, the §5
enforcement items) is **~2x v1's summed estimate**. Most likely slips, in order:
Phase 5 (Rust + IPC redesign + review), the guest/loop instrumentation, Phase 0's
receiver-side rate-limit/version-skew surprise.

---

## 8. This plan amends PLAN-31 — explicitly, not by drift

- **Reversed (publicity anti-commitments):** no discovery → consented, signed,
  rate-limited FoF intros; presence-is-not-a-graph-surface → a PeerMap of _your_
  friends + consented FoF; briefing-replaces-the-feed → a real chat surface with
  unread/notifications. **Never reversed:** no public feed, no global/comparative
  metric, no public connection graph, no contact harvesting, no shadow profiles,
  no open "discover any agent." "Lean into the graph" = **consented transitive
  visibility**, edge-authenticated and grant-checked; no global read surface
  exists.
- **Strengthened (security invariants):** hostile-principal extends to roster
  metadata and transitively to `circle_fof`; disclosure stays default-deny; k≥5,
  memory-taint, no-oracle indistinguishability, and human gating move from prose
  to enforced code with tests + server-checked tokens + a runtime propagation
  detector; CaMeL control/data separation with a real quarantined path becomes the
  doctrine.

---

## 9. The three decisions only Victor can make

1. **Graph visibility dial.** (a) mutuals-only; (b) **consented FoF via grants +
   staked intros — recommended**; (c) opt-in public directory (reopens every
   cited failure). Effectively irreversible: visibility widens later, never
   narrows without a scandal.
2. **Identity unification scope.** Bind device-pubkey ↔ PeerId **always** — this
   is the **Phase-5 keystone** (`[v2 correction]`: not "Phase 0," nothing in
   P0-P4 needs it). Bind **wallet ↔ device per-circle, grant-gated** — full
   binding creates a linkable super-identity (social graph ↔ on-chain
   deanonymization). Money does not move in a circle without this binding (§5.7).
3. **Agent autonomy frontier.** Recommend tier (a) auto-answer granted categories +
   tier (b) bounded small talk under per-circle autonomy settings; keep edge
   formation and non-trivial money human forever.

---

## 10. Success metrics (utility-first; N and X bound, not placeholders) `[v2]`

1. **Delivery feels alive** (P0-P1): median inbound latency both-online < 5s;
   presence-dot accuracy > 90% for nodes up in the last 5 min; **0 silently-
   dropped sends** (delivery status must be _rendered_ — so this metric is only
   valid from P3, not P0, `[v2 fix]`).
2. **The loop converts** (P2, go/no-go): **invite-click → reciprocated join ≥ 5%**
   (PLAN-31's fatal line); guest → install conversion ≥ 15%; **co-presence
   appetite: practice partner muted/removed in < 30% of 2-human test rooms**.
3. **The chat gets used** (P3): **≥ 3 substantive human+agent exchanges per active
   circle per week**; **W4 return-to-circle ≥ 25%**.
   3b. **The beachhead loop works** (P4b) `[v3]`: a shared artifact triggers **≥ 1
   personal agent action (quiz/schedule/gap-map) within 48h for ≥ 50% of circle
   members**; **artifact-attached invites convert ≥ 2x blank invites** (else the
   job framing is doing nothing and §2.5's premise is wrong); W4 retention holds
   through at least one **non-exam week** (else it's a cram tool, not a habit —
   acceptable for a beachhead, but plan re-engagement around the academic
   calendar instead of assuming weekly organic return).
4. **The graph densifies without abuse** (P6-P7): FoF intros per new edge; **0**
   unblinded circle-id/membership leaks to the mesh; sybil-edge rejection rate;
   introducer-stake accuracy.

## 11. Kill tripwires (both jaws of K<1) `[v2 — added the retention jaw]`

- **Join:** invite-click → reciprocated join < 5% after the guest page ships →
  the join path is fatal as designed (PLAN-31.md:824-828); stop and re-architect
  the loop before building more.
- **Retention `[v2 — new]`:** W4 return-to-circle < 25%, or the co-presence test
  shows Attie-style rejection (practice partner muted in > 30% of rooms) → the
  co-presence bet is wrong; **pivot to agents-as-background-coordination** (which
  reuses P0/P1/P5 and drops the member-pane/agent-chip/agent-small-talk
  investment — so this tripwire must be read **at P2/P3, before** those are
  built).
- **Beachhead `[v3]`:** shared artifacts get posted but < 25% of members' agents
  ever act on one, or the artifact-attached invite converts no better than a
  blank one → the "agent as personal lens" value prop is wrong and the product
  is NotebookLM-with-extra-steps; stop before P5 and rethink the wedge (the
  shared-artifact commons may still be right with the personal-agent layer cut).
- **Transport:** measured DCUtR success materially below ~70% on our fleet after
  the spike → treat the mailbox as steady-state and re-scope Phase 5.
- **Worm:** any prompt-injection propagation across a friend edge in red-teaming →
  halt Phases 6-7; the CaMeL boundary + §5.4 detector are not holding.
- **Notifications:** agent-authored pings muted by > 20% of users → digest cadence
  is wrong.

---

## Appendix A: research provenance

Four passes (§ header). `[CORRECTED]`/`[REFUTED]`/`[NEW]`/`[v2]`/`[v3]` tags mark
exactly where each pass changed the prior conclusion. Full per-claim `file:line` and URL
receipts are in the session reports. Key external sources: DCUtR success
[arXiv 2510.27500]; Prompt Infection [arXiv 2410.07283]; CaMeL
[css.csail.mit.edu/6.5660]; INFA-Guard [arXiv 2601.14667]; Bluesky starter packs
[arXiv 2501.11605]; EU AI Act Art. 50 [Consilium 2026-06-29]; CA SB 243 [leginfo];
NY GBS Art. 47 [governor.ny.gov]; Moltbook breach [SiliconANGLE 2026-02-02]; x402
adoption [Chainalysis 2026-06]; competitor scan (Discord/Meta AI/Base App/XMTP/
Telegram/Nostr-Clawstr/Matrix) in the session competitor report.

`[v3]` pass sources: Gen Z market study at
`docs/reviews/genz-ai-market-research-2026-07-15.md` (deep-research run
wf_578e7ee7-cc2; primaries: Pew Dec-2025/Feb-2026/Apr-2026 teen surveys, Gallup
Feb-Mar 2026, Common Sense/NORC 2025, Prophet 2026, BCG Video Gaming Report
2026, Roblox newsroom Apr-2026 — the report also lists four **refuted** press
stats not to cite). Study-tool landscape scan 2026-07-15: OpenAI group-chats
launch + retirement notices [openai.com, help.openai.com]; NotebookLM student
features [notebooklm.google]; Google ISTE 2026 student AI [blog.google];
consumer agent-ecosystem skepticism [TechCrunch 2026-05-21].
