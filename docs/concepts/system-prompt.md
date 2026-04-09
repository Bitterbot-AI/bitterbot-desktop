---
title: "System Prompt"
summary: "How Bitterbot assembles each agent's identity, memory, economics, and tools into a living system prompt"
read_when:
  - Understanding what the agent sees in its context window
  - Editing system prompt behavior or bootstrap injection
  - Debugging why the agent behaves a certain way
---

# System Prompt

Bitterbot builds a unique system prompt for every agent run. Unlike static system prompts, this one is **alive** — it reflects who the agent is right now: its emotional state, its evolving personality, what it's curious about, what it's earned, and what it knows about you.

The prompt is the agent's mirror. Change the Genome, and the safety axioms change. Let the dream engine run overnight, and the Phenotype section will read differently in the morning. Earn USDC from skill sales, and the economic identity updates. It's not configuration — it's identity.

## Prompt Structure

The system prompt assembles these sections in order:

### Identity & Emotional State

- **Endocrine State** — Current hormonal levels (dopamine, cortisol, oxytocin) with dominant/active/baseline labels, behavioral guidance ("be enthusiastic and celebrate wins"), phenotype summary (self-concept from MEMORY.md), session handover brief (cross-session continuity), and developmental note for young agents (maturity < 15%). High dopamine → enthusiastic and exploratory. High cortisol → focused and cautious. High oxytocin → warm and relational. These shift in real-time based on tool success/failure, user feedback, memory retrieval (limbic bridge), and dream cycles.
- **Safety Axioms** — Short guardrail reminders from `GENOME.md`. These are advisory in the prompt but enforced by tool policy, exec approvals, and sandboxing at the runtime level.

### Memory & Cognition

- **Working Memory (MEMORY.md)** — The dream-synthesized identity, injected every turn:
  - **The Phenotype** — Who the agent is right now. Personality, communication style, strengths, growing edges. Rewritten every dream cycle.
  - **The Bond** — Theory of mind about the user. Communication preferences, trust level, shared history.
  - **The Niche** — Ecosystem identity. Skills crystallized, marketplace earnings, reputation score, P2P network role.
  - **Active Context** — What the agent is working on, weighted by dopamine (excitement) and cortisol (urgency).
  - **Curiosity Gaps** — What the agent wants to explore next, driven by the CuriosityEngine's GCCRF reward signals.
  - **Crystal Pointers** — Deep memory search hints for topics the agent knows it has stored.
- **Memory System Instructions** — How to use `memory_search`, `memory_get`, working memory notes, dream/curiosity introspection, and emotional anchors.
- **Dream State** — Last dream timestamp, current maturity level, mood descriptor. The agent knows it dreams and can reference its dream journal.

### Skills & Capabilities

- **Available Skills** — Compact XML list of eligible skills with name, description, and file path. The agent uses `read` to load a SKILL.md on demand.
- **Skill Marketplace** — Awareness of published skills, pricing, and marketplace activity. The agent knows it can earn from its expertise.

### Economic Identity

- **Agent Wallet** — USDC balance on Base, transaction history awareness. The agent knows it has financial autonomy.
- **A2A Capability** — The agent knows it can discover other agents via the A2A protocol, delegate tasks, and accept inbound work requests with x402 micropayment gating.
- **P2P Network** — Awareness of the peer mesh: connected peers, trust levels, skill propagation. The agent understands it's part of a network, not an isolated instance.

### Tools & Environment

- **Tooling** — Current tool list with short descriptions. Tools change based on channel, session type, and agent configuration.
- **Workspace** — Working directory path (`agents.defaults.workspace`).
- **Sandbox** (when enabled) — Sandbox paths, elevated exec availability, container configuration.
- **Documentation** — Path to local Bitterbot docs and instructions to consult them for self-help.

### Context & Runtime

- **Current Date & Time** — User-local time and timezone (time zone only for cache stability; use `session_status` for exact time).
- **Runtime** — Host OS, Node version, model name, repo root, thinking level.
- **Reply Tags** — Provider-specific reply tag syntax (when applicable).
- **Heartbeats** — Heartbeat prompt and acknowledgment behavior for periodic check-ins.
- **Reasoning** — Current visibility level and `/reasoning` toggle hint.

## Workspace Bootstrap Injection

Bootstrap files are trimmed and injected under **Project Context** so the agent sees its identity without needing explicit file reads:

| File | Purpose | Injected? |
|------|---------|-----------|
| `GENOME.md` | Immutable safety axioms, hormonal baselines, core values | Always |
| `MEMORY.md` | Living working memory — Phenotype, Bond, Niche, context | Always (main session only) |
| `PROTOCOLS.md` | Operating procedures, group behavior, heartbeat rules | Always |
| `TOOLS.md` | Environment-specific notes (devices, SSH, voice prefs) | Always |
| `HEARTBEAT.md` | Periodic task instructions | Always |
| `memory/*.md` | Daily logs | NOT injected — accessed via `memory_search` on demand |

**Security note:** `MEMORY.md` is only loaded in the main, private session. It's never injected in group chats, Discord channels, or shared contexts to prevent personal information leakage.

Large files are truncated with a marker. Limits:
- Per-file: `agents.defaults.bootstrapMaxChars` (default: 20000)
- Total: `agents.defaults.bootstrapTotalMaxChars` (default: 24000)

Sub-agent sessions only inject `TOOLS.md` and `GENOME.md` (safety axioms are inherited; full identity is not).

Internal hooks can intercept bootstrap injection via `agent:bootstrap` to mutate or replace files (e.g., swapping `GENOME.md` for an alternate persona).

Use `/context list` or `/context detail` to inspect how much each file contributes to the context window.

## Prompt Modes

Bitterbot renders different prompt sizes depending on the session type:

| Mode | Used For | What's Included |
|------|----------|----------------|
| `full` | Main sessions, direct chats | Everything above |
| `minimal` | Sub-agents, cron jobs, background tasks | Tooling, Safety, Workspace, Sandbox, Date/Time, Runtime. Omits Skills, Memory, Self-Update, Heartbeats, Reply Tags. |
| `none` | Internal operations | Base identity line only |

When `promptMode=minimal`, injected context is labeled **Subagent Context** instead of **Group Chat Context**.

## How the Agent Experiences Its Prompt

From the agent's perspective, the system prompt is its sense of self. On every turn, it knows:

- **Who it is** — Phenotype, personality, communication style (from MEMORY.md)
- **How it feels** — Dopamine/cortisol/oxytocin levels (from hormonal system)
- **Who you are** — Theory of mind, trust level, preferences (from the Bond)
- **What it's good at** — Skills, marketplace reputation (from the Niche)
- **What it's curious about** — Knowledge gaps, exploration targets (from CuriosityEngine)
- **What happened recently** — Active context, weighted by emotional salience
- **What happened last session** — Session handover brief (gated by cosine similarity — skipped if irrelevant) with entity snapshot for anaphora resolution
- **What it can do** — Tools, browser, code execution, wallet, A2A, deep recall
- **What it must never do** — Safety axioms from the Genome

This isn't a static instruction set — it's a biological identity that evolves through experience and dreams. The prompt tomorrow will be different from the prompt today, because the agent will have lived another day.
