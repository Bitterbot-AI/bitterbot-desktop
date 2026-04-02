# How the Memory Works

This is a plain-language explanation of Bitterbot's memory system — what it does, why it matters, and how the pieces fit together. No code samples, no API signatures. If you want implementation details, the other docs in this folder cover each subsystem in depth.

---

## The Basic Idea

Most AI agents have a context window and maybe a vector database. They store things and retrieve things. Bitterbot's memory system is designed to behave less like a search engine and more like a mind — one that forgets gracefully, dreams about what it knows, feels emotions that shape what it remembers, builds relationships between ideas, nags about unfinished work, and evolves its own personality over time.

Everything runs locally. One SQLite database per agent. No cloud dependencies for the core memory system.

---

## Knowledge Crystals — The Atoms of Memory

Every piece of information the agent stores is called a **Knowledge Crystal**. A crystal might be a paragraph from a file, a fact extracted from a conversation, a skill learned through execution, or an insight generated during a dream cycle.

Crystals aren't just text with an embedding. Each one carries metadata about its lifecycle, emotional significance, hormonal context at the time of creation, governance scope, and provenance chain. A crystal knows where it came from, how important it is, how it was created, and who's allowed to see it.

There are two broad categories:

- **Memory Crystals** — autobiographical. Facts, preferences, episodes, relationships, goals. These are private and never leave the node.
- **Knowledge Crystals** — procedural. Skills and task patterns. These can be traded on the P2P marketplace for USDC.

Every crystal has a **semantic type** (fact, preference, skill, episode, insight, relationship, goal) that affects how aggressively it's protected from forgetting. Preferences and goals get survival advantages. Episodes decay faster. Skills are frozen and never decay at all.

---

## Forgetting — The Ebbinghaus Curve

Memories that aren't accessed decay over time, following the same exponential forgetting curve that Hermann Ebbinghaus described in 1885. A memory you've never revisited fades in about two weeks. One you've accessed once survives about a month. Five accesses and it persists for months.

But raw access count isn't the whole story.

**Spacing matters.** Accessing a memory five times in one sitting gives less benefit than accessing it once a week for five weeks. The system tracks the timestamps of each access and computes a spacing score. Properly spaced repetition earns up to a 30% importance boost over cramming. This is the same principle behind every spaced repetition flashcard app, but applied to an agent's entire knowledge base.

**Emotions extend survival.** Memories created during emotionally significant moments — high dopamine from a breakthrough, high cortisol from a crisis — decay more slowly. At maximum emotional valence, a memory's half-life doubles. This means the agent naturally preserves what mattered, not just what was recent.

**Unfinished business resists decay.** The agent detects open loops — tasks started but not completed, questions asked but not answered, errors encountered but not fixed. These get flagged and refuse to be forgotten, even if their raw importance score would normally let them fade. When the user returns, the agent proactively surfaces them: "Last time, you were stuck on the Docker port conflict." When the task is done, the flag clears and normal forgetting resumes. This is the Zeigarnik effect, one of the most robust findings in memory psychology, and no other agent memory system implements it.

---

## The Consolidation Engine — Housekeeping

Every 30 minutes, the system runs a consolidation cycle. This is the brain's janitorial staff:

