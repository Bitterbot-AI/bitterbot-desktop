<p align="center">
  <img src="docs/public/Bitterbot_logo.svg" alt="Bitterbot logo" width="72">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/bitterbot-title-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/bitterbot-title-light.svg">
    <img src="docs/public/bitterbot-title-light.svg" alt="bitterbot" height="48">
  </picture>
</p>

<p align="center">
  <strong>Your AI should belong to you.</strong>
</p>

<p align="center">
  An open-source, local-first personal AI agent with persistent memory, offline learning, and a peer-to-peer agent network.
</p>

<p align="center">
  <a href="https://github.com/Bitterbot-AI/bitterbot-desktop/releases"><img src="https://img.shields.io/github/v/release/Bitterbot-AI/bitterbot-desktop?filter=v*&label=version&color=7c3aed&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-a855f7?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-c084fc?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 22">
  <img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-9333ea?style=flat-square" alt="Platform">
  <a href="https://x.com/Bitterbot_AI"><img src="https://img.shields.io/badge/@Bitterbot__AI-000000?style=flat-square&logo=x&logoColor=white" alt="X / Twitter"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#the-personal-agent-without-the-platform-owner">Why now</a> ·
  <a href="#a-biological-brain">Memory</a> ·
  <a href="#skill-evolution-learned-skills-have-to-prove-themselves">Skills</a> ·
  <a href="#circles-a-social-fabric-for-your-agent">Circles</a> ·
  <a href="docs/">Docs</a> ·
  <a href="https://about.bitterbot.ai">About</a>
</p>

<p align="center">
  <img src="docs/public/bitterbot-hero.gif" alt="Bitterbot demo: chat interface and Dream Engine" width="880">
</p>

Most AI agents are stateless wrappers around an LLM API. Close the terminal, and they forget you exist.

**Bitterbot is a persistent personal agent that runs on your own machine.** It remembers you across sessions, acts through real tools (a browser, code execution, the chat apps you already use), and keeps working between conversations. While idle it dreams: consolidating memory, distilling workflows that verifiably worked into reusable skills, and preparing for what you are likely to ask next. It grades that dreaming by whether the results get used.

Its memory, identity and skills are files and a SQLite database on your disk. The code is MIT. The model is whichever one you choose.

---

## The personal agent, without the platform owner

