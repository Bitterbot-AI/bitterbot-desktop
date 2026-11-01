# Emotional System — Hormones, Anchors & Limbic Bridge

Bitterbot's emotional system models three neuromodulators — dopamine, cortisol, and oxytocin — that decay with configurable half-lives and are stimulated by conversation events. These hormones influence memory retrieval, dream scheduling, personality expression, and cross-session continuity. The system also provides persistent emotional anchors and a limbic memory bridge that creates feedback loops between recall and emotional state.

**Key source files:** `hormonal.ts`, `emotional-anchor-tool.ts`, `endocrine-state.ts`, `working-memory-prompt.ts`, `manager.ts`

---

## Three Hormones

| Hormone      | Half-Life | Role                            | Homeostasis |
| ------------ | --------- | ------------------------------- | ----------- |
| **Dopamine** | 30 min    | Reward, achievement, enthusiasm | 0.15        |
| **Cortisol** | 60 min    | Urgency, stress, focus          | 0.02        |
| **Oxytocin** | 45 min    | Social bonding, warmth          | 0.20        |

All hormones decay exponentially toward their homeostasis baseline (configured in GENOME.md). The decay formula:

```
value = baseline + (value - baseline) × 2^(-elapsed / halfLife)
```

### Hormonal Events

Events stimulate specific hormones. Each event has a magnitude (how much to add) and a target hormone:

| Event                | Hormone            | Magnitude    | Trigger                                                                                               |
| -------------------- | ------------------ | ------------ | ----------------------------------------------------------------------------------------------------- |
| `reward`             | dopamine           | +0.30        | Positive feedback                                                                                     |
| `achievement`        | dopamine, oxytocin | +0.40, +0.20 | Task completion, breakthrough                                                                         |
| `curiosity_high`     | dopamine           | +0.25        | Curiosity reward > 0.7                                                                                |
| `curiosity_progress` | dopamine           | +0.20        | Learning-progress component (`deltaEta`) > 0.7                                                        |
| `curiosity_aligned`  | dopamine           | +0.10        | Strategic-alignment component > 0.7                                                                   |
| `curiosity_stagnant` | cortisol           | +0.15        | Five consecutive curiosity rewards below 0.2 (one event per run)                                      |
| `curiosity_bonding`  | oxytocin, dopamine | +0.25, +0.10 | Empowerment > 0.6 on a preference, relationship or episode chunk                                      |
| `error`              | cortisol           | +0.30        | Bug, error, frustration                                                                               |
| `urgency`            | cortisol           | +0.40        | Time pressure detected                                                                                |
| `social`             | oxytocin           | +0.30        | Personal sharing, trust building                                                                      |
| `marketplace_sale`   | dopamine, oxytocin | +0.15, +0.05 | Skill sold on marketplace                                                                             |
| `recall_positive`    | dopamine           | +0.05        | Retrieved positive memories                                                                           |
| `recall_negative`    | cortisol           | +0.05        | Retrieved negative memories                                                                           |
| `recall_relational`  | oxytocin           | +0.05        | Retrieved personal/relational memories                                                                |
| `compute_success`    | dopamine           | +0.05        | A compute job you can see succeeded on the pool (rate-limited)                                        |
| `compute_setback`    | cortisol           | +0.05        | A pool worker went offline, the coordinator went away, or embeddings keep falling back (rate-limited) |

Note the **recall events** have smaller magnitudes (0.05) than direct events (0.10-0.40) to prevent runaway feedback loops.

### Stimulation Sources

Hormones are stimulated from multiple paths:

1. **Text analysis** (`stimulateFromText`) — Detects emotional language in user messages
2. **Curiosity rewards** (`stimulateFromGCCRF`) — CuriosityEngine GCCRF scoring feeds back into hormones
3. **Limbic bridge** — Memory retrieval results influence emotional state (see below)
4. **Network weather** — P2P swarm cortisol spikes from management node broadcasts. `handleWeatherEvent` in `skill-network-bridge.ts` calls `applyNetworkCortisolSpike(level, durationMs, reason)`, which sets a timed override rather than adding to the local value: consolidation and the skill-import cortisol gate use `max(local cortisol, override)` until it expires.

### Effect on consolidation

`getConsolidationModulation()` turns the current state into decay resistance for the consolidation pass: `min(0.5, 0.3 × cortisol + 0.2 × dopamine + 0.2 × oxytocin)` (effective cortisol includes a network override), a merge threshold of `0.92 + 0.03 × cortisol` (stricter merging under stress), and `haltUntrustedIngestion` while a network override is active.

Setting `memory.emotional.hormonal.enabled: false` skips the hormonal manager entirely: no Endocrine State block, no anchors, no mini-dreams, no limbic bridge.

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

Anchors reach the dream engine only through the MEMORY.md synthesis prompt: the five most recent anchors are rendered as an `## Input: Emotional History` block (label, age, mood description, recall count, context) with the instruction to use them for The Phenotype and Active Context (`working-memory-prompt.ts`). No dream mode selects or replays chunks by anchor; the anchor's hormone values do not weight replay.

### Auto-Anchoring

The system automatically creates anchors when it detects significant hormonal spikes: `achievement` with dopamine > 0.5, `urgency` with cortisol > 0.6, `curiosity_high` with dopamine > 0.4. A 15-minute cooldown per anchor label prevents duplicate auto-anchors from the same kind of event, and at most 20 anchors are held in memory.

### Proactive Anchor Recall

Anchors are recalled automatically by one mechanism:

**State-triggered:** after each stimulation, when the current emotional state (dopamine/cortisol/oxytocin vector) has cosine similarity > 0.85 with a stored anchor's state, the single best match is blended in at low influence (0.15). This creates associative emotional memory — entering a similar mood brings back the associated experience.

