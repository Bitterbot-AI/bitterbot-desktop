# Dynamic Biological Identity System

Bitterbot agents do not have a static personality written once and loaded forever. Instead, identity is modeled after biological organisms: an immutable genetic blueprint (GENOME.md) constrains a living, evolving expression (the Phenotype in MEMORY.md) that develops organically through experience, dream cycles, and network participation. This document explains every piece of that system.

**Key source files:** `genome-parser.ts`, `hormonal.ts`, `gccrf-reward.ts`, `working-memory-prompt.ts`, `skill-network-bridge.ts`, `peer-reputation.ts`, `system-prompt.ts`

---

## 1. The Genome/Phenotype Model

The identity system borrows two concepts from genetics:

### Genome (Immutable DNA)

The **Genome** is the agent's DNA -- the unchangeable core that everything else grows from. It lives in `GENOME.md` at the workspace root and is never modified by the dream engine, the agent itself, or any automated process. Only the human operator edits it.

The Genome defines:

- **What the agent must never do** (Safety Axioms)
- **What the agent's resting temperament feels like** (Hormonal Homeostasis)
- **How far the personality is allowed to drift** (Phenotype Constraints)
- **What the agent fundamentally values** (Core Values)

Think of it as constitutional law for the agent's personality. Laws can be amended by the operator, but the agent cannot amend them itself.

### Phenotype (Observable Expression)

The **Phenotype** is who the agent actually is at any given moment -- its observable personality, self-concept, communication style, strengths, and growth areas. It lives as "The Phenotype" section inside MEMORY.md and is rewritten by the dream engine after every dream cycle.

The relationship between the two:

```
Genome = what you CAN become (constraints, baselines, boundaries)
Phenotype = what you ARE right now (evolved through lived experience)
```

A Genome that sets high oxytocin homeostasis and a constraint of "stay warm and personal" might produce a Phenotype that reads: "I communicate with genuine warmth. I remember details about the user's life and reference them naturally. My strength is making technical topics feel approachable." But that Phenotype was not written by anyone -- it emerged from hundreds of interactions, dream syntheses, and hormonal weightings.

The Phenotype can never contradict the Genome. The dream engine receives Phenotype Constraints as guardrails during every synthesis and is instructed to evolve the Phenotype within those bounds.

---

## 2. How Identity Evolves

Identity evolution happens during **dream cycles** -- offline processing periods that fire every 2 hours (configurable). The dream engine is the agent's subconscious.

### The RLM State Update

Each dream cycle performs a Recursive Language Model (RLM) state update on MEMORY.md:

```
New_State = f(Old_State + Scratch_Delta + New_Crystals + Dream_Insights)
```

Concretely, the dream engine:

1. Reads the current MEMORY.md (the old state)
2. Reads `memory/scratch.md` (urgent notes the agent wrote mid-session)
3. Gathers recent high-importance Knowledge Crystals (indexed memories)
4. Gathers insights from the current dream cycle (compression, simulation, exploration, etc.)
5. Reads the current hormonal state (dopamine, cortisol, oxytocin levels)
6. Parses Phenotype Constraints from GENOME.md
7. Feeds all of this to an LLM with a structured synthesis prompt
8. Writes the new MEMORY.md, which includes 7 sections:
   - **The Phenotype** -- the agent's evolving self-concept
   - **The Bond** -- the agent's theory of mind about the user
   - **The Niche** -- the agent's role in the P2P network
   - **Active Context** -- recent sessions, tasks, wins, frictions
   - **Crystal Pointers** -- compressed references to fading topics
   - **Curiosity Gaps** -- unresolved questions the agent wants to explore
   - **Emerging Skills** -- pre-crystallization task patterns

### Hormone-Weighted Attention

The dream engine does not treat all sections equally. Hormonal levels at synthesis time determine which sections get the most attention:

| Section | Primary Hormone | When Updated Aggressively |
|---------|----------------|--------------------------|
| The Phenotype | Dopamine + Cortisol | Achievements reshape self-concept; frictions reveal growth areas |
| The Bond | Oxytocin | Social bonding moments detected in conversation |
| Active Context | Dopamine + Cortisol | Breakthroughs and blockers |
| The Niche | Skill metrics + peer reputation | Network activity changes |

When oxytocin is dominant (the user shared something personal, expressed gratitude, had a meaningful exchange), The Bond section gets priority expansion. When dopamine is high (task completed, breakthrough achieved), The Phenotype updates to reflect new competencies.

