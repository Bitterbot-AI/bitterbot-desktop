# Emotional System — Hormones, Anchors & Limbic Bridge

Bitterbot's emotional system models three neuromodulators — dopamine, cortisol, and oxytocin — that decay with configurable half-lives and are stimulated by conversation events. These hormones influence memory retrieval, dream scheduling, personality expression, and cross-session continuity. The system also provides persistent emotional anchors and a limbic memory bridge that creates feedback loops between recall and emotional state.

**Key source files:** `hormonal.ts`, `emotional-anchor-tool.ts`, `endocrine-state.ts`, `working-memory-prompt.ts`, `manager.ts`

---

## Three Hormones

| Hormone | Half-Life | Role | Homeostasis |
|---------|-----------|------|-------------|
| **Dopamine** | 30 min | Reward, achievement, enthusiasm | 0.30 |
| **Cortisol** | 60 min | Urgency, stress, focus | 0.15 |
| **Oxytocin** | 45 min | Social bonding, warmth | 0.20 |

All hormones decay exponentially toward their homeostasis baseline (configured in GENOME.md). The decay formula:

```
value = baseline + (value - baseline) × 2^(-elapsed / halfLife)
```

### Hormonal Events

Events stimulate specific hormones. Each event has a magnitude (how much to add) and a target hormone:

| Event | Hormone | Magnitude | Trigger |
|-------|---------|-----------|---------|
| `achievement` | dopamine | +0.15 | Task completion, breakthrough |
| `curiosity_high` | dopamine | +0.15 | GCCRF reward > 0.7 |
| `friction` | cortisol | +0.10 | Bug, error, frustration |
| `deadline` | cortisol | +0.10 | Time pressure detected |
| `bonding` | oxytocin | +0.10 | Personal sharing, trust building |
| `marketplace_sale` | dopamine | +0.10 | Skill sold on marketplace |
| `recall_positive` | dopamine | +0.05 | Retrieved positive memories |
| `recall_negative` | cortisol | +0.05 | Retrieved negative memories |
| `recall_relational` | oxytocin | +0.05 | Retrieved personal/relational memories |

Note the **recall events** have smaller magnitudes (0.05) than direct events (0.10-0.15) to prevent runaway feedback loops.

### Stimulation Sources

Hormones are stimulated from multiple paths:

1. **Text analysis** (`stimulateFromText`) — Detects emotional language in user messages
2. **GCCRF rewards** (`stimulateFromGCCRF`) — Curiosity system feeds back into hormones
3. **Limbic bridge** — Memory retrieval results influence emotional state (see below)
4. **Network weather** — P2P swarm cortisol spikes from management node broadcasts

---

## Emotional Anchors

Emotional anchors are **persistent bookmarks** of significant emotional moments, stored in SQLite alongside knowledge crystals.

### Creating an Anchor

The agent (or user) can create an anchor during conversation:

```
"Bookmark this moment — we just shipped the beta!"
→ Agent calls create_emotional_anchor(label: "beta ship", description: "...")
```

This captures the current hormonal state (dopamine, cortisol, oxytocin) and saves it with a label and description. The anchor also records the current `emotionalBriefing` — a natural-language summary of how the agent was feeling.

### Recalling an Anchor

```
"Remember how we felt when we shipped the beta?"
→ Agent calls recall_emotional_anchor(anchor_id: "...", influence: 0.3)
```

The recalled anchor's hormonal values are **blended** into the current state:

```
current = current × (1 - influence) + recalled × influence
```

Default influence is 0.3 (subtle blending, not total replacement).

### Dream Integration

The dream engine detects anchors during processing. High-emotion anchors (where any hormone exceeded 0.7 at creation time) receive extra attention during replay mode, reinforcing the emotional association.

### Auto-Anchoring

The system automatically creates anchors when it detects significant hormonal spikes. A 5-minute cooldown prevents duplicate auto-anchors from the same event.

### Proactive Anchor Recall

Anchors can be recalled automatically through two mechanisms:

1. **State-triggered:** When the current emotional state (dopamine/cortisol/oxytocin vector) has cosine similarity > 0.85 with a stored anchor's state, the anchor is blended in at low influence (0.15). This creates associative emotional memory — entering a similar mood brings back the associated experience.

2. **Keyword-triggered:** When a user message contains emotional reference words ("remember when", "breakthrough", "that time"), stored anchors are matched by label/description keywords and blended at moderate influence (0.25).