`findAnchorsByKeywords()` (match a message against anchor labels and descriptions) exists on the hormonal manager but has no caller; keyword-triggered recall is not wired. The mild blending strength avoids destabilizing the current emotional state while providing continuity of emotional experience across interactions.

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

| Retrieved Content                  | Event Triggered     | Effect              |
| ---------------------------------- | ------------------- | ------------------- |
| Positive memories (valence > 0.3)  | `recall_positive`   | Mild dopamine boost |
| Negative memories (valence < -0.3) | `recall_negative`   | Mild cortisol bump  |
| Relational/preference memories     | `recall_relational` | Mild oxytocin boost |

### Why This Matters

This creates biologically accurate emotional recall: remembering stressful events feels slightly stressful, remembering achievements feels slightly rewarding, and recalling personal connections feels warm. The mild spike magnitudes (0.05) prevent positive feedback runaway while still producing observable emotional coloring.

If a recall-triggered cortisol spike makes cortisol rise by 0.15 or more since the last check, it can trigger an **emotional mini-dream** (compression mode) — processing the stressful memory offline.

---

## Emotional Dream Triggering

When a hormone rises sharply, an immediate mini-dream cycle fires:

| Spike                                 | Threshold       | Mode          | Rationale                         |
| ------------------------------------- | --------------- | ------------- | --------------------------------- |
| Dopamine rise ≥ 0.15 since last check | 90 min cooldown | `replay`      | Reinforce the positive experience |
| Cortisol rise ≥ 0.15 since last check | 90 min cooldown | `compression` | Process the stressful event       |

The rise threshold is `memory.dream.hormonalTriggerDelta` (default 0.15, shared with auto-scratch) and the cooldown is `memory.dream.miniDreamCooldownMinutes` (default 90). The check compares against the level at the previous check, not an absolute level, so a hormone pinned high by routine stimulation cannot re-fire a mini-dream every tick.

Mini-dreams:

- Use the same `run()` pipeline as normal dreams (inherit ripple-enhanced replay, etc.)
- Run only 1 non-LLM mode (zero cost)
- Bypass the dream readiness check (emotional urgency overrides efficiency)
- Skip silently if the dream engine is not dormant

The trigger is checked after every `stimulate()` call in the memory manager — consistent with the existing pattern where the manager orchestrates all subsystems.

---

## Endocrine State in System Prompt

The current hormonal state is injected into the agent's system prompt as an `## Endocrine State` block. This includes:

- Current hormone values, rounded to one decimal and labelled (`0.5 moderate (DOMINANT)`, `0.1 low (baseline)`), and which are dominant/active
- **Response modulation guidance** — the `briefing` string from `responseModulation()`: natural-language hints like "be enthusiastic and celebrate wins" or "be concise and action-oriented"

The tone parameters behind the briefing (warmth, energy, focus, playfulness, verbosity, curiosity expression, assertiveness, empathy expression) stay internal; only the briefing text is injected. The agent is instructed to **embody** the emotional state naturally without mentioning it. This produces organic personality variation — the agent is more energetic after achievements, more focused during stress, warmer during personal conversations.

---

## Cross-Session Continuity

The endocrine state loads the **latest handover brief** at session start — but only if it's relevant. The **Session Continuity Gate** computes cosine similarity between the brief's purpose and the current context. If the user is doing something completely unrelated (similarity < 0.25), the brief is skipped entirely to prevent stale context pollution.

When the brief passes the gate:

- A dopamine high from yesterday's breakthrough subtly colors today's greeting
- Unresolved cortisol from a bug carries forward as residual focus
- Built-up oxytocin from deep collaboration persists as warmth
- An **entity snapshot** (files, functions, config keys) provides referents for cross-session anaphora
- Briefs older than 48 hours are annotated with their age so the LLM treats them with appropriate skepticism

The handover brief is generated during dream cycles by the session extraction pipeline.

---

## Per-Crystal Emotional Influence

Each knowledge crystal stores an `emotional_valence` derived at ingestion time from the hormonal events detected in its own text (`computeCrystalInfluence`: the keyword patterns above, summed per hormone; session-transcript chunks get +0.1 oxytocin), not from the agent's live state:

```
emotional_valence = clamp(dopamine + oxytocin - cortisol, -1, 1)
```

A result with magnitude below 0.05 is stored as NULL (`deriveValenceFromHormonal` in `manager-embedding-ops.ts`).

This value influences:

- **Dream seed selection** — emotionally charged memories are preferentially replayed
- **Importance decay** — emotional memories resist Ebbinghaus forgetting
- **Limbic bridge** — retrieved memory valence feeds back into current emotional state

---

## Configuration

Homeostasis baselines are configured in GENOME.md (example values; the built-in defaults are 0.15 / 0.02 / 0.20):

```yaml
homeostasis:
  dopamine: 0.3 # Resting enthusiasm
  cortisol: 0.15 # Resting urgency
  oxytocin: 0.20 # Resting warmth
```

Only the operator changes these values; no dream mode reads or proposes homeostasis baselines. Half-lives live in `memory.emotional.hormonal` (`dopamineHalflife`, `cortisolHalflife`, `oxytocinHalflife`, in ms).

---

## Related Documentation

- [Dream Engine](./dream-engine.md) — emotional triggering, ripple replay, mode selection
- [Biological Identity](./biological-identity.md) — Genome/Phenotype model, identity evolution
- [Working Memory](./working-memory.md) — emotional state in MEMORY.md synthesis
- [Architecture Overview](./architecture-overview.md) — system data flow
