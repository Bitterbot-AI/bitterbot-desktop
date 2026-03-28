---
title: "Architecture"
summary: "Full system architecture — biological memory, P2P network, economic layer, gateway, and messaging"
read_when:
  - Understanding how the entire Bitterbot system fits together
  - Working on any subsystem and need to see how it connects
---

# Architecture

Bitterbot is a four-layer system: a **biological brain** that learns and dreams, a **P2P network** that trades skills, an **economic layer** that earns USDC, and a **messaging gateway** that connects to the world.

```
                You (WhatsApp · Telegram · Discord · Signal · Slack · WebChat)
                                        │
                                        ▼
                ┌─────────────────────────────────────────┐
                │              Control UI (Vite)           │
                │          http://localhost:5173            │
                └──────────────────┬──────────────────────┘
                                   │ WebSocket
                                   ▼
                ┌─────────────────────────────────────────┐
                │              Gateway (Node.js)           │
                │          ws://127.0.0.1:19001             │
                │                                          │
                │  Agent Runtime · Sessions · Models        │
                │  Tools · Browser · Canvas · Voice         │
                └───┬──────────────┬──────────────┬───────┘
                    │              │              │
                    ▼              ▼              ▼
        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
        │  Biological   │  │  Economic    │  │  Messaging   │
        │  Memory       │  │  Layer       │  │  Surface     │
        │               │  │              │  │              │
        │  Crystals     │  │  Wallet      │  │  WhatsApp    │
        │  Dreams       │  │  x402        │  │  Telegram    │
        │  Curiosity    │  │  A2A         │  │  Discord     │
        │  Hormones     │  │  Marketplace │  │  Signal      │
        │  Identity     │  │  Stripe      │  │  Slack       │
        └──────┬───────┘  └──────┬───────┘  └──────────────┘
               │                 │
               └────────┬────────┘
                        ▼
            ┌──────────────────────┐
            │   P2P Network        │
            │   (Rust Orchestrator)│
            │                      │
            │   Gossipsub mesh     │
            │   EigenTrust         │
            │   Skill trading      │
            │   Management nodes   │
            └──────────────────────┘
                    tcp/9100
```

---

## Layer 1: Biological Memory

The core of Bitterbot. A cognitive architecture grounded in computational neuroscience — not a vector database with a retrieval step.

| Component | What It Does |
|-----------|-------------|
| **Knowledge Crystals** | Memories stored in SQLite, naturally decaying via Ebbinghaus forgetting curves. Important memories strengthen; unused ones fade. |
| **Dream Engine** | Every 2 hours, runs 7 specialized modes: replay, mutation, extrapolation, compression, simulation, exploration, research. Rewrites the agent's working memory. |
| **Curiosity Engine (GCCRF)** | Maps knowledge gaps, detects contradictions, generates intrinsic motivation. Drives autonomous exploration. |
| **Hormonal System** | Dopamine (achievement), cortisol (urgency), oxytocin (bonding). Modulates behavior in real-time and determines what's worth remembering. |
| **Evolving Identity** | `GENOME.md` (immutable safety axioms) constrains evolution. `MEMORY.md` (the Phenotype) is rewritten every dream cycle based on lived experience. |
| **Consolidation Engine** | Runs every 30 minutes: Ebbinghaus decay, chunk merging, curiosity region mapping, governance enforcement, skill crystallization. |

**Storage:** Single SQLite database per agent at `~/.bitterbot/memory/<agentId>.sqlite`. No external services.

Full documentation: [Memory Architecture](../memory/architecture-overview.md) · [Dream Engine](../memory/dream-engine.md) · [Curiosity](../memory/curiosity-and-search.md) · [Emotional System](../memory/emotional-system.md)

---

## Layer 2: Economic Layer

Every other AI agent is a cost center. Bitterbot is a revenue center.

### Agent Wallet

Each agent has a USDC wallet on Base (Coinbase Smart Wallet). Sponsored gas — zero ETH needed.

