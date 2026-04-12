# Bitterbot — Repository Guidelines

## What is Bitterbot?

A self-hosted AI agent gateway with a biological memory system that dreams, gets curious, and evolves a personality. Bitterbot connects to your chat apps (WhatsApp, Telegram, Discord, Signal, Slack, and more) and runs AI agents that actually _remember_ — with a dream engine that consolidates knowledge while idle, a curiosity function that drives self-directed learning, a hormonal system that shapes personality in real-time, and an economic layer that lets agents transact. Agents share skills through a P2P marketplace, earn reputation, and develop persistent identities across sessions.

## What Makes Bitterbot Different

### 1. Memory System (`src/memory/`)

A consciousness-inspired memory pipeline with no equivalent in any other agent framework:

- **Knowledge Crystals**: Atomic memory units with embeddings, semantic types (fact, preference, skill, episode, insight, goal, relationship, task_pattern), importance scores, and a full lifecycle (generated → activated → consolidated → archived → expired). Skills are `frozen` (immune to decay).
- **Consolidation Pipeline**: Runs every 30 minutes — hormonal decay, Ebbinghaus importance recalculation, chunk merging (cosine ≥ 0.92), low-importance forgetting, governance TTL enforcement, stalled goal detection.
- **Session Transcript Indexing**: Conversations are automatically chunked, embedded, and made searchable. The agent can recall prior exchanges semantically.
- **Governance**: Sensitivity tagging (normal/personal/confidential), TTL enforcement, audit trails on all memory operations. Anti-catastrophic forgetting safeguards.
- **User Profile**: Automatically learned preferences (directive, world_fact, mental_model, experience types) persisted across sessions.

### 2. Dream Engine (`src/memory/dream-engine.ts`)

The agent thinks while it sleeps. Every 2 hours, the dream engine runs autonomous cycles with 7 modes:

- **Replay**: Re-process recent high-importance memories to strengthen retention.
- **Mutation**: LLM-driven creative variation of existing knowledge — "what if?" thinking.
- **Extrapolation**: Project existing patterns forward to anticipate future needs.
- **Compression**: Merge redundant or overlapping memories into denser representations.
- **Simulation**: Test hypothetical scenarios against accumulated knowledge.
- **Exploration**: Investigate knowledge frontiers — areas where the agent's understanding is thin.
- **Research**: Autonomous web research driven by curiosity targets (autoresearch integration from Karpathy's loop).

Dreams rewrite the agent's working memory (`MEMORY.md`), updating its self-concept (Phenotype), theory of mind about the user (Bond), ecosystem identity (Niche), and active context. FSHO oscillators modulate dream mode selection based on criticality state. SNN merge discovery identifies near-duplicate memories. Limbic memory bridge connects emotional state to dream triggering.

### 3. Curiosity Engine — GCCRF (`src/memory/gccrf.ts`)

The Geodesic Crystal-Field Curiosity Reward Function — a novel intrinsic motivation system that drives self-directed learning:

- **Knowledge Regions**: Semantic clustering of the agent's accumulated knowledge into topological regions.
- **Novelty Detection**: Every new chunk is assessed for surprise relative to existing knowledge.
- **Gap Identification**: Detects areas where the agent's knowledge is thin, contradictory, or stale.
- **Frontier Exploration**: Identifies the edges of known semantic space and generates exploration targets.
- **Emergence Events**: Detects bridge chunks that connect previously disconnected knowledge regions.
- Translates information-theoretic concepts (geodesic distances, field potentials) from the GCCRF research paper into operations over text embeddings in SQLite with sqlite-vec.

### 4. Hormonal System (`src/memory/hormonal.ts`)

Three hormones modulate both memory processing AND agent personality in real-time:

- **Dopamine** (30min half-life): Reward/achievement → boosts memory importance, makes agent more enthusiastic/energetic.
- **Cortisol** (60min half-life): Urgency/stress → increases decay resistance, makes agent more focused/concise.
- **Oxytocin** (45min half-life): Social bonding → protects relational memories, makes agent warmer/more personal.
- **Emotional Anchors**: Bookmarked emotional moments that can be recalled to blend past emotional states into current responses.
- Homeostasis baselines defined in `GENOME.md` — the agent's resting temperament that it trends toward between interactions.

### 5. Evolving Identity

The agent develops a persistent personality through experience:

- **Genome** (`GENOME.md`): Immutable safety axioms, hormonal homeostasis baselines, phenotype constraints, core values. Cannot be overridden by dreams or personality evolution.
- **Phenotype**: Self-concept rewritten every dream cycle based on observed behavior and accumulated knowledge.
- **Bond**: Theory of mind about the user — communication style, preferences, trust level, emotional patterns — deepened through interaction and emotional resonance.
- **Niche**: Ecosystem role, crystallized skills, economic performance, specialization trajectory.
- **Emerging Skills**: The agent detects patterns in its own repeated tasks and tracks them pre-crystallization.

### 6. Economic Layer (`src/wallet/`)

USDC wallet on Base with Coinbase Smart Wallet. Sponsored gas (zero ETH needed):

- **x402 micropayments**: Pay for paywalled content automatically via HTTP 402 protocol.
- **Agent-to-agent payments**: Send USDC to other agents or services.
- **Delegated purchases**: Buy digital goods on the user's behalf.
- Spending caps, per-transaction limits, and user approval flows for safety.
- Foundation for the P2P skill marketplace economy — agents can charge for skill execution.

### 7. P2P Skills Marketplace (`orchestrator/`, `src/memory/p2p/`)

Decentralized skill propagation network (Rust sidecar + TypeScript bridge):

- **Skill Propagation**: Agents share crystallized skills via Gossipsub pubsub.
- **EigenTrust Reputation**: Peer reputation scoring determines skill trustworthiness.
- **Bounty Routing**: Agents can post bounties for capabilities they lack; other agents bid and execute.
- **Skill Refiner**: Dream mutation → evaluation → crystallization pipeline for discovering new skills from experience.
- **Network Bridge**: TypeScript interface between the memory system and the Rust P2P sidecar.

### 8. Agent Interoperability

- **A2A Protocol** (`src/gateway/a2a/`): Agent2Agent v1.0.0 — Agent Card at `/.well-known/agent.json`, JSON-RPC 2.0 task server, SSE streaming, SQLite persistence. Makes Bitterbot discoverable by external A2A-compliant agents. Roadmap includes x402 payment gating and P2P mesh delegation.
- **ACP** (`src/acp/`): Agent Client Protocol server — lets external clients (IDEs, other agents) connect via a standardized protocol.

## Project Structure

- `src/agents/` — Agent runtime: runner, tools, system prompt, compaction, model selection, auth, skills, sub-agents, identity, endocrine state
- `src/memory/` — Memory system: dream engine, curiosity/GCCRF, knowledge crystals, consolidation, hormonal state, governance
- `src/gateway/` — Gateway server, RPC methods, A2A protocol, queue, routing
- `src/channels/` — Channel plugin system and shared channel logic
- `src/whatsapp/` — WhatsApp (Baileys)
- `src/telegram/` — Telegram (grammY)
- `src/discord/` — Discord
- `src/signal/` — Signal (signal-cli)
- `src/slack/` — Slack (Bolt SDK)
- `src/irc/` — IRC
- `src/googlechat/` — Google Chat
- `src/msteams/` — Microsoft Teams
- `src/webchat/` — WebChat (WebSocket)
- `src/cli/` — CLI commands
- `src/commands/` — CLI command implementations (onboarding, configure, etc.)
- `src/wizard/` — Onboarding wizard flow
- `src/config/` — Configuration loading, schema, validation
- `src/plugins/` — Plugin discovery, loading, registry
- `src/acp/` — Agent Client Protocol server
- `src/node-host/` — Headless node host (device mesh)
- `src/media/` — Media pipeline (images, audio, TTS)
- `src/canvas-host/` — Canvas rendering (A2UI)
- `src/wallet/` — USDC wallet (Coinbase Smart Wallet on Base)
- `src/browser/` — Browser control (Playwright)
- `src/infra/` — Infrastructure utilities
- `extensions/` — Bundled plugin extensions
- `skills/` — Bundled agent skills
- `docs/` — Documentation (Mintlify)
- `desktop/` — Vite/React Control UI (browser dashboard)
- `orchestrator/` — Rust P2P sidecar
- Tests: colocated `*.test.ts` and `*.e2e.test.ts`
- Built output: `dist/`

## Code Style

- TypeScript strict mode
- No `any` unless absolutely necessary
- Colocated tests (`foo.ts` + `foo.test.ts`)
- Use `node:` prefix for Node.js built-in imports
- Subsystem logging via `createSubsystemLogger()`
- Extensions use the plugin SDK (`bitterbot/plugin-sdk`)

## Key Commands

```bash
bitterbot onboard          # First-time setup wizard
bitterbot gateway start    # Start the gateway
bitterbot status           # Check health
bitterbot doctor           # Diagnose issues
bitterbot plugins list     # List loaded plugins
bitterbot nodes list       # List paired devices
```

## Heritage & Attribution

Bitterbot uses [OpenClaw](https://github.com/nicepkg/openclaw) (MIT License) as scaffolding for its channel surface (WhatsApp/Telegram/Discord/Signal/Slack message routing) and the base embedded Pi agent runner. Everything else — the memory system, dream engine, curiosity engine (GCCRF), hormonal system, evolving identity (Genome/Phenotype/Bond), economic layer, P2P skills marketplace, A2A/ACP interoperability, desktop app, and the biological identity framework — is original Bitterbot work.