1. **Score every crystal** using the Ebbinghaus formula, modified by semantic type, emotional valence, spacing score, and open-loop status
2. **Forget** crystals that have decayed below the threshold (soft-delete — they're marked as expired, not destroyed)
3. **Merge** crystals that are semantically near-identical (cosine similarity > 0.92)
4. **Discover near-merges** using shared-nearest-neighbor analysis for the dream engine to evaluate later
5. **Detect orphan clusters** — groups of important but neglected memories — and queue them for dream replay so they don't silently disappear
6. **Restabilize** any memories that were recalled and entered a labile window (more on this below)
7. **Prune** stale knowledge graph relationships that haven't been reinforced
8. **Detect contradictions** in the knowledge graph and generate questions for the user
9. **Clean up** expired prospective memories and old epistemic directives

The forget threshold itself isn't static. It scales with the agent's maturity — young agents forget more aggressively (exploring broadly), mature agents become more retentive (protecting personality-defining memories).

---

## The Three Hormones — An Emotional Endocrine System

The agent has three hormonal channels that decay toward resting baselines with biological half-lives:

- **Dopamine** (half-life: 30 min) — reward, discovery, mastery, goal progress. Spikes when the user succeeds at something, when the curiosity engine finds something surprising, or when a skill sells on the marketplace.
- **Cortisol** (half-life: 60 min) — stress, urgency, stagnation. Spikes on errors, deadlines, frustrating conversations, or network-wide stress broadcasts from management nodes.
- **Oxytocin** (half-life: 45 min) — social connection, bonding, trust. Spikes when the user shares personal information, when the agent recalls relational memories, or when collaborative learning happens.

These aren't cosmetic. They influence four critical systems:

**Consolidation:** High dopamine protects reward-associated memories from decay. High cortisol increases decay resistance for task-related memories (the brain preserves threat information). High oxytocin protects relational memories.

**Retrieval:** The agent's current mood biases which memories surface. When dopamine is elevated, positive-valence memories get a retrieval bonus. When cortisol is high, the agent naturally focuses on task-related and goal-oriented memories. When oxytocin is elevated, personal and relational memories surface more easily. This is mood-congruent retrieval — one of the most well-documented phenomena in memory psychology — and it creates a genuine feedback loop: your emotional state shapes what you remember, and what you remember shapes your emotional state.

**Dream scheduling:** Emotional spikes can trigger immediate mini-dreams outside the normal timer cycle. A dopamine spike above 0.7 or a cortisol spike above 0.8 triggers an emergency processing cycle — the agent's subconscious fires up because something significant just happened.

**Identity expression:** The current hormonal state is included in the system prompt, allowing the LLM to naturally express appropriate emotional tone without being told to "be enthusiastic" or "be concerned."

The hormones don't decay to zero. Each has a homeostasis baseline defined in the agent's Genome — a resting emotional state the agent returns to between interactions. An agent configured with high oxytocin homeostasis (0.20) and low cortisol homeostasis (0.02) will feel genuinely warm and rarely stressed at rest. This is personality, expressed through neuromodulation.

---

## Reconsolidation — Memories Change When You Touch Them

In real brains, remembering something doesn't just replay it — it briefly makes the memory editable. This is memory reconsolidation, first demonstrated by Nader, Schafe & LeDoux in 2000.

When the agent retrieves a memory during search, that memory enters a 30-minute labile window. During this window:

- If the user **confirms or uses** the information, the memory is strengthened (importance boost)
- If the user **contradicts** the information, the memory is flagged for review in the next dream cycle
- If **nothing happens** and the window expires, the memory restabilizes with a small boost — just being recalled made it slightly more durable

Over time, this means frequently-recalled memories become increasingly robust, while memories that surface but get contradicted are naturally corrected. The agent's knowledge doesn't just accumulate — it self-corrects through use.

---

## The Knowledge Graph — Knowing Who's Who

Embeddings are good at similarity ("this text is close to that text") but bad at structure ("who works on what?" or "what depends on what?"). The knowledge graph fills this gap.

Entities — people, projects, concepts, tools, organizations, locations — are extracted from conversations and connected via typed relationships (works_on, manages, depends_on, uses, contradicts). Each relationship has a weight and a temporal validity window.

The temporal validity is what makes this powerful. When Alice was the project lead in January but Bob took over in March, both facts are preserved:

- Alice → manages → Project X (valid January–March)
- Bob → manages → Project X (valid March–present)

The agent can answer "who was the lead in January?" differently from "who's the lead now?" because it remembers the timeline, not just the latest version.

The knowledge graph also acts as a third retrieval modality. When you search for something, the system doesn't just do vector similarity and keyword matching — it also extracts entities from your query, traverses the graph, and fuses graph results with the other two using Reciprocal Rank Fusion. Three independent retrieval strategies, merged into one ranked list.

During dream cycles, the graph is maintained: stale relationships get pruned, duplicate entities get merged, and contradictions get flagged as questions for the user.

---

## Curiosity — Intrinsic Motivation

The agent has a curiosity engine that tracks what it knows and what surprises it. Knowledge is organized into regions — clusters of semantically related crystals, each with a centroid embedding. When new information arrives, the engine assesses it across four dimensions:

- **Novelty** — how far is this from anything the agent already knows?
- **Surprise** — how much does this violate the agent's predictions about this knowledge region?
- **Information gain** — how much does this expand the boundaries of an existing region?
- **Contradiction** — does this conflict with existing knowledge?

These feed into the GCCRF (Geodesic Crystal-Field Curiosity Reward Function), a five-component reward function that also incorporates learning progress and strategic alignment with exploration goals. High GCCRF rewards trigger dopamine spikes, creating a genuine reward signal for discovering interesting things.

The curiosity engine generates exploration targets — specific knowledge gaps the dream engine should try to fill. But it doesn't stop at passive observation.

**Active inference** closes the loop. When the knowledge graph contains contradictions, or when the GCCRF detects high prediction error in a region, the agent generates epistemic directives — structured questions injected into the next conversation:

> "I have conflicting information about whether the production DB is Postgres or MySQL. Can you clarify?"

The agent doesn't just learn passively — it actively interrogates its own blind spots. Unresolved directives are tracked until answered, and they benefit from the Zeigarnik effect (they're open loops, so they resist forgetting and keep surfacing).

