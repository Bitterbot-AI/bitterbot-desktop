---
title: "Memory"
summary: "How the Bitterbot biological memory system works"
read_when:
  - You want to understand the memory architecture
  - You want to learn about dreams, crystals, curiosity, and hormones
---

# Memory

Bitterbot's memory is a biological cognitive architecture, not a vector database with a retrieval step. It runs entirely inside Node.js using SQLite, with no external services required.

## Core Components

| Component                      | What It Does                                                                                                                                                                                                                                    | Docs                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Knowledge Crystals**         | Memories that naturally decay via Ebbinghaus curves. Frequently accessed facts become permanent; unused info fades.                                                                                                                             | [Knowledge Crystals](../memory/knowledge-crystals.md)   |
| **Dream Engine**               | Every 2 hours, the agent goes offline to dream — running 7 specialized modes to consolidate, mutate, and optimize knowledge.                                                                                                                    | [Dream Engine](../memory/dream-engine.md)               |
| **Curiosity Engine**           | Unified intrinsic motivation with GCCRF reward scoring. Maps what the agent _doesn't_ know. Detects gaps, contradictions, and semantic frontiers. Developmental alpha annealing shifts curiosity from common knowledge to frontier exploration. | [Curiosity & Search](../memory/curiosity-and-search.md) |
| **Hormonal System**            | Three neuromodulators (dopamine, cortisol, oxytocin) shape personality in real-time and determine what's worth remembering.                                                                                                                     | [Emotional System](../memory/emotional-system.md)       |
| **Working Memory (MEMORY.md)** | Dream-synthesized identity: the Phenotype (self-concept), Bond (theory of mind), Niche (ecosystem role), and active context. Rewritten every dream cycle.                                                                                       | [Working Memory](../memory/working-memory.md)           |
| **Skills Pipeline**            | Successful task patterns are crystallized into tradeable skills, published to the P2P marketplace.                                                                                                                                              | [Skills Pipeline](../memory/skills-pipeline.md)         |
| **Deep Recall (RLM)**          | For massive context (10M+ tokens), spawns a sub-LLM that writes and executes search code against full history.                                                                                                                                  | [Deep Recall](../memory/deep-recall.md)                 |

## Agent Identity Files

Every agent ships with a workspace that defines who it is:

| File           | Purpose                                                                      | Mutability                            |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `GENOME.md`    | Safety axioms, hormonal baselines, core values, personality constraints      | Immutable — dreams can never override |
| `MEMORY.md`    | Living working memory — Phenotype, Bond, Niche, active context               | Rewritten every dream cycle           |
| `PROTOCOLS.md` | Operating procedures — how the agent behaves in groups, sessions, heartbeats | User-editable                         |
| `TOOLS.md`     | Environment-specific notes — camera names, SSH hosts, device nicknames       | User-editable                         |
| `HEARTBEAT.md` | Periodic tasks the agent checks on a schedule                                | User-editable                         |

## What the agent is told

The system prompt carries only a short **Memory System** index (one line per tool and when to reach for it, plus two rules; under 600 tokens) so the cached prompt prefix stays small. The long-form guidance is progressive disclosure: bundled skills the agent opens only when the situation applies.

| Skill                     | Loads when                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `memory-architecture`     | The user asks how memory, dreams, hormones or crystals work; interpreting `memory_status` output   |
| `working-memory-protocol` | Deciding what to record with `working_memory_note`; "remember this"; corrections; Crystal Pointers |
| `curiosity-loop`          | "What are you curious about?"; dream insights; closing an exploration target                       |
| `pre-action-interceptors` | A tool error starting with `INTERCEPTOR:`; a silently hedged message; questions about guards       |
| `forage-economy`          | Bounties ("forge"), agent earnings, marketplace skills, A2A activity, reputation                   |
| `circles-protocol`        | Anything about the user's circles, before calling the `circles` tool                               |

Canonical Facts (the ledger described in [How the Memory Works](../memory/how-the-memory-works.md)) render as `- [key] value` lines sorted by key, without counts, dates or statement sentences, capped at 2,400 chars; placeholder values and heartbeat scaffolding never reach the prompt. See [System Prompt](system-prompt.md) for the full layout and the stable-half token budget.

## How It Works

```
Session → Chunk indexing → Embedding → Crystal creation
                                            ↓
                              Consolidation (every 30 min)
                              ├── Ebbinghaus decay
                              ├── Chunk merging (cosine ≥ 0.92)
                              ├── SNN near-merge discovery (cosine 0.82-0.91)
                              ├── Orphan cluster detection → replay queue
                              ├── Curiosity region mapping
                              ├── Hormonal modulation
                              └── Skill crystallization
                                            ↓
                                Dream Engine (every 2 hours + emotional triggers)
                                ├── Readiness check (skip if nothing new)
                                ├── CuriosityEngine signals + self-validating FSHO → mode selection
                                ├── Replay (ripple-enhanced, orphan priority)
                                ├── Mutation (evolve skills)
                                ├── Extrapolation (anticipate needs)
                                ├── Compression (consume near-merge hints)
                                ├── Simulation (cross-domain recombination)
                                ├── Exploration (investigate knowledge gaps)
                                └── Research (autonomous skill optimization)
                                            ↓
                              Working Memory rewrite (MEMORY.md)
                              ├── Phenotype evolution
                              ├── Bond update (theory of mind)
                              └── Curiosity gap identification
```

## Storage

Everything lives in a single SQLite database per agent at `~/.bitterbot/memory/<agentId>.sqlite`. The database contains:

- Knowledge crystals (chunks + embeddings)
- Dream insights and cycle history
- Curiosity regions and surprise assessments
- Peer reputation and trust edges
- Marketplace listings and purchases
- Skill execution metrics

No external database, no cloud dependency. One `.db` file is the entire memory.

## Configuration

Memory is configured under `memory` in `bitterbot.json`:

```json
{
  "memory": {
    "backend": "builtin"
  }
}
```

The `builtin` backend is the only supported backend. Embedding providers (OpenAI, Gemini, Voyage, local) are configured separately under `agents.defaults.memorySearch`.

`agents.defaults.memorySearch.excludePaths` (workspace-relative globs, `**` spans directories) keeps files out of the memory index. Default: `["memory/memory-snapshots/**", "memory/dream-journal.md"]` — the dream journal (hundreds of KB, appended every cycle) and the per-cycle working-memory snapshots changed on every dream cycle, so the file-level hash gate never matched and they were re-chunked and re-embedded each sync (60-180 s embed calls). Dream insights are promoted into searchable chunks separately; snapshots are provenance for the rewrite, not memory. Set `excludePaths: []` to index everything.

## Full Documentation

For the complete architecture guide, see [Memory System Architecture Overview](../memory/architecture-overview.md).