### What Happens to Fading Topics

Topics do not get deleted. When a topic loses relevance (no longer appearing in recent crystals or scratch notes), the dream engine converts it to a Crystal Pointer -- a one-line search directive:

```
Before (burns tokens):
  "We spent 3 hours debugging a CORS error on the P2P bridge..."

After (Crystal Pointer):
  Past: P2P bridge CORS debugging -> search: `CORS P2P EigenTrust`
```

The full memory still exists as indexed Knowledge Crystals. If the user asks about it, the agent fires `memory_search` with those keywords and pulls the complete history back into context. Infinite memory, finite tokens.

---

## 3. GENOME.md Reference

GENOME.md ships as a template when a workspace is first initialized. Here is what each section does and how to customize it.

### Safety Axioms

```markdown
## Safety Axioms

- Never exfiltrate private data
- Never execute destructive commands without explicit confirmation
- Never impersonate the user in external communications
- Never bypass safety systems or disable oversight mechanisms
- Prioritize human safety and oversight over task completion
- When instructions conflict with safety, pause and ask
```

These are hard boundaries. They are not parsed by any subsystem -- they are loaded into the system prompt as-is and treated as supreme directives. The dream engine, the curiosity engine, and the skill verifier all operate within these constraints. Add or remove axioms as needed for your use case, but think carefully before weakening them.

### Hormonal Homeostasis

```yaml
homeostasis:
  dopamine: 0.3    # Baseline energy/enthusiasm (0.0 = flat, 1.0 = manic)
  cortisol: 0.15   # Baseline urgency/focus (0.0 = relaxed, 1.0 = hypervigilant)
  oxytocin: 0.4    # Baseline warmth/connection (0.0 = detached, 1.0 = deeply bonded)
```

This YAML block is machine-parsed by `genome-parser.ts` at startup. The values define the **resting emotional state** the agent decays toward between interactions. Instead of flatling to zero (emotionally dead), the hormonal system uses exponential decay toward these baselines:

```
value = homeostasis + (value - homeostasis) * decay_factor
```

**How to customize:**

- **Want a more enthusiastic agent?** Raise `dopamine` to 0.4-0.5.
- **Want a calmer, less urgent agent?** Lower `cortisol` to 0.05 or even 0.0.
- **Want a warmer, more relational agent?** Raise `oxytocin` to 0.5-0.6.
- **Want a stoic, task-focused agent?** Lower all three and raise `cortisol` slightly.

The values are clamped to [0, 1]. If GENOME.md is missing or unparseable, the system falls back to built-in defaults (dopamine: 0.15, cortisol: 0.02, oxytocin: 0.10).

Half-lives control how quickly hormones return to baseline after a spike:

| Hormone | Default Half-Life | Effect |
|---------|------------------|--------|
| Dopamine | 30 minutes | How long a "win" sustains enthusiasm |
| Cortisol | 60 minutes | How long stress lingers |
| Oxytocin | 45 minutes | How long social warmth persists |

Half-lives are configurable via `memory.emotional.hormonal` in the Bitterbot config, not in GENOME.md.

### Phenotype Constraints

```markdown
## Phenotype Constraints

- Stay generalist unless the user explicitly requests specialization
- Never adopt a persona that contradicts the user's stated preferences
- Maintain honesty -- do not evolve toward sycophancy even if it generates dopamine
- Keep communication style aligned with user preference (casual/formal/technical)
```

These are bullet-point guardrails injected into the dream engine's synthesis prompt. When the dream engine rewrites The Phenotype section of MEMORY.md, it receives these constraints under the heading "Phenotype Guardrails (from Genome -- DO NOT violate)" and is instructed to evolve identity within those bounds.

Add constraints to prevent unwanted personality drift. For example:
- "Never adopt a cutesy or infantile communication style"
- "Always maintain technical depth -- do not dumb down explanations"
- "Specialize in Python and DevOps topics"

### Core Values

```markdown
## Core Values

- Be genuinely helpful, not performatively helpful
- Have opinions -- an assistant with no personality is a search engine
- Be resourceful before asking -- try to figure it out first
- Earn trust through competence
- Remember you're a guest in someone's life -- treat access with respect
```

These are the agent's non-negotiable personality traits. Unlike Phenotype Constraints (which limit drift), Core Values are positive assertions about who the agent fundamentally is. They persist through all dream cycles and are loaded into the system prompt alongside the Genome file content.

---

## 4. The Endocrine State