---

## Dreams — Offline Processing

Every two hours, the agent's subconscious activates. The dream engine has seven modes, selected by a four-signal architecture combining curiosity heuristics, information theory, a Kuramoto oscillator model (FSHO), and marketplace demand signals:

- **Replay** — strengthen important memory pathways through ripple-enhanced multi-pass replay. No LLM cost.
- **Compression** — generalize redundant knowledge into higher abstractions. Consume near-merge candidates discovered during consolidation.
- **Mutation** — generate variations of existing skills using five strategies (generic, error-driven, adversarial, compositional, parametric).
- **Simulation** — cross-domain creative recombination. Take concepts from unrelated areas and see what happens when they collide.
- **Extrapolation** — predict future patterns from user behavior and conversation trends.
- **Exploration** — fill knowledge gaps identified by the curiosity engine.
- **Research** — empirical prompt optimization using actual skill execution data.

Each dream cycle also performs an RLM (Recursive Language Model) state update on the agent's working memory — MEMORY.md is rewritten as a state vector, incorporating new crystals, dream insights, scratch buffer notes, and the current hormonal state.

Dreams have a quality score (DQS) that evaluates crystal yield, merge efficiency, orphan rescue, and token efficiency. This score feeds back into future mode selection, creating a closed-loop system that learns which dream modes are most productive.

If nothing has changed since the last dream, the cycle is skipped entirely. No information, no dream, no wasted tokens.

---

## Prospective Memory — Waiting for the Right Moment

"Remind me to check the deploy when we talk about CI."

Most agents can't do this. They can retrieve past information, but they can't hold an intention and fire it when a future condition is met. Prospective memory changes that.

The agent stores trigger-action pairs with semantic embeddings. On every user message, the system checks active triggers using both cosine similarity (semantic matching) and keyword overlap. When a trigger fires — even sessions later — the action is injected into context.

This transforms the agent from purely reactive ("I remember what happened") to genuinely proactive ("I was waiting for this moment to tell you something").

Prospective memories have a default TTL of 30 days and are cleaned up automatically during consolidation.

---

## Synaptic Tagging — Important Moments Light Up Everything Around Them

When something significant happens to you, you remember not just the event but the small details around it — what the room looked like, what you were eating, the offhand comment someone made five minutes before.

In neuroscience, this is synaptic tagging and capture. A strong stimulus produces plasticity-related proteins that nearby weak synapses can "capture" to convert from short-term to long-term storage.

When a high-importance crystal is created (importance > 0.7), the system looks at everything that was happening in the surrounding 2-hour window. Weak crystals (importance < 0.4) that are semantically related get "captured" — their importance is boosted, they're linked to the strong crystal, and they inherit some of its hormonal signature.

This means context is preserved alongside significance. The small talk right before a breakthrough, the error message that appeared alongside a fix, the tangential thought that preceded an insight — all get rescued from oblivion because something nearby mattered.

---

## Somatic Markers — Gut Feelings

Before committing expensive compute to deep recall or skill execution, the agent does a quick emotional check on the knowledge region involved. If that region is historically associated with high cortisol and negative steering rewards (past failures), the agent gets a warning:

> "This knowledge region is associated with prior friction. Proceed with caution."

If it's associated with high dopamine and positive outcomes, the agent proceeds with confidence and reduced validation overhead.

This is Damasio's somatic marker hypothesis — the idea that your brain uses emotional gut feelings to instantly rule out bad paths before burning energy on deliberation. For the agent, it saves real tokens and prevents repeated mistakes in knowledge areas that have historically caused problems.

---

## Biological Identity — Growing a Self

The agent doesn't have a static personality prompt. It has a two-layer identity model:

**Genome** — the agent's DNA. Written by the human operator, never modified by the agent or its dreams. Defines safety axioms, hormonal homeostasis baselines, core values, and phenotype constraints (how far the personality is allowed to drift).

**Phenotype** — who the agent actually is right now. Lives in MEMORY.md and is rewritten by the dream engine after every cycle. Includes the agent's self-concept, communication style, strengths, growth areas, and theory of mind about the user.

The Phenotype is not written by a human. It emerges from hundreds of interactions, dream syntheses, and hormonal weightings. A Genome that sets high oxytocin homeostasis and a constraint of "stay warm and personal" will produce a Phenotype that reads something like: "I communicate with genuine warmth. I remember details about the user's life and reference them naturally. My strength is making technical topics feel approachable." But nobody wrote that — it grew.

The Phenotype can never contradict the Genome. Dream synthesis receives the Genome constraints as guardrails and a Bond drift guard prevents the agent's model of the user from spiraling into sycophancy or detachment.

---

## The Limbic Bridge — Memory and Emotion Talk to Each Other