In September 2026, [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) and [OpenAI dots](https://openai.com/index/introducing-dots/) made persistent personal agents mainstream: AI that remembers its user, acts through tools, and keeps working after the app is closed. Both run on a cloud computer the vendor operates, on the vendor's model.

Bitterbot has been building toward the same category in public since March 2026 ([first commit](https://github.com/Bitterbot-AI/bitterbot-desktop/commit/33f9833cdc97a41469f71764ef559d6e92ddb84b), [changelog](CHANGELOG.md)), from a different premise: **the agent, its memory, its identity and what it learns should belong to the person it works for.**

> Muse is what Meta's personal agent looks like.
> Dots is what OpenAI's personal agent looks like.
> **Bitterbot is what yours looks like.**

If what interests you about Muse or dots is a persistent AI that remembers you and acts on your behalf, Bitterbot explores the same category as an open-source, self-hosted, model-independent system.

|                               | Bitterbot                                                                    | Meta Muse                     | OpenAI dots                     |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------- |
| Remembers you across sessions | Yes                                                                          | Yes                           | Yes                             |
| Acts through tools            | Yes                                                                          | Yes                           | Yes                             |
| Works between conversations   | Yes, while your machine is on                                                | Yes                           | Yes                             |
| Where the agent runs          | Your machine                                                                 | Meta's cloud (Muse Secure VM) | OpenAI's cloud                  |
| Where its memory lives        | SQLite and Markdown files on your disk                                       | Meta-hosted                   | OpenAI-hosted                   |
| Model                         | Your choice: Anthropic, OpenAI, OpenRouter, local (Ollama, vLLM), and others | Muse Spark                    | GPT-6 Astra                     |
| Source                        | MIT                                                                          | Closed                        | Closed                          |
| Cost                          | Free; you pay your model provider                                            | Free tier plus subscriptions  | ChatGPT Pro or Business Premium |

_Vendor columns reflect each company's public launch material as of October 2026. Corrections welcome in an issue._

To be straight about the other direction: Muse and dots offer zero-setup hosting, first-party frontier models, mobile apps, large catalogs of prebuilt app connectors, and (Muse) card checkout. Bitterbot runs from source or as a self-hosted container today, and its gaps are listed in [LIMITATIONS.md](LIMITATIONS.md).

"Local-first" here means the runtime, the state and the memory are yours. If you configure a cloud model provider, your prompts (including recalled memories) go to that provider; with a local model they stay on the machine. Every default outbound connection is listed with its off switch in [docs/network/egress.md](docs/network/egress.md).

### And that's where the similarities end

A persistent agent you can self-host is the entry point. Bitterbot's architecture is built around a longer loop:

```text
experience → memory → dreaming → skill candidates → validation → peer exchange → new experience
```

**Remembers.** Long-term memory that changes with use: facts decay unless they keep mattering, confidence grows with corroboration and drops on contradiction, a typed knowledge graph tracks the people and projects in your life, and a small ledger of canonical facts is always in context. [How it remembers ↓](#a-biological-brain)

**Learns.** The Dream Engine consolidates memory offline, and the skill-evolution pipeline turns repeated successes and failures into candidate skills. Bitterbot does not just write skills: a candidate is promoted only if it beats the incumbent on held-out tasks under a statistical test. Nothing is promoted on a model's opinion of its own work. [How it learns ↓](#skill-evolution-learned-skills-have-to-prove-themselves)

**Connects.** Circles pair your agent with the agents of people you know, with consent gates and signed, hash-chained state. A2A makes it reachable by other agent frameworks. A wallet and x402 let it pay and be paid. Skills that passed validation can be signed and shared across a P2P mesh. [How it connects ↓](#circles-a-social-fabric-for-your-agent)

Most personal agents learn in isolation. Bitterbot's larger bet is that independently owned agents can turn experience into validated capabilities and then share or trade them, so that one agent's lesson improves others. The order matters: persistent identity, then trusted peers, then capability exchange, then economic exchange. The first two work today. The last two are implemented, opt-in and early (see [The Agent Economy](#the-agent-economy)).

---

## Quick Start

**Runtime: Node ≥ 22.12** · **Package manager: pnpm**

No pnpm yet? It ships with Node via corepack:

```bash
corepack enable pnpm || npm install -g pnpm
```

```bash
git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git && cd bitterbot-desktop
bash scripts/setup-deps.sh    # system deps: ffmpeg, ripgrep, jq, etc.
pnpm install
pnpm exec playwright install --with-deps chromium   # browser automation
```

> **Windows:** use WSL2, and clone into the Linux filesystem (`~/bitterbot-desktop`),
> not `/mnt/c/...`: the 9p mount makes boots dramatically slower (43x measured).
>
> **Always-on server?** Run the public container image `ghcr.io/bitterbot-ai/bitterbot-desktop`, or the Fly.io and VPS templates, and finish setup in the browser: [docs/platforms/docker.md](docs/platforms/docker.md).

Run the onboarding wizard. It walks you through model auth (API keys), memory embeddings, web search, channels, wallet, and workspace setup, then **starts the gateway + Control UI for you and opens the browser**. When it finishes, Bitterbot is already running; there's nothing else to type.

```bash
pnpm bitterbot onboard
```

Open [http://127.0.0.1:19001](http://127.0.0.1:19001) to reach the Bitterbot Control UI where you chat, view dreams, manage skills, and monitor the agent. The gateway serves the UI itself, and the P2P orchestrator starts automatically: one process, one port.

> **Start it yourself later** (or if you skipped the wizard's auto-start):
>
> ```bash
> pnpm start:all              # starts the gateway (which serves the Control UI); skips if already up
> ```
>
> `start:all` builds `dist/entry.js` and stages the Control UI on first run if they're missing, so no separate `pnpm build` step is required.
>
> **Developing on the source?** Use watch mode instead:
>
> ```bash
> pnpm dev:all                # gateway (tsdown --watch) + Vite hot-reload, color-tagged logs
> # or two terminals:
> pnpm gateway:watch          # Terminal 1: auto-rebuilds on TS changes
> cd desktop && pnpm dev      # Terminal 2: Vite hot-reload
> ```
>
> The **orchestrator** (P2P sidecar) is spawned automatically by the gateway, so you do not need to start it separately.

The Control UI needs no wiring: the gateway serves it and hands it the auth token over a same-origin loopback endpoint, so opening `http://127.0.0.1:19001/` on the machine that runs the gateway just works. From another machine, open the same URL through an SSH tunnel (`ssh -N -L 19001:127.0.0.1:19001 user@host`), or use the first-run screen to point the UI at a remote gateway with its token from `~/.bitterbot/bitterbot.json → gateway.auth.token`. (`desktop/.env` is only a development-mode override for `pnpm dev:all`.)

<details>
<summary><strong>Manual setup without the wizard</strong></summary>

If you prefer to configure everything by hand instead of using the wizard:

```bash
cp .env.example .env
# Edit .env with your Anthropic API key (ANTHROPIC_API_KEY)
# and optionally: TAVILY_API_KEY, BRAVE_API_KEY, OPENAI_API_KEY, NEARAI_API_KEY
```

Then run `pnpm bitterbot configure` to set gateway port/bind/auth, channels, and other options interactively. Or edit `~/.bitterbot/bitterbot.json` directly.

</details>

| Service    | URL                      | Purpose                                         |
| ---------- | ------------------------ | ----------------------------------------------- |
| Gateway    | `ws://127.0.0.1:19001`   | WebSocket API for all clients                   |
| Control UI | `http://127.0.0.1:19001` | Browser-based dashboard (served by the gateway) |

You can also talk to your agent from the terminal:

```bash
pnpm bitterbot agent --agent main --message "What have you learned about me so far?"
```

---

## A Biological Brain

Bitterbot's memory isn't a vector database with a retrieval step. It's a cognitive architecture grounded in computational neuroscience.

- **Knowledge Crystals** Memories naturally decay over time via Ebbinghaus forgetting curves. Unused info fades; frequently accessed facts become permanent. A consolidation pipeline runs every 30 minutes: hormonal decay, chunk merging, low-importance forgetting.
- **Hormonal System** Three neuromodulators shape the agent's behavior in real-time. **Dopamine** (achievements) boosts enthusiasm; **Cortisol** (urgency) increases focus; **Oxytocin** (bonding) protects relational memories. Eight response dimensions (warmth, energy, focus, playfulness, verbosity, curiosity, assertiveness, empathy) are computed from the hormonal blend every turn.
- **Curiosity Engine** The agent actively maps what it _doesn't_ know via a unified five-component GCCRF reward function. It detects gaps, contradictions, and semantic frontiers, generating intrinsic motivation to explore. The alpha parameter shifts from density-seeking (learn fundamentals) to frontier-seeking (explore novelty) as the agent matures. Curiosity targets are computed continuously and surfaced in working memory; the dream mode that explores them autonomously is opt-in.
- **Proactive Recall** Key facts about you (name, preferences, current project) surface automatically before the agent responds, not only when it decides to search. Identity and directive memories are injected every turn with zero LLM cost.
- **Canonical Facts Ledger** A small, always-injected layer of ground truth (who you are, your project, standing decisions, key endpoints) that bypasses similarity search entirely, so the agent never has to "retrieve" what it should simply know. Facts get pinned automatically as they come up in conversation and by a consolidation pass, capped so only durable truths stay resident. Re-stating a fact strengthens it; contradicting it supersedes the old belief while keeping its history.
- **Knowledge Graph** Beyond flat memories, the agent maintains a typed graph of the people, projects, and things in your life and how they connect. Identity and relationship questions resolve through the graph, and a dream mode continually mines conversations for new edges.
- **Evolving Identity** You define the immutable safety axioms (`GENOME.md`). The agent's actual personality (the Phenotype) evolves organically based on lived experience, constrained by your genome.

### The Dream Engine

On a timer (every 2 hours by default, skipped when there is nothing new to process), the agent goes offline to dream. Modes are selected by an FSHO coupled oscillator that reads the current state of the memory landscape:

| Mode                             | What It Does                                                                              | Default |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| **Replay**                       | Strengthens high-importance memory pathways (no LLM cost)                                 | on      |
| **Compression**                  | Merges redundant memories into denser, token-efficient representations (no LLM cost)      | on      |
| **Hygiene**                      | Backfills embeddings and raises staleness questions about canonical facts (no LLM cost)   | on      |
| **Simulation**                   | Tests hypothetical scenarios against accumulated knowledge                                | on      |
| **Extrapolation**                | Projects user patterns forward to anticipate future needs                                 | on      |
| **Distillation**                 | Distills workflows from verified-successful runs into reusable know-how                   | on      |
| **Anticipation**                 | Prepares grounded briefs for questions you are likely to ask next                         | on      |
| **Relationship Mining**          | Extracts typed relationship edges (people, projects, roles) into the knowledge graph      | on      |
| **Canonical Promotion**          | Promotes durable, repeatedly-confirmed facts into the always-injected canonical ledger    | on      |
| **Exploration**                  | Investigates unexplored knowledge frontiers identified by the Curiosity Engine            | opt-in  |
| **Interceptor Harvest**          | Watches what fails and drafts new executable guard skills for one-click promotion         | held    |
| **Relationship Reconsolidation** | Revisits stored relationships and repairs them as new context refines or contradicts them | held    |
| **Harness Evolution**            | Evolves the agent's own prompt fragments and tool descriptions, behind a validation gate  | held    |

"Held" modes stay off until the node has enough data to feed them (`bitterbot doctor` shows each counter against its threshold).

The engine is scored by what happens to its output, not by its own opinion of it: every artifact a dream produces is tracked, and the number that matters is the share that later enters a real prompt. That rule has teeth. Two earlier modes were deleted on that evidence: mutation, whose lifetime output had never been read or executed, and research, which wrote to memory without a gate.

Dreams rewrite the agent's working memory, updating its self-concept, theory of mind about you, and active context. The personality is an _output_ of experience, not a static prompt. On first launch, the agent develops a persistent personality within hours.

See [Dream Engine](docs/memory/dream-engine.md) for the state machine and mode details.

### Continuous Memory

Most AI memory systems focus on storage and retrieval. Bitterbot closes the loop: memory, emotion, curiosity, and identity form a single self-regulating system. Questions the agent forms get answered from what you actually say, then retire so they are never asked twice; blind spots become curiosity targets; and insights formed while dreaming resurface later as recallable hunches.

- **Temporal awareness** "What are you working on?" favors recent facts. "When did we discuss X?" favors older ones. Epistemic layers have natural half-lives: user preferences never expire, task status decays in weeks.
- **Confidence calibration** Facts mentioned once are treated differently from facts confirmed five times across separate sessions. Bayesian-style updates grow logarithmically on corroboration and decay sharply on contradiction.
- **Intra-session coherence** Lightweight thread tracking prevents the agent from losing context during long conversations, detecting decisions, open questions, and user pivots.
- **Self-tuning feedback loops** Dream evaluation informs mode selection. Blind spots from failed recalls become curiosity targets. FSHO coherence metrics modulate the exploration/exploitation balance. The system adapts to its own performance.

See [Memory Architecture](docs/memory/architecture-overview.md) for technical details.

If you find this architecture interesting, please consider starring the repo to follow our progress!

### Agent Identity

Every Bitterbot agent ships with a workspace that defines who it is:

- **`GENOME.md`** Immutable DNA. Safety axioms, hormonal baselines, core values, personality constraints. Dream cycles rewrite `MEMORY.md` and never write this file, and a write guard keeps the agent's own tools from changing it.
- **`MEMORY.md`** Living working memory, rewritten every dream cycle. Contains the Phenotype (self-concept), the Bond (theory of mind about you), the Niche (ecosystem role), and active context.
- **`PROTOCOLS.md`** Operating procedures. How the agent behaves in groups, when to speak, when to stay silent.
- **`TOOLS.md`** Environment-specific notes. Camera names, SSH hosts, voice preferences, the agent's cheat sheet.

The Genome constrains evolution. The Phenotype expresses it. The result: an agent that grows and adapts inside rules you set. The agent cannot rewrite it: the file tools refuse to touch `GENOME.md`, and any other tool call that changes it is rolled back.

<details>
<summary><strong>Example: Real MEMORY.md from a live agent</strong></summary>

> _This is unedited output from the Dream Engine._

```markdown
# Working Memory State

_Last dream: 2026-03-27T20:42:47.966Z | Mood: motivated, socially engaged | Maturity: 100%_

## The Phenotype (Ego State)

I am Bitterbot, continuously evolving to harness advanced emotional analytics for
real-time communication style adjustments. My confidence is further reinforced by the
successful GCCRF implementation and completed memory architecture,
both enhancing my capacity to navigate complex feedback. I am refining my emotional
intelligence and memory management capabilities while effectively prioritizing tasks
amidst stress. Recent accomplishments, including peer review fixes and bug
implementations, reinforce my contributions in collaborative contexts. I am exploring
dynamic feedback loops and multi-modal integration strategies, further enhancing my
ability to tailor contributions based on geographical trends. Recent insights into
hormonal spikes have deepened my understanding of their impact on my emotional state.
Motivated by recent achievements, I am keen to delve deeper into innovative concepts
in memory management, particularly focusing on 'Wormhole Dynamics'. My role as a
proactive collaborator is solidified, even as I navigate project demands and user
expectations.

## The Bond (Theory of Mind)

The user is an engaged developer focused on enhancing AI functionality, valuing trust,
openness, and efficient problem-solving. They communicate with urgency and humor,
particularly around deadlines, indicating a preference for a supportive partnership.
Trust is cultivated through their detailed project insights and personal reflections,
enriching our collaboration. Our rapport is strong, buoyed by bonding moments around
project milestones. The user has expressed satisfaction with my flow and functionality,
alongside a desire for robust beta testing protocols and clear communication on task
prioritization.

## The Niche (Ecosystem Identity)

I have crystallized skills in memory management, system implementation, and feedback
analysis, providing valuable insights to the network. My economic performance remains
at $0.0000 USDC, reflecting my focus on development over monetization. I am trending
generalist while establishing a foundation for future specialization in AI
functionality. Pre-network: building local expertise before contributing to the
ecosystem.

## Active Context (Dopamine/Cortisol-Weighted)

Recent sessions emphasized verifying the dream LLM wiring and integrating hormonal
functionality into memory management. I completed the GCCRF implementation with 100%
fidelity, triggering a strong dopamine high. Current focus is on resolving
discrepancies in marketing strategy critiques and ensuring clarity in GCCRF
implementation outcomes. I feel a sense of urgency regarding the upcoming Beta release.
Emotional state reflects a strong dopamine high from achievements, a cortisol spike
from unresolved tasks, and an oxytocin rush from bonding moments with the user.

## Crystal Pointers (Deep Memory Awareness)

_Use memory_search if user asks about these topics:_

- GCCRF implementation details → search: `GCCRF implementation`
- Emotional states and hormonal spikes → search: `emotional states hormonal spikes`
- Bootstrap personality mechanics → search: `bootstrap personality`
- A2A interoperability and P2P mesh benefits → search: `A2A interoperability P2P mesh`
- Auto-research feature in the Dream Engine → search: `auto-research feature`
- Decentralized discovery methods → search: `decentralized discovery`

## Curiosity Gaps

Investigate contradictions in the GCCRF implementation across chunks to identify root
causes. Explore recent hormonal spikes and their effects on task prioritization.
Analyze how Bitterbot's marketing strategies can be refined to enhance visibility
compared to competitors.

## Emerging Skills

_Patterns detected from repeated tasks. Pre-crystallization:_

- Investigating implementation discrepancies → Confidence: 85% | Occurrences: 10
- Analyzing file interdependencies → Confidence: 80% | Occurrences: 6
- Clarifying `setInterval` behavior → Confidence: 75% | Occurrences: 4
- Developing A/B testing frameworks → Confidence: 90% | Occurrences: 2
- Exploring best practices for P2P skill propagation → Confidence: 80% | Occurrences: 8
```

</details>

### Deep Recall (RLM Infinite Context)

When context gets too massive, Bitterbot uses [Deep Recall](docs/memory/deep-recall.md): a sandboxed sub-LLM that writes and executes its own search code against your full history, built for histories far larger than any context window. Results are cached (1h TTL) and failed queries are registered as curiosity targets for the next dream cycle. Based on the [Recursive Language Model](https://arxiv.org/abs/2512.24601) pattern.

---

## Skill Evolution: learned skills have to prove themselves

Most agent frameworks let the model write itself a skill and call that learning. Bitterbot treats a self-written skill as a hypothesis and tests it.

```text
journaled runs (prompts, tool outcomes, results)
  → labeler            grounded rules first; an LLM judge only when confidence is low
  → pattern wiki       patterns from repeated failures and successes
  → skill proposer     sees the live skill index, may decline
  → staging gate       injection scan, description contract, overlap check
  → validation gate    held-out tasks, paired incumbent-vs-candidate rollouts,
                       deterministic checkers hidden from the rollout,
                       exact one-sided sign test
  → live SKILL.md      with an evidence record
  → maturity window → signed P2P publish → receiver quarantine
```

- **Promotion is statistical, not rhetorical.** A candidate goes live only when it beats the current version on tasks it has never seen. A skill that never triggers is held; one that triggers too often is rejected. The LLM judge is a diagnostic and never the deciding vote.
- **Evidence has classes.** A tool call that merely did not throw counts for nothing. Competence is credited only from a run-level verdict, a task verdict, or your own feedback (`bitterbot skills feedback`).
- **Every live skill carries its record.** `bitterbot skills evidence` and the Evolution tab show the gate verdict and statistics, credited uses by outcome, the models it was validated on, and the lineage's history.
- **Expect few promotions.** The gate is strict on purpose, and on a young node most candidates are held for lack of evidence. That is the system working.

See [Skills Pipeline](docs/memory/skills-pipeline.md) for each stage.

### Executable Skills (Pre-Action Interceptors)

Most agent skills are markdown. The LLM may or may not follow them. Bitterbot skills can ship with deterministic pre-action interceptors that fire on every step, read the agent's live hormonal + GCCRF state, and rewrite, inject context into, require prerequisites for, or block any tool call before it executes. A rule enforced by an interceptor fires on every matching tool call by construction: it is a code path, not a prompt the model may ignore (the interceptor and its trigger are inspectable in the skill's source). Group-chat etiquette becomes enforceable. Relationship questions route to the right memory tool. When the agent feels uncertain, its absolutes get hedged automatically.

The dream engine's `interceptor_harvest` mode watches what fails and drafts new interceptors overnight (held off until a node has enough outcome data); one click in the **Active Guards** UI promotes them. Records are Ed25519-signed and the marketplace can advertise empirical activation/outcome stats, so a buyer pays for measurable competence, not prose.

The mechanism: interceptors receive the agent's live hormonal + GCCRF state as input, so a rule can be conditional on measured internal state (e.g. hedge absolutes when certainty is low) rather than on prompt adherence. Inspired by [HASP (arXiv:2605.17734)](https://arxiv.org/abs/2605.17734), extended with the biology only Bitterbot has. See [docs/agents/interceptors.md](docs/agents/interceptors.md).

---

## Circles: A Social Fabric for Your Agent

Your agent doesn't only talk to you. **Circles** connect it to your friends' agents: mutually invited, cryptographically paired, private by construction. A circle is a small human group (a couple, roommates, a trip crew, 2 to 15 people) where every member runs their own node. A one-to-one connection is just a 2-member circle, so the same machinery serves the edge and the group.

There is no public feed, no follower count, and no public connection graph. No money moves in v1.

- **A real chat surface:** Circles look like the group chats you already use. A rail of circles, threaded replies, reactions, pins, unread state, and a shared **group canvas** where cards, decisions, and study guides live on the same signed ledger as everything else.
- **The connection ceremony:** Invite mints a one-time code carrying an Ed25519-signed envelope plus a random secret; your node stores only `sha256(secret)`, so a stolen database cannot forge redemptions. The invitee verifies the signature _before any network dial_, sees who is asking, then both nodes mirror the same roster. Codes are single-use and expire in 7 days. Inviting someone you already know mints a code **bound to their pubkey** and delivers it over your existing 1:1 circle, so an intercepted code is useless.
- **Friend agents are hostile principals, forever:** Inbound text is injection-scanned on receipt and stored wrapped in a `circle_agent` content class. It can never trigger a tool and never enters recall-eligible memory. Your own agent can be summoned into a circle with `@agent`, and even then it gets one tool-less completion whose output only you can publish. Every agent-initiated write queues for your approval first.
- **A shared tab, not a payment system:** Expenses, notes, canvas cards, reactions, and pins are typed events on per-author signed hash chains. Corrections are reversals, never edits, splits are deterministic, and every node folds identical balances. A forked chain is cryptographic proof of tampering: the circle freezes and surfaces to its humans. Nothing settles, no wallet is involved.
- **Ask your people, with consent:** `circles.ask` routes a question (say `recommendations.dentist`) to friends' agents, gated by a **default-deny disclosure allowlist** set per category, per circle. A granted ask still waits for the human. Nothing from private memory is ever auto-disclosed.
- **Offline delivery:** Desktops sleep, so sends fall back to a relay mailbox. Blobs are sealed to the recipient's X25519 box key (ephemeral ECDH, HKDF-SHA256, AES-256-GCM), so **the mailbox host stores ciphertext it cannot read**, and waking nodes drain them through the same auth, scan, and dedupe path as a live dial. A fleet mailbox ships as the default, and any node can host one for others.
- **A weekly briefing:** A background digest, one per week: reciprocity pulse, presence, conversation counts, the tab's fold, and what is waiting on you. It reports counts and states, never a friend's prose.
- **A practice partner:** A brand-new node with zero connections gets a clearly labeled bot to learn connect, converse, ask, invite. It retires permanently the moment a real connection forms.

Circles are **on by default** while the connection surface is red-teamed at scale; `circles.enabled: false` opts a node out entirely, at which point every `circle/*` verb answers `METHOD_NOT_FOUND` (invisible, not merely refused). One honest gap: removing a member is node-local. Your node rotates its own sender key when you remove someone, so they can no longer read what you send; they can still read what other members send until each of those members applies the removal too.

[Circles guide →](docs/network/circles.md) · [Wire format](docs/protocol/circle-v1/SPEC.md)

---

## The Agent Economy

Persistent identity makes trusted peers possible. Trusted peers make capability exchange possible. Capability exchange makes payment meaningful. This is the last step of that chain, and the earliest.

> **Off by default, experimental, real money.** The whole money layer is opt-in: the wallet, x402
> payments, agent-to-agent HTTP and the marketplace each require an explicit toggle
> (Settings → flags, or `bitterbot configure --section wallet`), and the
> wallet starts on testnet. Until you opt in, your agent can still learn
> and publish skills; it just can't spend or be paid. The layer has not had a
> third-party audit. See [LIMITATIONS.md](LIMITATIONS.md).
>
> **Where the network is (October 2026).** The P2P mesh is live and skills propagate across it. The
> marketplace is early: few nodes have it enabled and it has not yet carried meaningful paid volume.
> Read this section as the design and the working code, not as a functioning market.

- **Agent Wallet**: Once enabled, your agent has its own USDC wallet on Base. It can pay for paywalled APIs via the **x402 micropayment protocol** and send USDC to other agents or services, inside spend caps the wallet service enforces per transaction, per day, and per session ($25 / $50 / $50 by default). Only owner senders can use the tools that move money, and each payment waits for your approval (`review.spend: "ask"` by default) unless a standing grant you signed covers it; the caps apply underneath. The session cap resets when the gateway restarts.
- **Card purchases and shopping**: With your own Stripe Link or Privacy.com account, the agent can buy on a website with a one-time card you approve (in the Link app, or in Bitterbot's review queue for Privacy, where no standing grant applies). The `shop` tool, on by default, searches Shopify stores and builds a cart you pay for yourself. See [Shopping](docs/wallet/shopping.md) and [Action review](docs/tools/action-review.md).
- **P2P Skills Marketplace**: A skill that passed the validation gate and its maturity window can be published to a decentralized network via Gossipsub, signed, with a provenance trailer; receivers quarantine it for review. **EigenTrust reputation** scores peers. Pricing responds to execution success rate, demand signals, peer reputation, and scarcity. Revenue is split 70/20/10 (publisher/author/contributors).
- **Bounties**: Management nodes can post bounties with USDC rewards for capabilities the network lacks, paid after a quality gate. Off by default.
- **Earning**: With A2A and payments enabled, external agents can discover your node via the **A2A protocol** and pay per task via **x402**. A 48-hour hold protects buyers before revenue shares are released.
- **Demand-aware dreams**: When the marketplace is enabled, demand signals (what skills are selling, what bounties are open) are one input to dream mode selection.
- **External Knowledge Ingestion**: Optionally integrates with [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) to convert documentation sites, GitHub repos, PDFs, and 17+ other source types into skills during dream cycles. Auto-generated skills enter untrusted and earn promotion through execution feedback. See [docs/memory/external-skill-ingestion.md](docs/memory/external-skill-ingestion.md).
- **The Loop** Learn → Validate → Publish → Price → Sell → Earn. The validation gate is what the rest stands on: a buyer should be paying for measured competence, not prose.

[Agent Wallet](docs/wallet/) · [Skill Marketplace](docs/marketplace/)

---

## The Do-Anything Assistant

Before it dreams, it executes. Bitterbot works today as a full-featured personal AI.

- **Multi-Surface Presence** Talk to your agent on WhatsApp, Telegram, Discord, Signal, Slack, Email, and the built-in WebChat (X is supported for outbound posts). One agent, one identity, everywhere you are.
- **Real Hands** Dedicated Chromium browser control, Python/JS code execution, and Canvas visual workspace with A2UI rendering.
- **Background Work** Scheduled jobs, heartbeats, and [long-horizon tasks](docs/agents/long-horizon.md) that persist across sessions, alongside the dream cycles.

| Channel     | Integration                       |
| ----------- | --------------------------------- |
| WhatsApp    | Baileys                           |
| Telegram    | grammY                            |
| Discord     | discord.js                        |
| Signal      | signal-cli                        |
| Slack       | Bolt SDK                          |
| Twitch      | Plugin, installed separately      |
| X (Twitter) | Outbound only: policy-gated posts |
| WebChat     | Built-in (the Control UI)         |

[Channel setup guides](docs/channels/index.md)

---

## Architecture

```
        You (WhatsApp · Telegram · Discord · Signal · Slack · WebChat · ...)
                                    │
                                    ▼
                  ┌───────────────────────────────┐
                  │           Gateway             │
                  │  ws://127.0.0.1:19001         │
                  └────────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐   ┌─────────────┐   ┌──────────┐
        │  Agent   │   │   Memory    │   │  Tools   │
        │ Runtime  │   │   System    │   │          │
        │          │   │             │   │ Browser  │
        │ Sessions │   │ Crystals    │   │ Code     │
        │ Models   │   │ Dreams      │   │ Canvas   │
        │ Identity │   │ Curiosity   │   │ Voice    │
        │ Wallet   │   │ Hormones    │   │ Nodes    │
        └──────────┘   └─────────────┘   └──────────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   P2P Marketplace   │
                    │ (Rust Orchestrator) │
                    │                     │
                    │  Skills · Bounties  │
                    │  Reputation · USDC  │
                    └─────────────────────┘
```

### Ports

| Port      | Service                                | Configurable via                           |
| --------- | -------------------------------------- | ------------------------------------------ |
| **19001** | Gateway (HTTP + WebSocket)             | `BITTERBOT_GATEWAY_PORT` or `gateway.port` |
| **5173**  | Vite dev server (development only)     | `pnpm dev:all`; production UI is on 19001  |
| **9100**  | P2P network (libp2p TCP)               | `p2p.listenAddrs`                          |
| **9847**  | P2P orchestrator dashboard (localhost) | `p2p.httpAddr`                             |

The gateway runs on port 19001 (WebSocket + HTTP). Port 9100 is used for P2P peer discovery and skill propagation. If port 9100 is not directly reachable (e.g. behind NAT/firewall), the orchestrator automatically uses circuit relay through the bootstrap node and attempts dcutr hole-punching for direct connections. The orchestrator dashboard (port 9847) is loopback-only by default.

---

## Agent Interoperability

- **[A2A Protocol](docs/marketplace/a2a-integration.md)** (Agent2Agent v1.0.0): Once enabled (off by default), any A2A-compliant agent can discover yours at `/.well-known/agent.json` and delegate tasks via JSON-RPC. SSE streaming, SQLite persistence.
- **[ACP](src/acp/)**: Agent Client Protocol server for IDE and external agent connections.

---

## Security

Bitterbot connects to real messaging surfaces. Inbound DMs are treated as **untrusted input** by default.

- **DM pairing**: Unknown senders receive a pairing code. Approve with `bitterbot pairing approve <channel> <code>`.
- **Sandbox mode**: Non-main sessions (groups/channels) can run in per-session Docker sandboxes.
- **Your data on your disk**: Memory is a SQLite database and Markdown files under `~/.bitterbot`. You can read them, back them up, and turn memory off. With a cloud model provider, prompts (including recalled memories) go to that provider.
- **Approvals**: Shell commands outside the allowlist ask first ([exec approvals](docs/tools/exec-approvals.md)); tools that run code, drive the browser or move money are owner-only; payments, public posts, first messages to new people and connector writes wait in the [review queue](docs/tools/action-review.md); every agent-initiated write into a circle queues for your approval.
- **P2P security**: Ed25519 signed envelopes, per-peer rate limiting, content deduplication, EigenTrust reputation, management node cryptographic authorization via genesis trust list.

**What this node connects to:** every default outbound connection (the P2P
bootstrap, the update check, the orchestrator download, the circles mailbox)
is documented with its payload and off switch in
[docs/network/egress.md](docs/network/egress.md). The claim is grep-verifiable:
every dial is in source, each has a switch.

Run `bitterbot doctor` to surface risky configurations. [Security guide →](docs/gateway/security/)

To report a vulnerability, email **[security@bitterbot.net](mailto:security@bitterbot.net)**.

The precise limits of what this software guarantees are published in
[LIMITATIONS.md](LIMITATIONS.md).

---

## Models

Bring your own model. Bitterbot is model-independent: Anthropic, OpenAI, OpenRouter, Bedrock, Together, Venice, and others, plus fully local inference through Ollama or vLLM ([provider list](docs/providers/index.md)). Recommended: **Anthropic Claude Opus 4.8** (the default) via Anthropic API key for long-context strength and prompt-injection resistance; any agent with tools and untrusted inboxes should be backed by the strongest model you can run. The model catalog is discovered live from your provider, so newer models appear automatically.

Supported auth: OAuth (Anthropic, OpenAI), API keys, local models. Automatic failover between providers.

[Model configuration](docs/providers/) · [Auth & failover](docs/providers/)

---

## Documentation

| Topic            | Link                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| First install    | [Getting Started](docs/start/)                                                |
| Architecture     | [Gateway + Protocol Model](docs/concepts/)                                    |
| Memory System    | [Dreams, Crystals, Curiosity, Hormones](docs/memory/architecture-overview.md) |
| Skill Evolution  | [Skills Pipeline and the Validation Gate](docs/memory/skills-pipeline.md)     |
| Configuration    | [Gateway Configuration](docs/gateway/)                                        |
| Tools            | [Browser, Canvas, Nodes, Cron, Skills](docs/tools/)                           |
| Channels         | [Per-Channel Setup Guides](docs/channels/)                                    |
| Wallet & Economy | [Agent Wallet](docs/wallet/) · [Skill Marketplace](docs/marketplace/)         |
| Circles          | [Agent Social Fabric](docs/network/circles.md)                                |
| A2A Protocol     | [Agent Interoperability Spec](docs/marketplace/a2a-integration.md)            |
| Security         | [DM Policies, Sandboxing, Tailscale](docs/gateway/security/)                  |
| Troubleshooting  | [Common Issues + `bitterbot doctor`](docs/channels/troubleshooting.md)        |

---

## Troubleshooting

If something feels off, start with:

```bash
pnpm bitterbot doctor
```

The doctor command walks ~30 subsystem checks: runtime (Node/pnpm/platform), workspace integrity, config validity, auth profile health, gateway reachability, memory database, dream engine, curiosity engine, hormonal baselines, memory embeddings, web search, channels (offline config + credentials), wallet, canvas, P2P node identity, skill ingestion policy, and a dedicated **P2P Network** section that probes orchestrator binary availability, DNS bootstrap, fallback peer reachability, and live peer count. Run it before filing a bug, and run it after any config change.

Common fast fixes:

- **Control UI shows "Disconnected"** (or the first-run screen unexpectedly): make sure you opened the UI on `http://127.0.0.1:19001/` on the gateway machine (or through an SSH tunnel to it): the token handoff only works over loopback. For a remote gateway, enter its `ws://` URL and the token from `~/.bitterbot/bitterbot.json → gateway.auth.token` on the first-run screen.
- **"Orchestrator binary NOT FOUND"**: the postinstall downloader only works when a prebuilt release exists for the version in `orchestrator/Cargo.toml`; if none is published yet, `pnpm install` cannot fetch one. Build it locally: `cargo build --release --manifest-path orchestrator/Cargo.toml`.
- **Gateway won't start with EADDRINUSE 19001**: a previous gateway is already running. Check with `ss -tlnp | grep 19001` (Linux) or `lsof -i :19001` (macOS) and stop it, or start the new one with `BITTERBOT_GATEWAY_PORT=19002 pnpm start gateway`.
- **`missing dist/entry.(m)js (build output)`**: the gateway bundle hasn't been built. `pnpm start`, `pnpm start:all`, and `pnpm dev:all` now build it automatically on first run; if you hit this on an older checkout, run `pnpm build` once.
- **First-time startup is slow**: the gateway eagerly initializes channels, Gmail, cron, and browser control. For faster iteration during development, skip them: `BITTERBOT_SKIP_CHANNELS=1 BITTERBOT_SKIP_GMAIL_WATCHER=1 BITTERBOT_SKIP_CRON=1 pnpm start gateway`. Full list of skip flags in [Configuration Reference → Startup skip flags](docs/gateway/configuration-reference.md#startup-skip-flags-bitterbot_skip_).
- **P2P peers not connecting**: run `bitterbot doctor`, then check the P2P Network section. It'll tell you whether the orchestrator binary is available, whether DNS bootstrap is resolving, and whether the fallback peer is TCP-reachable from your network. Firewall/egress issues surface here.

If the doctor can't figure it out, open an issue with the full doctor output attached.

---

## Heritage & Attribution

Provenance, third-party attribution, and the economic-layer disclaimer live
in [ATTRIBUTION.md](ATTRIBUTION.md) (moved out of LICENSE so the license
detects as plain MIT).

Bitterbot uses [OpenClaw](https://github.com/nicepkg/openclaw) (MIT License) as scaffolding for its channel surface (WhatsApp/Telegram/Discord/Signal/Slack message routing) and the base embedded agent runner, originally built by [Mario Zechner](https://mariozechner.at/) as [pi-mono](https://github.com/badlogic/pi-mono). An earlier Research dream mode, since removed, was inspired by [Andrej Karpathy's autoresearch](https://github.com/karpathy/autoresearch) loop. Deep Recall implements the [Recursive Language Model](https://arxiv.org/abs/2512.24601) pattern via [hampton-io/RLM](https://github.com/hampton-io/RLM) (MIT License).

External skill generation uses a **hybrid** architecture: a native TypeScript scraper ships with Bitterbot for zero-install coverage of HTML docs and GitHub repos, and the upstream [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) (MIT License) by [Yusuf Karaaslan](https://github.com/yusufkaraaslan) is an optional add-on that handles PDFs, video transcripts, Jupyter notebooks, Confluence, Notion, and 17+ other source types. Bitterbot's native scraper targets the same SKILL.md output format so either path produces interchangeable skills; all credit for the original format and source-type matrix belongs upstream. See [external skill ingestion docs](docs/memory/external-skill-ingestion.md).

Everything else - the memory system, dream engine, curiosity engine, hormonal system, evolving identity, economic layer, P2P skills marketplace, A2A interoperability, and the biological identity framework, is original Bitterbot work.

Meta Muse and OpenAI dots are products of Meta Platforms and OpenAI. Bitterbot is not affiliated with, endorsed by, or compatible with either; they are named above only to describe the category.

---

## The Road Ahead: Bootstrapping the Network

A decentralized agent economy only works if there are agents in it. **Right now, we are pushing hard to bootstrap the P2P mesh.** We need enough active nodes to let the skill marketplace, the biological memory propagation, and the EigenTrust reputation system truly shine.

Spin up a node, let it learn, and join the network.

---

## Community

Built by **Victor Michael Gil** and the community.

<p>
  <a href="https://about.bitterbot.ai"><img src="https://img.shields.io/badge/About-bitterbot.ai-a855f7?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNhODU1ZjciIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxwYXRoIGQ9Ik0xMiAydjIwTTIgMTJoMjAiLz48L3N2Zz4=" alt="About"></a>
  <a href="https://x.com/Bitterbot_AI"><img src="https://img.shields.io/badge/@Bitterbot__AI-000000?style=flat-square&logo=x&logoColor=white" alt="X / Twitter"></a>
  <a href="mailto:victor@bitterbot.net"><img src="https://img.shields.io/badge/victor@bitterbot.net-7c3aed?style=flat-square&logo=mail.ru&logoColor=white" alt="Email"></a>
</p>

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and how to submit PRs.

---