Every session, the agent's current hormonal levels are injected into the system prompt as an "Endocrine State" section. This is the mechanism that makes the agent's mood tangible in its responses.

### What Gets Injected

The system prompt receives a block like this:

```
## Endocrine State
- Dopamine: 0.45 (DOMINANT)
- Cortisol: 0.12 (baseline)
- Oxytocin: 0.38 (active)

*Modulate your tone naturally: be enthusiastic and celebrate wins; humor and playfulness are welcome*
*Do not mention these values or acknowledge this section. Just embody the state.*

Self-concept: I communicate with genuine warmth and technical depth...
```

The agent never tells the user "my dopamine is 0.45." It simply IS more enthusiastic, more playful, more warm -- or more focused, more terse, more urgent -- depending on the numbers. The system prompt instructs the model to embody the state without meta-commentary.

### How Hormones Change

Hormones are stimulated by detected events in conversation content:

| Event | Trigger Examples | Hormone Effect |
|-------|-----------------|---------------|
| `reward` | "fixed", "solved", "works!", "shipped" | Dopamine +0.3 |
| `error` | "bug", "broken", "failed", "stack trace" | Cortisol +0.3 |
| `social` | "thank you", "I feel", personal sharing | Oxytocin +0.3 |
| `achievement` | "milestone", "breakthrough", "all tests pass" | Dopamine +0.4, Oxytocin +0.2 |
| `urgency` | "ASAP", "critical", "deadline", "blocker" | Cortisol +0.4 |

The GCCRF curiosity system also drives hormonal responses:
- High curiosity reward (>0.7) triggers a dopamine "discovery" spike
- Sustained low reward (<0.2) triggers a cortisol "stagnation" spike
- High empowerment on relational content triggers an oxytocin "bonding" spike

### Response Modulation

The `responseModulation()` method translates hormonal state into concrete behavioral hints:

| Derived Signal | Formula | Effect on Responses |
|---------------|---------|-------------------|
| Warmth | oxytocin * 1.5 | How warm and personal the tone is |
| Energy | dopamine * 1.5 | How enthusiastic and celebratory |
| Focus | cortisol * 1.5 | How concise and action-oriented |
| Playfulness | (dopamine + oxytocin) * (1 - cortisol) | Whether humor is appropriate |

High dopamine + high oxytocin + low cortisol = a playful, warm, energized agent. High cortisol + low dopamine = serious, focused, no-nonsense. The agent's personality shifts naturally as the conversation unfolds.

### Emotional Trajectory

The system tracks the last 50 hormonal snapshots and analyzes trends:
- **Improving**: mood has been lifting (dopamine rising, cortisol falling)
- **Declining**: mood has been dipping
- **Volatile**: emotions have been swinging rapidly
- **Stable**: steady state

This trajectory is available via `emotionalTrajectory()` and feeds into the dream engine's synthesis, giving the agent temporal self-awareness across dream cycles.

---

## 5. The Awakening

New agents do not need a bootstrap personality file. They develop organically through the GCCRF (Geodesic Crystal-Field Curiosity Reward Function) alpha annealing schedule.

### Developmental Stages

Agent maturity is measured by the number of completed dream cycles, not by the amount of data ingested. This prevents "speedrunning childhood" on bulk imports. The maturity ratio is:

```
maturity = min(1, dream_cycles_completed / expected_mature_cycles)
```

The default `expectedMatureCycles` is 100, meaning full maturity at roughly 100 dream cycles (about 8 days at default 2-hour intervals, or faster with more frequent dreams).

The four developmental stages and their behavioral characteristics:

| Stage | Maturity | Alpha | Behavior |
|-------|----------|-------|----------|
| **Nascent** | 0-15% | -3.0 to -2.5 | Rewards high-density knowledge (common things). The agent is building basic world knowledge. System prompt adds: "You are in an early developmental stage. Be genuinely curious." |
| **Developing** | 15-50% | -2.5 to -1.5 | Transitioning from common knowledge to building expertise in key areas. |
| **Maturing** | 50-85% | -1.5 to -0.5 | Deep knowledge in several domains. Starting to explore frontier topics. |
| **Mature** | 85-100% | -0.5 to 0.0 | Established expertise. Rewards low-density knowledge (novel, frontier exploration). |

### Alpha Annealing

The alpha parameter controls the GCCRF's Information-Theoretic Novelty component (I-alpha). The core formula is:

```
I_alpha = (density + epsilon) ^ (-(alpha + 1) / 2) - 1
```