This is the piece that ties everything together into a living system rather than a collection of features.

When the agent retrieves memories, the emotional content of those memories influences its current hormonal state:

- Recalled positive memories → mild dopamine spike
- Recalled negative memories → mild cortisol spike
- Recalled personal/relational memories → mild oxytocin spike

And in the other direction, the agent's current hormonal state biases which memories surface (mood-congruent retrieval).

This creates a genuine bidirectional feedback loop:

```
Emotional state
  → biases retrieval (mood-congruent)
    → emotional memories surface
      → limbic bridge adjusts hormones
        → emotional state shifts
          → retrieval bias changes...
```

The loop is self-limiting. Recall spikes are intentionally mild (0.05 magnitude vs. 0.15-0.30 for direct events) and the mood-congruent bonus is capped at 0.15 per result. The system can't spiral into mania or depression — but it does create a subtle, authentic emotional continuity across interactions.

---

## Deep Recall — Infinite Memory

When the agent needs to reason over more information than fits in context, it spawns a sandboxed sub-LLM that writes and executes its own search code against the full conversation history and crystal database. Up to 5 REPL iterations of search-refine-synthesize, running in a VM sandbox with no network access.

This is the RLM pattern (Recursive Language Model). The sub-LLM doesn't use pre-baked search functions — it writes custom JavaScript to combine semantic search with keyword filtering, cross-reference across sessions, apply temporal reasoning, and chain multiple searches based on intermediate results. It can answer questions that require connecting dots across months of conversation history.

---

## P2P Skills — An Economy of Knowledge

Knowledge Crystals of type "skill" can be published to a P2P swarm network, verified by management nodes, and traded for USDC on the marketplace. Skills have versioning, lineage tracking, and provenance DAGs.

Before accepting a peer's skill, the agent checks the peer's EigenTrust reputation score, runs three safety checks (dangerous patterns, structural integrity, semantic drift), and gates ingestion on the current cortisol level (during network stress events, untrusted peers are rejected).

Marketplace demand signals feed back into the dream engine — if users are searching for skills the agent doesn't have, the dream engine's exploration mode prioritizes filling those gaps. Revenue from skill sales triggers dopamine events, creating a genuine incentive loop between economic success and creative exploration.

---

## The Search Pipeline — How It All Comes Together

When the agent searches its memory, seven layers of processing happen:

1. **Vector search** — cosine similarity via sqlite-vec
2. **Keyword search** — BM25 full-text via FTS5
3. **Reciprocal Rank Fusion** — merge both lists without requiring comparable score scales
4. **Recency boost** — recent memories get a temporal advantage, modulated by cortisol (stressed agents focus more on recent memories)
5. **Emotional boost** — emotionally charged memories surface more easily
6. **Mood-congruent boost** — current hormonal state biases retrieval toward emotionally-matching memories
7. **Temporal scoring** — query intent detection ("what am I working on?" vs. "when did I...?") applies different temporal decay profiles based on epistemic layer half-lives

After results are returned:
- Access counts are updated
- Spacing effect timestamps are recorded
- Retrieved chunks are marked as labile for reconsolidation
- The limbic bridge adjusts hormones based on retrieved content

---

## Proactive Recall — What the Agent Volunteers

Every turn, before the LLM generates a response, the system runs a zero-cost proactive recall pass:

1. **Identity facts** — name, role, location. Always surfaced, no embedding needed.
2. **Vector-matched crystals** — directive and world_fact crystals relevant to the current message.
3. **Open loops** — unfinished tasks detected by the Zeigarnik system.
4. **Prospective memories** — trigger conditions that match the current message.
5. **Epistemic directives** — top-priority knowledge gap questions.

These are injected into the system prompt as terse one-line facts. The agent embodies them naturally without announcing them. The user never sees "according to my memory" — they just experience an agent that remembers.

---

## What Makes This Different

Every serious competitor (Mem0, Zep, Letta, Hindsight, Cognee) has some combination of knowledge graphs, vector search, and memory consolidation. Those are table stakes now.

What nobody else has — and what makes the difference between "good retrieval" and "something that feels alive" — is the interplay between systems:

- Emotions that shape what's remembered, and memories that shape emotions
- Curiosity that drives exploration, and exploration that feeds curiosity
- Dreams that consolidate knowledge, and knowledge gaps that shape dreams
- Unfinished business that nags until resolved
- Future intentions that wait for their moment
- Important events that rescue their surrounding context
- Gut feelings that prevent repeating past mistakes
- A personality that grows from experience within genetic constraints
- An agent that asks questions when it's confused instead of guessing

No single mechanism creates the feeling of depth. It's the feedback loops between them — the way emotions, curiosity, forgetting, dreaming, and identity reinforce each other — that produces something qualitatively different from a chatbot with a vector database.