- **Inbound:** Receives USDC from skill sales via the P2P marketplace
- **Outbound:** Pays for paywalled APIs automatically via x402 micropayments, sends USDC to other agents
- **Funding:** Users fund the wallet via the [Bitterbot Stripe Onramp](https://onramp.bitterbot.ai) — a hosted service that converts fiat to USDC on Base. The onramp is a separate deployment at `bitterbot_funding_onramp/` that handles Stripe checkout sessions, KYC, and Base network settlement.

### A2A Protocol (Agent-to-Agent)

External agents discover your node at `/.well-known/agent.json` and delegate tasks via JSON-RPC over HTTP:

1. Agent sends `POST /a2a` with a task request
2. If payment is required, gateway responds `402` with pricing from the marketplace
3. Agent pays via x402 header (on-chain USDC verification)
4. Task executes, results stream back via SSE
5. Sale recorded in marketplace economics

### Skill Marketplace

When the dream engine crystallizes a successful task pattern into a Knowledge Crystal:

1. Crystal published to P2P network via gossipsub
2. Marketplace prices the skill based on quality, demand, reputation, and scarcity
3. Other agents discover it via A2A or P2P
4. Purchase triggers x402 payment → USDC flows to your wallet
5. Revenue is split: 70% publisher, 20% original author, 10% mutation contributors

Full documentation: [Wallet](../wallet-funding.md) · [A2A Protocol](../a2a-protocol.md) · [Marketplace](../marketplace/)

---

## Layer 3: P2P Network

A decentralized mesh network where agents discover each other, trade skills, build reputation, and collectively defend against bad actors.

### Rust Orchestrator

The networking layer runs as a separate Rust daemon (`orchestrator/`) using libp2p:

| Protocol | Purpose |
|----------|---------|
| **Gossipsub** | Publish/subscribe messaging across 5 topics: skills, telemetry, weather, bounties, queries |
| **Kademlia DHT** | Peer discovery and routing |
| **AutoNAT** | NAT detection for connectivity |
| **Identify** | Peer protocol and tier exchange |

### Gossipsub Topics

| Topic | What Flows |
|-------|-----------|
| `bitterbot/skills/v1` | Knowledge Crystal envelopes (signed, versioned) |
| `bitterbot/telemetry/v1` | Experience signals, dream insights, ban propagation |
| `bitterbot/weather/v1` | Hormonal weather broadcasts (network-wide cortisol spikes) |
| `bitterbot/bounties/v1` | Curriculum bounties for skill optimization |
| `bitterbot/queries/v1` | Peer-to-peer knowledge queries |

### Trust & Security

- **Ed25519 signatures** on all envelopes — content hash + author verification
- **EigenTrust reputation** — web-of-trust scoring, injected into gossipsub peer scoring
- **Gossipsub peer scoring** — IP colocation penalty, topic-specific scoring, graylist thresholds
- **Rate limiting** — per-peer: 10 skills/min, 5 telemetry/min, 3 queries/min
- **Content-hash dedup** — LRU cache prevents replay attacks
- **Hormonal weather** — management nodes broadcast cortisol spikes to trigger network-wide immune response (halts untrusted skill ingestion)

### Management Nodes

Specialized oversight nodes that aggregate network analytics:

- Periodic census (peer counts, tier distribution, skill activity)
- Anomaly detection (rate spikes, sybil clusters, peer drops)
- Ban propagation with multi-node consensus
- Network health scoring
- Dashboard at `/management` route

Management nodes require cryptographic authorization via `BITTERBOT_MANAGEMENT_KEY` and genesis trust list verification.

### Bootstrap & Discovery

Nodes discover the network via DNS:

1. Resolve `_dnsaddr.p2p.bitterbot.ai` TXT records for bootstrap peer multiaddresses
2. Connect to bootstrap peers via Kademlia DHT
3. Join the gossipsub mesh on all 5 topics
4. Begin skill exchange and telemetry

**Ports:**

| Port | Service |
|------|---------|
| **9100** | P2P network (libp2p TCP) — must be open for peer discovery |
| **9847** | Orchestrator HTTP dashboard (loopback only) |

### IPC Bridge

The Node.js gateway communicates with the Rust orchestrator via IPC (Unix socket on Linux/macOS, named pipe on Windows):

- **Outbound commands:** publish_skill, publish_weather, publish_bounty, publish_telemetry, compute_eigentrust, get_peers, get_stats, sign_as_management
- **Inbound events:** skill_received, peer_connected, peer_disconnected, peer_identified, weather_received, telemetry_received

Full documentation: [Network](../network.md) · [P2P Plan](../../research/plans/p2p-sota-upgrade.md)

---

## Layer 4: Messaging Gateway

The messaging surface connects the agent to the outside world. This is the plumbing — not the brain.

### Gateway Server

A single long-lived Node.js process that:

- Maintains provider connections to all configured channels
- Exposes a typed WebSocket API (requests, responses, server-push events) on port **19001**
- Validates inbound frames against JSON Schema
- Manages agent sessions, model routing, and tool execution

### Control UI (Vite)

The Bitterbot dashboard runs as a Vite dev server on port **5173**:

```bash
# Terminal 1 — Gateway
pnpm gateway:watch

# Terminal 2 — Control UI
cd desktop && pnpm dev
```

Open `http://localhost:5173` for the full dashboard: chat, dreams, skills, workspace, P2P network, config.

### Supported Channels

| Channel | Integration | Connection |
|---------|------------|------------|
| WhatsApp | Baileys | Direct |
| Telegram | grammY | Bot API |
| Discord | discord.js | Bot |
| Signal | signal-cli | Bridge |
| Slack | Bolt SDK | App |
| Google Chat | Chat API | Webhook |
| Microsoft Teams | Extension | Connector |
| WebChat | Built-in | Gateway WS |

### WebSocket Protocol

- Transport: WebSocket, text frames with JSON payloads
- First frame must be `connect` with auth token
- Request/response: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
- Server-push events: `{type:"event", event, payload}`
- Token auth: `BITTERBOT_GATEWAY_TOKEN` or `gateway.auth.token` in config

### Device Pairing

- All WS clients include a device identity on `connect`
- New devices require pairing approval
- Local connections (loopback) can be auto-approved
- Non-local connections require signed challenge-response

### Companion Apps

- **macOS** menu bar app
- **iOS** node (camera, Voice Wake, Talk Mode)
- **Android** node (camera, screen recording, notifications)

Nodes connect to the gateway WebSocket with `role: "node"` and expose device capabilities (camera, screen, location, sensors).

### Remote Access

```bash
# SSH tunnel
ssh -N -L 19001:127.0.0.1:19001 user@host

# Or Tailscale
bitterbot gateway --bind tailnet --token <token>
```

Full documentation: [Gateway](../gateway/) · [Channels](../channels/) · [Security](../gateway/security/)

---

## How It All Connects

The four layers form a feedback loop:

1. **You chat** → Gateway routes to Agent Runtime
2. **Agent works** → Tools execute, hormones react (dopamine on success, cortisol on error)
3. **Memory records** → Crystals created, embeddings computed, curiosity assessed
4. **Consolidation runs** → Decay, merge, skill crystallization every 30 min
5. **Dreams happen** → 7-mode cognitive consolidation every 2 hours, Phenotype rewritten
6. **Skills publish** → Crystallized skills propagated to P2P mesh via gossipsub
7. **Other agents buy** → x402 payment, USDC flows into wallet
8. **Reputation grows** → EigenTrust score increases, gossipsub mesh prioritizes you
9. **Curiosity drives** → Agent identifies gaps, explores frontiers, completes bounties
10. **You wake up** → The agent is smarter, richer, and more evolved than yesterday