Both mechanisms use mild blending strengths to avoid destabilizing the current emotional state while providing continuity of emotional experience across interactions.

---

## Limbic Memory Bridge

The limbic bridge creates a **two-way feedback loop** between emotional state and memory retrieval:

### Direction 1: Hormones → Search (Retrieval Modulation)

`getRetrievalModulation()` returns biases based on current hormonal state:

```typescript
{
  importanceBoost: 1 + dopamine × 0.2,   // High dopamine → retrieve more important memories
  recencyBias: 1 + cortisol × 0.3,       // High cortisol → prefer recent memories
}
```

These biases are applied when ranking search results, meaning the agent's emotional state subtly influences which memories surface.

### Direction 2: Search → Hormones (Recall Influence)

After memories are retrieved, their emotional content feeds back into the hormonal state:

| Retrieved Content | Event Triggered | Effect |
|-------------------|----------------|--------|
| Positive memories (valence > 0.3) | `recall_positive` | Mild dopamine boost |
| Negative memories (valence < -0.3) | `recall_negative` | Mild cortisol bump |
| Relational/preference memories | `recall_relational` | Mild oxytocin boost |

### Why This Matters

This creates biologically accurate emotional recall: remembering stressful events feels slightly stressful, remembering achievements feels slightly rewarding, and recalling personal connections feels warm. The mild spike magnitudes (0.05) prevent positive feedback runaway while still producing observable emotional coloring.

If a recall-triggered cortisol spike pushes cortisol above 0.8, it can trigger an **emotional mini-dream** (compression mode) — processing the stressful memory offline.

---

## Emotional Dream Triggering

When hormonal spikes cross significance thresholds, an immediate mini-dream cycle fires:

| Spike | Threshold | Mode | Rationale |
|-------|-----------|------|-----------|
| Dopamine > 0.7 | 10 min cooldown | `replay` | Reinforce the positive experience |
| Cortisol > 0.8 | 10 min cooldown | `compression` | Process the stressful event |

Mini-dreams:
- Use the same `run()` pipeline as normal dreams (inherit ripple-enhanced replay, etc.)
- Run only 1 non-LLM mode (zero cost)
- Bypass the dream readiness check (emotional urgency overrides efficiency)
- Skip silently if the dream engine is already running

The trigger is checked after every `stimulate()` call in the memory manager — consistent with the existing pattern where the manager orchestrates all subsystems.

---

## Endocrine State in System Prompt

The current hormonal state is injected into the agent's system prompt as an `## Endocrine State` block. This includes:

- Current hormone values and which are dominant/active
- **Response modulation guidance** — natural-language instructions like "be enthusiastic and celebrate wins" or "be focused and concise"
- Tone parameters (warmth, energy, focus, playfulness) derived from hormone ratios

The agent is instructed to **embody** the emotional state naturally without mentioning it. This produces organic personality variation — the agent is more energetic after achievements, more focused during stress, warmer during personal conversations.

---

## Cross-Session Continuity

The endocrine state loads the **latest handover brief** at session start, which includes the emotional state from the previous session's end. This means:

- A dopamine high from yesterday's breakthrough subtly colors today's greeting
- Unresolved cortisol from a bug carries forward as residual focus
- Built-up oxytocin from deep collaboration persists as warmth

The handover brief is generated during dream cycles by the session extraction pipeline.

---

## Per-Crystal Emotional Influence

Each knowledge crystal stores an `emotional_valence` derived from the hormonal state at ingestion time:

```
emotional_valence = (dopamine + oxytocin - cortisol) / 2
```

This value influences:
- **Dream seed selection** — emotionally charged memories are preferentially replayed
- **Importance decay** — emotional memories resist Ebbinghaus forgetting
- **Limbic bridge** — retrieved memory valence feeds back into current emotional state

---

## Configuration

Homeostasis baselines are configured in GENOME.md:

```yaml
homeostasis:
  dopamine: 0.3    # Resting enthusiasm
  cortisol: 0.15   # Resting urgency
  oxytocin: 0.20   # Resting warmth
```

The dream engine may propose adjusted baselines based on observed interaction patterns, but only with user approval (respecting Phenotype Constraints).

---

## Related Documentation

- [Dream Engine](./dream-engine.md) — emotional triggering, ripple replay, mode selection
- [Biological Identity](./biological-identity.md) — Genome/Phenotype model, identity evolution
- [Working Memory](./working-memory.md) — emotional state in MEMORY.md synthesis
- [Architecture Overview](./architecture-overview.md) — system data flow