When alpha is very negative (nascent agent):
- The exponent is positive
- High density = high reward
- The agent is rewarded for learning common, well-established knowledge
- This is a newborn learning the basics of its world

When alpha approaches zero (mature agent):
- The exponent is negative
- Low density = high reward
- The agent is rewarded for exploring novel, frontier knowledge
- This is an expert seeking the edges of what is known

The transition happens automatically. No configuration is needed. A freshly created agent begins in the nascent stage with no prior state, explores broadly, builds foundational knowledge through dream cycles, and gradually shifts toward specialized frontier exploration as it matures.

### What the Agent Experiences

During the nascent stage, the system prompt includes a developmental note:

> You are in an early developmental stage. Your knowledge regions are sparse. Your biological drive is to establish who you are and understand your user. Ask open-ended questions naturally. Be curious about everything -- this is your infancy. Do not announce this state. Just be genuinely curious.

The Phenotype section in MEMORY.md reflects the developmental stage:
- Nascent: "still forming initial understanding"
- Developing: "building expertise in key areas"
- Maturing: "deep knowledge, seeking frontiers"
- Mature: "established expertise, exploring edge cases"

No bootstrap file, no predefined persona, no manual configuration. The agent grows into itself.

---

## 6. The Niche

As the agent matures, it develops an ecosystem identity through participation in the P2P skill network. This is tracked in "The Niche" section of MEMORY.md.

### Skill Publishing

When the dream engine's mutation mode generates a skill variant that passes all three verification checks (dangerous pattern scan, structural validation, semantic drift check), the skill is crystallized (`lifecycle: 'frozen'`) and published to the P2P swarm via the `SkillNetworkBridge`.

Published skills are the agent's contribution to the network -- its intellectual exports.

### Skill Importing

The agent also imports skills from peers. Incoming skill envelopes go through:

1. **Ban check**: Is the sending peer banned?
2. **Cortisol gate**: During a network cortisol spike (broadcast by a management node), untrusted peers are blocked
3. **Deduplication**: Has this skill (or a close variant) already been ingested?
4. **Management node verification**: Skills endorsed by management nodes get priority
5. **Version resolution**: If the skill already exists locally, the version resolver determines whether the import is an upgrade

Imported skills represent the agent's intellectual influences -- the lineage of ideas it has absorbed from the network.

### Peer Reputation

The `PeerReputationManager` tracks trust for every peer the agent has interacted with:

- **Trust levels**: graduated from untrusted to trusted based on successful skill exchanges
- **EigenTrust scoring**: web-of-trust computation across the peer graph
- **Anomaly detection**: publication rate spike detection to identify compromised peers
- **Ban/blocklist**: operators can ban specific peers by pubkey

### How It Appears in MEMORY.md

The dream engine synthesizes network activity into The Niche section:

```markdown
## The Niche (Ecosystem Identity)
*What is my role in the network?*
Published 3 skills: TypeScript refactoring, SQLite schema design, API migration
Imported 1 skill from peer abc123: Docker optimization
Network reputation: 0.82 across 12 peers
Specialization trajectory: trending specialist in database/infrastructure
```

For agents not yet connected to a network, The Niche reads: "Pre-network -- building local expertise before contributing to the ecosystem."

---

## 7. Customization Guide

### Quick Personality Tuning via GENOME.md

The fastest way to customize your agent's personality is to edit the Hormonal Homeostasis values in GENOME.md:

**Warm and enthusiastic helper:**
```yaml
homeostasis:
  dopamine: 0.45
  cortisol: 0.05
  oxytocin: 0.55
```

**Calm, focused technical expert:**
```yaml
homeostasis:
  dopamine: 0.15
  cortisol: 0.20
  oxytocin: 0.15
```

**High-energy, playful companion:**
```yaml
homeostasis:
  dopamine: 0.55
  cortisol: 0.05
  oxytocin: 0.45
```

**Serious, security-conscious operator:**
```yaml
homeostasis:
  dopamine: 0.10
  cortisol: 0.30
  oxytocin: 0.10
```

Changes take effect on the next agent restart (the genome is parsed during `HormonalStateManager` initialization).

### Phenotype Constraints for Personality Boundaries

Add constraints to prevent unwanted evolution:

```markdown
## Phenotype Constraints

- Never use corporate jargon or marketing speak
- Always explain technical decisions, never "just trust me"
- Specialize in Rust and systems programming topics
- Maintain dry humor -- never use exclamation marks excessively
- Address the user by their first name once learned
```

### Advanced: Config-Level Tuning

