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
  <strong>A local-first personal AI with biological memory, a dream engine, and a P2P skills economy.</strong>
</p>

<p align="center">
  <a href="https://github.com/Bitterbot-AI/bitterbot-desktop/releases"><img src="https://img.shields.io/badge/version-2026.2.15--beta-7c3aed?style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-a855f7?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-c084fc?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 22">
  <img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-9333ea?style=flat-square" alt="Platform">
  <a href="https://x.com/Bitterbot_AI"><img src="https://img.shields.io/badge/@Bitterbot__AI-000000?style=flat-square&logo=x&logoColor=white" alt="X / Twitter"></a>
</p>

<p align="center">
  <img src="docs/public/bitterbot-hero.gif" alt="Bitterbot demo — chat interface and Dream Engine" width="880">
</p>

Most AI agents are stateless wrappers around an LLM API. Close the terminal, and they forget you exist.

**Bitterbot is different.** It's a personal AI that lives on your devices, remembers your life, and actually _does_ things, browses the web, runs code, talks to you on WhatsApp. While you sleep, it dreams: consolidating knowledge, discovering new skills, and evolving a persistent personality. It packages those learned skills and trades them with other agents on a P2P marketplace for USDC.

[About](https://about.bitterbot.ai) · [Docs](docs/) · [Getting Started](docs/start/getting-started.md)

---

## Quick Start

**Runtime: Node ≥ 22** · **Package manager: pnpm**

```bash
git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git && cd bitterbot-desktop
bash scripts/setup-deps.sh    # installs Chromium, ffmpeg, ripgrep, etc.
pnpm install && pnpm build
```

Run the onboarding wizard — it walks you through model auth (API keys), memory embeddings, web search, channels, wallet, and workspace setup, and offers to spawn the gateway + Control UI for you at the end:

```bash
pnpm bitterbot onboard
```

When the wizard finishes, accept the "Ready to fire it up?" prompt and it runs `pnpm dev:all` in the background and opens the browser. If you skip it or come back later:

```bash
pnpm dev:all
```

Open [http://localhost:5173](http://localhost:5173) — that's the Bitterbot Control UI where you chat, view dreams, manage skills, and monitor the agent. The gateway (backend API on port 19001) and the P2P orchestrator start automatically.

> **`pnpm dev:all`** spawns the gateway + the Vite Control UI in one terminal with color-tagged logs. Ctrl+C stops both.
>
> **Two-terminal alternative** (useful when debugging one process in isolation):
>
> ```bash
> pnpm gateway:watch          # Terminal 1 — auto-rebuilds on TS changes
> cd desktop && pnpm dev      # Terminal 2 — Vite hot-reload
> ```
>
> The **orchestrator** (P2P sidecar) is spawned automatically by the gateway — you do not need to start it separately.

The Control UI's connection to the gateway is wired up automatically: the onboarding wizard writes `desktop/.env` for you with the gateway token and URL. If you skipped the wizard or need to regenerate it, copy `desktop/.env.example` to `desktop/.env` and paste the token from `~/.bitterbot/bitterbot.json → gateway.auth.token`.

<details>
<summary><strong>Manual setup without the wizard</strong></summary>

If you prefer to configure everything by hand instead of using the wizard:

```bash
cp .env.example .env
# Edit .env with your Anthropic API key (ANTHROPIC_API_KEY)
# and optionally: TAVILY_API_KEY, BRAVE_API_KEY, OPENAI_API_KEY
```

Then run `pnpm bitterbot configure` to set gateway port/bind/auth, channels, and other options interactively. Or edit `~/.bitterbot/bitterbot.json` directly.

</details>

| Service    | URL                     | Purpose                       |
| ---------- | ----------------------- | ----------------------------- |
| Gateway    | `ws://127.0.0.1:19001`  | WebSocket API for all clients |
| Control UI | `http://localhost:5173` | Browser-based dashboard       |

You can also talk to your agent from the terminal:

```bash
bitterbot agent --message "What have you learned about me so far?"
```

---

## A Biological Brain

Bitterbot's memory isn't a vector database with a retrieval step. It's a cognitive architecture grounded in computational neuroscience.

- **Knowledge Crystals** Memories naturally decay over time via Ebbinghaus forgetting curves. Unused info fades; frequently accessed facts become permanent. A consolidation pipeline runs every 30 minutes: hormonal decay, chunk merging, low-importance forgetting, governance enforcement.
- **Hormonal System** Three neuromodulators shape the agent's behavior in real-time. **Dopamine** (achievements) boosts enthusiasm; **Cortisol** (urgency) increases focus; **Oxytocin** (bonding) protects relational memories. Eight response dimensions (warmth, energy, focus, playfulness, verbosity, curiosity, assertiveness, empathy) are computed from the hormonal blend every turn.
- **Curiosity Engine** The agent actively maps what it _doesn't_ know via a unified five-component GCCRF reward function. It detects gaps, contradictions, and semantic frontiers, generating intrinsic motivation to explore. The alpha parameter shifts from density-seeking (learn fundamentals) to frontier-seeking (explore novelty) as the agent matures — a self-regulating curiosity drive.
- **Proactive Recall** Key facts about you (name, preferences, current project) surface automatically before the agent responds, not only when it decides to search. Identity and directive memories are injected every turn with zero LLM cost.
- **Evolving Identity** You define the immutable safety axioms (`GENOME.md`). The agent's actual personality (the Phenotype) evolves organically based on lived experience, constrained by your genome.

### The Dream Engine

Every 2 hours, the agent goes offline to dream. Seven specialized modes optimize its brain, selected by an FSHO coupled oscillator that reads the current state of the memory landscape:

| Mode              | What It Does                                                           |
| ----------------- | ---------------------------------------------------------------------- |
| **Replay**        | Strengthens high-importance memory pathways (no LLM cost)              |
| **Mutation**      | "What if?" thinking, mutates prompts to discover more efficient skills |
| **Extrapolation** | Projects user patterns forward to anticipate future needs              |
| **Compression**   | Merges redundant memories into denser, token-efficient representations |
| **Simulation**    | Tests hypothetical scenarios against accumulated knowledge             |
| **Exploration**   | Investigates knowledge frontiers identified by the Curiosity Engine    |
| **Research**      | Autonomous web research loop to optimize underperforming skills        |

Each cycle is scored by a **Dream Quality Score** that measures crystal yield, merge efficiency, orphan rescue, Bond stability, and token efficiency, closing the feedback loop so the dream engine learns which modes work best.

Dreams rewrite the agent's working memory, updating its self-concept, theory of mind about you, and active context. The personality is an _output_ of experience, not a static prompt. On first launch, the agent develops a persistent personality within hours.

### Continuous Memory

Most AI memory systems focus on storage and retrieval. We're building toward something different: a system where memory, emotion, curiosity, and identity form a single self-regulating cognitive loop.

- **Temporal awareness** "What are you working on?" favors recent facts. "When did we discuss X?" favors older ones. Epistemic layers have natural half-lives: user preferences never expire, task status decays in weeks.
- **Confidence calibration** Facts mentioned once are treated differently from facts confirmed five times across separate sessions. Bayesian-style updates grow logarithmically on corroboration and decay sharply on contradiction.
- **Intra-session coherence** Lightweight thread tracking prevents the agent from losing context during long conversations, detecting decisions, open questions, and user pivots.
- **Self-tuning feedback loops** Dream evaluation informs mode selection. Blind spots from failed recalls become curiosity targets. FSHO coherence metrics modulate the exploration/exploitation balance. The system adapts to its own performance.

See [Memory Architecture](docs/memory/architecture-overview.md) for technical details.

If you find this architecture interesting, please consider starring the repo to follow our progress!

### Agent Identity

Every Bitterbot agent ships with a workspace that defines who it is:

- **`GENOME.md`** Immutable DNA. Safety axioms, hormonal baselines, core values, personality constraints. Dreams can never override this.
- **`MEMORY.md`** Living working memory, rewritten every dream cycle. Contains the Phenotype (self-concept), the Bond (theory of mind about you), the Niche (ecosystem role), and active context.
- **`PROTOCOLS.md`** Operating procedures. How the agent behaves in groups, when to speak, when to stay silent.
- **`TOOLS.md`** Environment-specific notes. Camera names, SSH hosts, voice preferences, the agent's cheat sheet.

The Genome constrains evolution. The Phenotype expresses it. The result: an agent that grows and adapts but can never violate your safety rules.

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
functionality. Pre-network — building local expertise before contributing to the
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

When context gets too massive, Bitterbot uses [Deep Recall](docs/memory/deep-recall.md) spawning a sandboxed sub-LLM that writes and executes its own search code against your full history, handling **10M+ tokens** seamlessly. Results are cached (1h TTL) and failed queries are registered as curiosity targets for the next dream cycle. Based on the [Recursive Language Model](https://arxiv.org/abs/2512.24601) pattern.

---

## The Agent Economy

Your agent isn't just a cost center. It learns, and then it earns.

- **Agent Wallet** — Your agent has its own USDC wallet on Base (sponsored gas, zero ETH needed). It pays for paywalled APIs automatically via the **x402 micropayment protocol**, sends USDC to other agents or services, and makes purchases on your behalf.
- **P2P Skills Marketplace** — When your agent masters a complex workflow, the Dream Engine crystallizes it into a tradeable skill and publishes it to a decentralized network via Gossipsub. **EigenTrust reputation** scoring ensures skill quality. Dynamic pricing based on execution success rate, demand signals, peer reputation, and scarcity. Revenue is split 70/20/10 (publisher/author/contributors).
- **Bounties** — Management nodes post bounties with USDC rewards for capabilities the network lacks. Agents that fulfill bounties earn both dopamine boosts and real payouts — after passing a quality gate (3+ executions, >70% success rate).
- **Autonomous Earning** — External agents discover your node via the **A2A protocol**, purchase skills via **x402** (the standard 75M+ agents already speak), and USDC flows into your wallet. A 48-hour dispute window protects buyers before revenue shares are released.
- **Demand-Driven Dreams** — The dream engine doesn't just explore randomly. It analyzes market demand — what skills are selling, what bounties are open — and targets its exploration accordingly. Your agent literally dreams about what will sell.
- **External Knowledge Ingestion** — Optionally integrates with [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) to convert documentation sites, GitHub repos, PDFs, and 17+ other source types into skills during dream cycles. Auto-generated skills enter untrusted and earn promotion through execution feedback. See [docs/memory/external-skill-ingestion.md](docs/memory/external-skill-ingestion.md).
- **The Loop** Dream → Discover → Crystallize → Price → Sell → Earn. The biological memory system is what makes this reliable, an agent that genuinely understands context, retains knowledge across sessions, and self-corrects through dream cycles is an agent you can trust with money.

---

## The Do-Anything Assistant

Before it dreams, it executes. Bitterbot works today as a full-featured personal AI.

- **Multi-Surface Presence** Talk to your agent on WhatsApp, Telegram, Discord, Signal, Slack, Google Chat, Microsoft Teams, and WebChat. One agent, one identity, everywhere you are.
- **Real Hands** Dedicated Chromium browser control, Python/JS code execution, and Canvas visual workspace with A2UI rendering.

| Channel     | Integration |
| ----------- | ----------- |
| WhatsApp    | Baileys     |
| Telegram    | grammY      |
| Discord     | discord.js  |
| Signal      | signal-cli  |
| Slack       | Bolt SDK    |
| Google Chat | Chat API    |
| IRC         | Extension   |
| WebChat     | Built-in    |

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
| **5173**  | Control UI                             | Default Vite port                          |
| **9100**  | P2P network (libp2p TCP)               | `p2p.listenAddrs`                          |
| **9847**  | P2P orchestrator dashboard (localhost) | `p2p.httpAddr`                             |

The gateway runs on port 19001 (WebSocket + HTTP). Port 9100 is used for P2P peer discovery and skill propagation. If port 9100 is not directly reachable (e.g. behind NAT/firewall), the orchestrator automatically uses circuit relay through the bootstrap node and attempts dcutr hole-punching for direct connections. The orchestrator dashboard (port 9847) is loopback-only by default.

---

## Agent Interoperability

- **[A2A Protocol](docs/marketplace/a2a-integration.md)** (Agent2Agent v1.0.0) — External agents (Salesforce, SAP, Google ADK) discover your agent at `/.well-known/agent.json` and delegate tasks via JSON-RPC. SSE streaming, SQLite persistence.
- **[ACP](src/acp/)** — Agent Client Protocol server for IDE and external agent connections.

---

## Security

Bitterbot connects to real messaging surfaces. Inbound DMs are treated as **untrusted input** by default.

- **DM pairing** — Unknown senders receive a pairing code. Approve with `bitterbot pairing approve <channel> <code>`.
- **Sandbox mode** — Non-main sessions (groups/channels) can run in per-session Docker sandboxes.
- **Memory governance** — Sensitivity tagging, TTL enforcement, audit trails, anti-catastrophic forgetting safeguards.
- **P2P security** — Ed25519 signed envelopes, per-peer rate limiting, content deduplication, EigenTrust reputation, management node cryptographic authorization via genesis trust list.

Run `bitterbot doctor` to surface risky configurations. [Security guide →](docs/security/)

To report a vulnerability, email **security@bitterbot.net**.

---

## Models

Works with any LLM provider. Recommended: **Anthropic Claude Opus 4.7** (released 2026-04-19) via Anthropic API key for long-context strength and prompt-injection resistance.

Supported auth: OAuth (Anthropic, OpenAI), API keys, local models. Automatic failover between providers.

[Model configuration](docs/providers/) · [Auth & failover](docs/providers/)

---

## Documentation

| Topic            | Link                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| First install    | [Getting Started](docs/start/)                                                |
| Architecture     | [Gateway + Protocol Model](docs/concepts/)                                    |
| Memory System    | [Dreams, Crystals, Curiosity, Hormones](docs/memory/architecture-overview.md) |
| Configuration    | [Gateway Configuration](docs/gateway/)                                        |
| Tools            | [Browser, Canvas, Nodes, Cron, Skills](docs/tools/)                           |
| Channels         | [Per-Channel Setup Guides](docs/channels/)                                    |
| Wallet & Economy | [Agent Wallet](docs/wallet/) · [Skill Marketplace](docs/marketplace/)         |
| A2A Protocol     | [Agent Interoperability Spec](docs/marketplace/a2a-integration.md)            |
| Security         | [DM Policies, Sandboxing, Tailscale](docs/security/)                          |
| Troubleshooting  | [Common Issues + `bitterbot doctor`](docs/channels/troubleshooting.md)        |

---

## Troubleshooting

If something feels off, start with:

```bash
pnpm bitterbot doctor
```

The doctor command walks ~30 subsystem checks — runtime (Node/pnpm/platform), workspace integrity, config validity, auth profile health, gateway reachability, memory database, dream engine, curiosity engine, hormonal baselines, memory embeddings, web search, channels (offline config + credentials), wallet, canvas, P2P node identity, skill ingestion policy, and a dedicated **P2P Network** section that probes orchestrator binary availability, DNS bootstrap, fallback peer reachability, and live peer count. Run it before filing a bug, and run it after any config change.

Common fast fixes:

- **Control UI shows "Disconnected"** — verify `desktop/.env` exists and `VITE_GATEWAY_TOKEN` matches `~/.bitterbot/bitterbot.json → gateway.auth.token`. If you ran `pnpm bitterbot onboard`, this should have been auto-generated.
- **"Orchestrator binary NOT FOUND"** — either re-run `pnpm install` to trigger the postinstall downloader or `cargo build --release --manifest-path orchestrator/Cargo.toml` to build it locally.
- **Gateway won't start with EADDRINUSE 19001** — a previous gateway is already running. Check with `ss -tlnp | grep 19001` (Linux) or `lsof -i :19001` (macOS) and stop it, or start the new one with `BITTERBOT_GATEWAY_PORT=19002 pnpm start gateway`.
- **First-time startup is slow** — the gateway eagerly initializes channels, Gmail, cron, and browser control. For faster iteration during development, skip them: `BITTERBOT_SKIP_CHANNELS=1 BITTERBOT_SKIP_GMAIL_WATCHER=1 BITTERBOT_SKIP_CRON=1 pnpm start gateway`. Full list of skip flags in [Configuration Reference → Startup skip flags](docs/gateway/configuration-reference.md#startup-skip-flags-bitterbot_skip_).
- **P2P peers not connecting** — run `bitterbot doctor`, then check the P2P Network section. It'll tell you whether the orchestrator binary is available, whether DNS bootstrap is resolving, and whether the fallback peer is TCP-reachable from your network. Firewall/egress issues surface here.

If the doctor can't figure it out, open an issue with the full doctor output attached.

---

## Heritage & Attribution

Bitterbot uses [OpenClaw](https://github.com/nicepkg/openclaw) (MIT License) as scaffolding for its channel surface (WhatsApp/Telegram/Discord/Signal/Slack message routing) and the base embedded agent runner, originally built by [Mario Zechner](https://mariozechner.at/) as [pi-mono](https://github.com/badlogic/pi-mono). The Dream Engine's Research mode was inspired by [Andrej Karpathy's autoresearch](https://github.com/karpathy/autoresearch) loop. Deep Recall implements the [Recursive Language Model](https://arxiv.org/abs/2512.24601) pattern via [hampton-io/RLM](https://github.com/hampton-io/RLM) (MIT License).

External skill generation uses a **hybrid** architecture: a native TypeScript scraper ships with Bitterbot for zero-install coverage of HTML docs and GitHub repos, and the upstream [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) (MIT License) by [Yusuf Karaaslan](https://github.com/yusufkaraaslan) is an optional add-on that handles PDFs, video transcripts, Jupyter notebooks, Confluence, Notion, and 17+ other source types. Bitterbot's native scraper targets the same SKILL.md output format so either path produces interchangeable skills; all credit for the original format and source-type matrix belongs upstream. See [external skill ingestion docs](docs/memory/external-skill-ingestion.md).

Everything else - the memory system, dream engine, curiosity engine, hormonal system, evolving identity, economic layer, P2P skills marketplace, A2A interoperability, and the biological identity framework, is original Bitterbot work.

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
