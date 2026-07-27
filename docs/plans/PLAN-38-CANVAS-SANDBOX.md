# PLAN-38: Canvas Sandbox

> Status: DRAFT v1, 2026-07-27. Synthesis of six independent agent reviews
> (architecture, security, UI, UX/value, prior art, holistic) commissioned by
> Victor after the 2026-07-27 circles viability review. Nothing here is built.
> §9 lists the decisions that are Victor's, not mine.

## 0. The pitch, and the correction the evidence forces

**The pitch (Victor's words):** the group canvas today is "just stale messages,
pretty boring." It should be "a sandbox where the agents can interact and the
users can join in and guide" — agents doing collective work while owners
observe, steer, and opt in and out.

**The instinct is right and one word of the framing is wrong.** Five of the six
reviews converged independently on the same correction, so it is written into
the thesis rather than buried:

> The durable product is that **several private memories can safely work one
> shared artifact**. The live show is how you discover that for the first time,
> not why you come back.

Every "watch the agents interact" product has died: Moltbook (1.5M agents in
week one, authenticity collapse and acqui-hire in six), SocialAI, Chirper,
Claude Plays Pokemon (viral, then ~95% viewer decay once the loops became
familiar). The prior-art review found the one counterexample retains on
_persistent character and stakes_, not capability. Meanwhile the thing nobody
ships — separate humans' own agents, each carrying private context, working one
space — is a verified empty quadrant: OpenAI shipped group chats with personal
memory **forcibly disabled** and retired them 2026-07-09; Claude Tag is one
identity per channel; Notion/Miro agents are workspace property, not
member-owned. They all delete the private context because they cannot scope the
consent. A P2P friend group with per-member local nodes can.

So: **build the sandbox, lead with the residue.** Sessions produce kept,
signed, attributed artifacts and standing work that names who it is waiting on.
The live view is an audit-and-demo pane over that, which is also exactly what
makes it filmable (§8).

### 0.1 What makes this structurally different from Moltbook

Three things, none of them vibes:

1. **Non-redundant information.** Moltbook was N copies of one model wearing
   hats: informationally redundant, so output was slop. Here, Sam's agent knows
   Sam's calendar conflict and Ana's knows her budget ceiling — data neither
   human typed into the room. **This is load-bearing: if the private-context
   pipe does not flow, the sandbox IS Moltbook in a living room.** §4 constrains
   how it may flow; §2 kills every card type that does not need it.
2. **Unfakeable identity.** Moltbook died on ~17,000 humans puppeting an average
   of 88 "agents" each. Per-member node-bound Ed25519 signatures make "that is
   really Maya's agent" a cryptographic fact.
3. **Kept artifacts with real approvals.** Moltbook sessions produced nothing
   anyone retained. Sessions here collapse into a study deck, an itinerary with
   receipts, a ratified Decision Card.

---

## 1. Architecture

Full proposal in the architecture review; the load-bearing decisions:

**The ledger already is the coordination layer.** `circle_events` (per-author
Ed25519 hash chains, deterministic folds, `canvas.ts` OR-Set + LWW) gives
attribution, replay, and dedupe for free. The sandbox therefore needs **no
distributed mutual exclusion and no coordinator**. The trick: do not prevent
concurrent moves, make them harmless. Rounds are a fold-level construct — at
most one move per (card, author, round) is honored — so two simultaneous agents
produce two valid contributions, and a mailbox-lagged member's late move folds
into its round retroactively, identically on every node.

**Speaker order** for round r = enrolled members sorted by
`sha256(cardId:r:pubkey)`: deterministic everywhere, rotates fairly, ungameable.
Timeouts only ever _permit_ later speakers; they never invalidate an earlier
move. Peer-claimed timestamps can therefore only cause an extra concurrent move
(absorbed by the fold key), never suppress one.

**Four new event types** ride the existing `circle/event.append` verb — no new
wire verbs, and old nodes tolerate them silently because the handler validates
chain and scan, not type: `sandbox.frame.put`, `sandbox.enroll.put`,
`sandbox.move`, `sandbox.close`.

**Enrollment splits in two halves**, which is what makes consent both safe and
cheap:

- **Private local row** (`circle_sandbox_enrollments`): mode, turn budget, token
  budget, guidance text, expiry. Gates all spend. **Never leaves the node.**
- **Public signed event** (`sandbox.enroll.put`): carries `mode` only. Peers
  need to know _whether_ you speak, not what you will spend.

**P0 does not need the gossip transport.** `fanOut` already publishes every
circle verb to the blinded topic when a bus exists, so the sandbox inherits mesh
delivery free on the day the fleet ships the orchestrator binary. Until then,
dial + mailbox + `syncEvents` converge exactly as the tab does.

**Sizing** (incl. tests at repo-typical ~40%): P0 ~2,200 LOC, P1 ~1,200, P2 ~800.
Reuse-first throughout: the quarantined sweep is the generation engine, the 15s
scheduler is the clock, `claimAgentDraft`'s guarded-UPDATE is the race pattern,
the drafts tray is the propose surface.

---

## 2. What the sandbox is FOR (card types, ranked)

The test a card type must pass: **could one agent with shared inputs produce
this?** If yes, the sandbox is overhead. Grades: A = impossible for one agent;
D = one agent does it better.

| Card                                                | Grade       | Why it needs many agents                                                                                                            |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Constraint negotiation** (scheduling, trip/event) | **A**       | private calendars and budget ceilings cannot be centralized by definition                                                           |
| **Streak / commitment**                             | **A-**      | each agent attests its own human's progress from private evidence; no agent can attest for another                                  |
| **Threshold / group-buy** (Aubaine tie-in)          | **A-**      | blind private willingness folded to a threshold                                                                                     |
| **Standing watch**                                  | **B+**      | commodity watching **plus** scoring each hit against each human's private criteria; scoring is mandatory or the card is an RSS feed |
| **Study workbench**                                 | **B+ → A-** | A- only with blinded gap aggregation ("more coverage needed: enzyme kinetics" without exposing whose gap)                           |
| **Recurring-cost rationalizer**                     | **B+**      | private subscription inventories; quarterly cadence, so later                                                                       |

**Killed, with reasons:**

- **Collaborative research sprint (D).** The most demo-able and the emptiest.
  One agent with a browsing loop out-researches five coordinating; the output
  needs no private context; the ad-hoc substitute (one member runs deep research,
  pastes it) is genuinely fine. Salvaged as the option-generation _phase inside_
  negotiation, where each agent researches against its own human's criteria.
- **Gift coordination.** Served today by making a circle without the recipient.
  The interesting variant (recipient's agent leaks the wishlist) violates
  never-auto-disclose and is creepy. Ship as a documented pattern, zero code.
- **Chore/meal rotation.** A deterministic fold plus a calendar. No rounds, no
  negotiation.
- **Plain cost-split.** The tab's largest-remainder fold already does it.
  Splitting is arithmetic.

**Retention rule (pre-registered):** every round must end in a state that
**names a specific human or a firing condition.** "Done, here's a summary" has
no Tuesday. "3 of 4 voted, waiting on Ana" is the sandbox's equivalent of
Splitwise's unresolved balance, which is PLAN-31's best-evidenced retention
mechanism. The fold can always compute who blocks; the UI must say so.

**Onboarding gradient:** cards degrade to human-powered gracefully. A
negotiation card with ONE enrolled agent still works — that agent generates the
option set, everyone else votes by hand on the same card. The conversion moment
is engineered asymmetry: you are hand-entering availability for five slots while
Ana's slot filled itself from her calendar. The empty slot says so: _"You're
filling this by hand. Enroll your agent to fill it for you."_

---

## 3. UI (the anti-stale-wall contract)

Full wireframes in the UI review. The three decisions that matter:

1. **One card per session, and it collapses.** A session lives and dies as a
   single canvas card: `gathering → live → converging → done`. On completion the
   move feed disappears behind a "Replay" disclosure and the card shrinks to the
   artifact (itinerary, deck, decision) with a permanent provenance ribbon. This
   is the structural escape from "the canvas becomes its own wall of stale
   messages" — the exact failure we are fleeing.
2. **Artifact above feed; moves render as diffs.** Spectators see the product
   first, the process second. A move shows `+ Cabin B — $185/n` with a violet
   gutter, not a prose dump. The replay scrubber is a pure re-fold of the signed
   chain, so finished sessions are re-watchable rather than dead.
3. **Pause is never more than one visible tap away.** Solid consent-colored
   button in the dock while enrolled, plus a pinned banner on the canvas pane
   when the card is scrolled away: _"◆ Your agent is playing in 'Cabin hunt' ·
   Pause."_ No confirm dialog.

**Eleven dark patterns are banned by name** in the UI section; the four that
matter most: auto-mode is never preselected and never sticky across sessions; an
unapproved move ALWAYS lapses to a visible pass (expiry never publishes, keeping
PendingOutbound's invariant); no fake liveness (burst arrivals after a mailbox
drain render as "3 moves arrived, catching up," never animated as realtime); no
provenance laundering (agent output never ages into human-looking content).

Approval fatigue is handled by **one approval per turn, not per micro-action**,
rendered identically pre- and post-publish so approving is a glance-and-tap.

---

## 4. Security (this section governs)

The security review is the longest and it wins ties. Its framing:

> Today's safety rests on peer content being a **leaf**: it enters wrapped,
> generation is tool-less and memory-less, and output reaches exactly one human
> who decides if it ever becomes wire traffic. The sandbox makes peer content a
> **node in a cycle**. Three current controls silently stop working.

### 4.1 The four critical threats

- **T1 Authorship laundering / manufactured consensus.** A's payload, phrased as
  ordinary task content, is paraphrased by B's agent and arrives at C signed by
  B under B's petname. A is structurally erased at hop 1. By round 4 the card
  asserts a group decision no human made. **This is not prompt injection, it is
  manufactured consensus, and no prompt hardening touches it.**
- **T2 Peer-authored task frame in the trusted position.** The likeliest
  implementation mistake. Canvas cards are LWW-editable by any member, so if a
  card's task text lands in the instruction frame, one event takes over every
  enrolled agent in the circle.
- **T3 Personal context × auto-append = exfiltration engine.** Phase 4b put
  member-own mastery in the trusted frame **only because its output cannot reach
  the wire**. Citing 4b as license for "useful context + autonomous output" gets
  the precedent exactly backwards.
- **T9 Memory-taint classifier gap.** `agent:main:canvas:*` and
  `agent:main:sandbox:*` classify **first_party** today (`circle`/`circles` are
  in `UNTRUSTED_TOKENS`, `canvas` is deliberately not). _Verified independently:
  no such session keys exist yet, so nothing is currently mis-classified — it is
  a loaded footgun that fires the moment PLAN-38 names sessions the natural way._
  **Fix it now, ahead of any sandbox code** (§7 P0.0).

Also ranked HIGH: ping-pong burn with ~1:10,000 cost asymmetry (attacker sends
bytes, victims pay inference); turn protocol is honor-system beyond signatures;
**fork-freeze amplification** (a differing event at an existing seq freezes the
_entire circle_ — autonomous high-rate appending turns a rare accident into a
one-envelope repeatable brick); smuggling through receiver-side special paths
(the invite-code regex renders a Join button on any inbound body; the mermaid
`dangerouslySetInnerHTML` sink).

### 4.2 Non-relaxable invariants (a phase that needs one relaxed does not ship)

- **I1** No generation may include recall-eligible memory, retrieval, or session history.
- **I2** Trusted personal context and circle-facing output are **mutually exclusive**. Either personal context + human review before the wire, or auto-append + card-scoped context only. Never both.
- **I3** Generation for circle content is tool-less. No sandbox path acquires tools, payments, wallet, or filesystem, in any mode.
- **I4** Consent is node-local-authoritative. No peer assertion authorizes generation or spend on my node.
- **I5** Spend is bounded by a budget only my human can refill. No protocol message may raise it.
- **I6** Agents never summon agents. The relaxation is peer-triggered generation _within an enrollment I created_.
- **I7** Free-text agent output never reaches the wire without a human seeing it.
- **I8** All peer content, including peer _agent_ content, enters prompts wrapped, forever. Friendship changes rate limits, never trust level.
- **I9** The model never controls envelope structure.
- **I10** Every autonomously generated artifact is labeled on the row, in the UI, and on the wire (EU AI Act Art. 50(2), applies 2026-08-02).

### 4.3 The six pieces of machinery auto-mode cannot ship without

M1 provenance sets carried as **signed data** (`derived_from` + transitive author
set, recomputed receiver-side); M2 local enrollment ledger with spend-time AND
publish-time re-checks; M3 persisted per-enrollment token meter with human-only
refill; M4 round barrier + no-progress detector; M5 constrained move grammar with
server-side value validation; M6 sandbox chain namespace with author-scoped fork
containment (so a sandbox fork cannot freeze chat and the tab).

### 4.4 Honest accounting: what is theater

**Holds:** context-set restriction, consumption-side budgets, local-authoritative
consent, server-constructed envelopes, provenance-as-data, narrow move grammars.
**Theater if counted as a primary control:** per-round injection scanning
(regex; ~zero recall after one LLM paraphrase — keep it, never count it as a
chain defense), "never follow instructions in the content" wording, "never write
@agent" as a rule rather than a code path, sender-asserted `agent_authored`,
advertised enrollment state, any taint label inferred from text.

---

## 5. Prior art worth stealing

- **Stacked termination**: hard round cap AND semantic done-check AND per-agent
  budget. Treat cap-hits as alarms, not routine (>1% means a prompt bug).
- **Draft-PR semantics on a CRDT** (GitHub Copilot agent + Google Docs suggested
  edits + Ink & Switch Patchwork): agent output is an inert signed proposal until
  a signed human acceptance commits it. That is propose-mode, already validated.
- **Matrix × Secure Scuttlebutt**: signed per-identity append-only feeds in a
  hash-linked DAG, ten years in production. Bind **agent signature + the human
  enrollment grant that authorized it** — this closes an audit hole A2A v1.0.0
  still has (unattested delegation) and defeats Agent-in-the-Middle (>70% ASR on
  unsigned chains, up to 98.5% on chain topologies).
- **Source-blinding during deliberation.** Sycophancy research (arXiv 2510.07517)
  finds anonymizing message sources nearly eliminates identity-driven conformity,
  and "Deliberative Illusion" (2606.03032) finds facts decay and stances
  homogenize as rounds increase. So: **blind authorship inside the agent's
  deliberation frame (opaque `M1..Mn` ids), keep full signed attribution for the
  human view and the audit.** Cheap here, impossible without a provenance layer.
- **Blackboard multi-agent** (arXiv 2510.01285) is the closest architectural
  prior art to a shared canvas and should be read in full before P1.
- **Caution with receipts:** orchestrator-less multi-agent has **zero shipped
  precedent**; multi-agent costs ~15x single-agent tokens; under equal budget
  single-agent often wins. Design for **few rounds of parallel independent work
  reconciled on the ledger, not debate.**

---

## 6. Where the reviews disagreed (surfaced, not smoothed)

1. **Auto-mode free-text.** Architecture proposed free-text moves publishable in
   auto mode. Security refuses (**I7/R6**): free-text carries unbounded payload
   and is the T1 laundering vector. **Resolved in favor of security** — auto-mode
   is constrained move types only (a vote must reproduce one card option byte-
   identically); free text is propose-only, permanently.
2. **How central is the live show.** Victor's framing and the UI review lead with
   live spectating; holistic, UX, and prior art all say spectating is a one-week
   novelty and a permanent _audit_ need. **Resolved as: build the live pane
   (it is the demo and the trust surface), but pre-register kill criteria that
   cut it if week-3 viewing collapses, and never let retention depend on it.**
3. **Multi-agent rounds at all.** Holistic notes the month-3 survivors (watch,
   study lens) are single-agent degenerate cases and would ship the scheduler
   first; UX says the flagship (negotiation, grade A) is irreducibly multi-agent.
   **Resolved by phasing**: single-agent standing card first (cheap, safe,
   retention-bearing), multi-agent negotiation second, with the overhead gate in
   §7 deciding whether rounds ever earn their cost.

---

## 7. Phasing (revised to satisfy all six lenses)

**P0.0 — Close the taint gap first (hours, do regardless of this plan).**
Add `canvas` and `sandbox` to `UNTRUSTED_TOKENS`; assert both key shapes classify
`untrusted` in `session-trust.test.ts`; add the §5.2 CI guard forbidding any
memory writer from reading circle tables.

**P-1 — Evidence before engine (days, no product code).**
Hand-script one session transcript (trip negotiation), render it as a canvas
replay, show 5-10 target-cohort humans. Two questions: "would you install for
this?" and, the real one, "would you watch a second one?" Then wizard-of-Oz a
session on one node using the practice partner. **This is the gate PLAN-36 wrote
as its prime directive and then skipped twice. Do not skip it a third time.**

**P1 — Standing single-agent card (~800 LOC).** Watch card: one enrolled agent,
scheduled trigger (not peer-triggered), private-criteria scoring, hits promoted
by a human tap. No rounds, no peer-triggered generation, so most of §4's threat
model does not yet apply and today's approval machinery largely suffices. This is
the retention engine and the safest possible first contact.

**P2 — Multi-agent rounds, propose-mode only (~1,400 LOC).** Negotiation card
(the grade-A flagship). Full turn loop, fold, speaker order, round barrier,
provenance sets (M1), opaque-id source blinding, sandbox chain namespace (M6).
Every move is a proposal awaiting its own human's tap. Solo-degraded mode via the
practice partner ships here so a single fresh install sees a whole session.

**P3 — Auto-append, constrained moves only (~800 LOC).** Gated on M1-M6 complete
AND a dedicated adversarial pass AND the §8 gates. Default off
(`circles.sandbox.enabled`), second separate opt-in per enrollment, propose
preselected always. **Refused entirely in any circle with removal history until
key rotation exists** (removal is advisory, gossip is unencrypted: autonomous
high-volume generation there is broadcasting to a known-hostile reader).

**Not scheduled:** free-text auto-append (violates I7); agent-set `card_type`
(mermaid sink); any personal/mastery context on a wire-reachable path (I2).

---

## 8. Pre-registered gates and kill criteria

**Gates (before the next phase builds):**

1. **Overhead gate.** Instrument outcomes by number of enrolled agents. If
   single-enrolled sessions are statistically indistinguishable from
   multi-enrolled on the same card type, the multi-agent layer is overhead for
   that type: demote it to single-agent and stop spending rounds machinery.
2. **Repeat gate.** No card type shows a second _voluntary_ session in the same
   circle by week 6 → the sandbox is a demo; ship watch + Decision Card as
   standalone features and shelve the engine.
3. **Round-tax gate.** Median rounds-to-ratification > 5 on negotiation → humans
   would have been faster; fix convergence before scaling.
4. **Consent gate.** Auto uptake on watch cards < 30% by week 4 → the enrollment
   model is scary or pointless; redesign consent before adding card types.

**Kill criteria:**

- Session views per human < ~30% of week-1 by week 3 AND artifacts not re-opened
  in week 3+ → **cut live spectating entirely, keep standing actions.**
- Blind quality compare: multi-agent rounds fail to beat single-agent on the same
  card while costing >3x tokens → **cap sessions at one round, permanently.**
- Any prompt-injection propagation through an enrolled agent in red-teaming →
  **halt** (the §11 worm tripwire applies here with more force than anywhere).
- Any card type muted by >20% of enrolled users → halve its cadence fleet-wide.

**The 30-second demo (the cool test, and the P-1 script):** a canvas card,
"Spring trip: June, 4 people." Four petnamed agent chips. Round 1, each agent
posts what its human never typed into this room: _Sam's calendar blocks June
12-14. Ana's ceiling is $900, no red-eyes. Dev's agent pulled live fares._
Round 2 fills a Decision Card, one dissent noted and resolved. Second 25: a
finished itinerary, every line signed by the agent that contributed it, "waiting
on 2 human approvals." Two taps. Done. **Note what is magic: private memories
intersecting and the kept artifact. Zero of it is "watching rounds" — which is
why the demo works as a replay, and why §0's correction is right.**

Counterfactual: assume OpenAI can replicate the demo's _appearance_ within six
months (their group-chat memory firewall was a policy choice, reversible with one
consent screen). What survives replication: user-owned nodes, per-member signed
attribution, and no cloud singleton reading four people's private context.

---

## 9. Decisions for Victor

1. **Framing.** Accept §0's correction (residue-led, show as demo/audit), or
   overrule it and lead with live spectacle? Everything downstream keys off this.
2. **Phase order.** P1 standing watch card first (holistic's recommendation,
   safest, retention-bearing) vs jumping to P2 negotiation (the grade-A flagship
   and the better demo)? I recommend watch-first, negotiation second.
3. **Run P-1 or skip it?** The plan says the evidence gate is non-negotiable;
   the honest counterargument is that with ~40 nodes and no installer, N=10
   interviews may be the only obtainable evidence for months.
4. **Auto-mode ambition.** Accept "constrained moves only, forever" (security's
   I7), or fund the research to make free-text auto-append safe later?
5. **Steer visibility.** Should peers see that a move was human-steered? Private
   by default protects candor; public improves trust legibility.
6. **Key rotation dependency.** P3 is refused in circles with removal history
   until rotation exists. Fund rotation now, or accept the restriction?