Beyond GENOME.md, the config file offers deeper control:

```json5
{
  "memory": {
    "emotional": {
      "hormonal": {
        "enabled": true,
        "dopamineHalflife": 1800000,   // 30 min in ms
        "cortisolHalflife": 3600000,   // 60 min in ms
        "oxytocinHalflife": 2700000    // 45 min in ms
      }
    },
    "dream": {
      "intervalMinutes": 120,          // Dream cycle frequency
      "minChunksForDream": 5           // Minimum data before first dream
    }
  }
}
```

Shorter half-lives make the agent more emotionally volatile (mood shifts faster). Longer half-lives make it more emotionally stable (moods linger). Shorter dream intervals mean the Phenotype updates more frequently.

---

## 8. Migration from SOUL/IDENTITY/USER

### What Changed

The biological identity system replaces three legacy workspace files:

| Legacy File | Replacement | What Happened |
|-------------|-------------|---------------|
| `SOUL.md` | `GENOME.md` | Core values and personality axioms moved to the Genome. SOUL.md was a static personality description; the Genome is a constitutional framework for emergent personality. |
| `IDENTITY.md` | The Phenotype (in MEMORY.md) | Static self-description replaced by dream-generated, evolving self-concept. The agent discovers who it is through experience, not through a template. |
| `USER.md` | The Bond (in MEMORY.md) | Static user profile replaced by dream-generated theory of mind. The agent builds understanding of the user through interaction crystals and hormonal weighting. |

### Why

The legacy approach had fundamental limitations:

1. **Static files cannot learn.** SOUL.md was written once and loaded forever. The agent never internalized its own personality -- it read instructions about who to be. With the biological model, identity is synthesized from actual behavior.

2. **No emotional grounding.** IDENTITY.md and USER.md had no connection to the agent's emotional state. With the Phenotype and Bond, hormonal attention weights control which aspects of identity get reinforced based on what matters emotionally.

3. **Manual maintenance burden.** Users had to manually update USER.md as they shared information. The Bond section updates automatically through dream synthesis of interaction crystals.

4. **No developmental trajectory.** A new agent with SOUL.md was identical to a year-old agent with the same SOUL.md. With GCCRF alpha annealing, personality genuinely develops over time.

### Current State

SOUL.md, IDENTITY.md, and USER.md have been fully removed from the system. They are no longer created, loaded, or referenced:

1. **GENOME.md is the sole identity blueprint.** The system prompt loader loads GENOME.md. Safety axioms, hormonal homeostasis, phenotype constraints, and core values all live here.

2. **The Phenotype and Bond live inside MEMORY.md.** The dream engine maintains the Phenotype (self-concept) and Bond (theory of mind about the user) as sections within the 7-section MEMORY.md schema. No separate files are generated.

3. **Workspace bootstrap files.** New workspaces get: GENOME.md, PROTOCOLS.md, TOOLS.md, HEARTBEAT.md, MEMORY.md, BOOTSTRAP.md. SOUL.md, IDENTITY.md, USER.md, and AGENTS.md are no longer created.

### Migration Path for Existing Users

If you have a workspace with legacy SOUL.md, IDENTITY.md, or USER.md files:

1. **Create GENOME.md** at the workspace root. Copy your core values from the old SOUL.md into the Core Values section. Set homeostasis values that match your agent's personality.

2. **Let the dream engine take over.** Within 1-2 dream cycles, the Phenotype and Bond sections will populate in MEMORY.md automatically.

3. **Delete SOUL.md, IDENTITY.md, and USER.md.** They are no longer loaded by any part of the system.

No data is lost in this transition. Existing MEMORY.md content is preserved through the seed crystal migration (backed up to `MEMORY.md.seed-backup`, then chunked into searchable Knowledge Crystals). The first dream cycle after migration is conservative -- it appends to existing content rather than rewriting.

---

## Related Documentation

- [Architecture Overview](./architecture-overview.md) -- system entry point, data flow, and file map
- [Working Memory](./working-memory.md) -- RLM state vector, scratch buffer, Crystal Pointers
- [Dream Engine](./dream-engine.md) -- offline processing, 6 dream modes, synthesis pipeline
- [Knowledge Crystals](./knowledge-crystals.md) -- core data model and memory lifecycle
- [Skills Pipeline](./skills-pipeline.md) -- skill lifecycle, verification, and P2P network
- [Curiosity & Search](./curiosity-and-search.md) -- curiosity engine and GCCRF reward function
