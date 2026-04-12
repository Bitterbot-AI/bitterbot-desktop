# Curiosity Reward Function (GCCRF)

## What Is GCCRF?

The Geodesic Crystal-Field Curiosity Reward Function (GCCRF) is Bitterbot's intrinsic curiosity system, integrated into the unified `CuriosityEngine`. It scores every new piece of information the agent encounters on a 0-to-1 scale of "how curious should I be about this?"

Unlike simple keyword matching or random exploration, the curiosity engine computes curiosity from five neuroscience-grounded components that together model how biological curiosity actually works. The GCCRF reward function is invoked internally by `CuriosityEngine.assessChunk()` — there is no separate scoring path.

## The Five Components

### 1. Prediction Error ("How surprising is this?")

When new information arrives, GCCRF measures how far it is from what the agent already knows. Information that fits neatly into an existing knowledge region scores low. Information that's far from anything the agent has seen scores high.

### 2. Learning Progress ("Am I getting better at understanding this area?")

For each knowledge region, the agent tracks whether it's getting less surprised over time. If prediction errors are decreasing in a region, the agent is learning. This component rewards active learning zones and deprioritizes areas where the agent is stuck or already understands.

### 3. Information-Theoretic Novelty ("How rare is this part of my knowledge space?")

This is GCCRF's most distinctive feature. It uses density estimation to determine how crowded or sparse a region of knowledge space is.

**The developmental twist**: A young agent (few dream cycles completed) is rewarded for exploring _common_ things -- building foundational understanding, like a baby fixating on faces. As the agent matures, it shifts to being rewarded for exploring _rare_ things -- frontier territory, like a researcher seeking the unknown.

This transition happens automatically through **alpha annealing**: a parameter that smoothly shifts the density reward from "common is interesting" to "rare is interesting" over the agent's lifetime.

### 4. Empowerment ("Does knowing this give me more agency?")

Knowledge that bridges multiple different knowledge regions and semantic types has high empowerment -- it opens diverse pathways for future action. Knowledge that only touches one narrow area has low empowerment.

This component is gated by an **interoceptive modulator**: when the agent's prediction errors are volatile (it's confused), the empowerment signal amplifies -- "seek agency when disoriented." When errors are stable, empowerment is dampened.

### 5. Strategic Alignment ("Does this match what I'm trying to learn?")

This measures how well new information aligns with the agent's active exploration targets -- specific knowledge gaps or frontiers the curiosity engine has identified. It closes the loop: the agent generates curiosity targets, then rewards information that helps fulfill them.

## How It Affects the Agent

### Dream Cycles

GCCRF rewards directly influence which memories the Dream Engine selects as seeds for dream cycles. Higher curiosity reward = more likely to be dreamed about = more likely to generate insights.

Each GCCRF component also influences which _mode_ the Dream Engine uses:

- High prediction error --> Exploration mode
- High learning progress --> Compression mode (consolidate what's being learned)
- High novelty --> Simulation mode (cross-domain connections)
- High empowerment --> Mutation mode (optimize skills)
- High strategic alignment --> Research mode (goal-directed investigation)

### Hormonal Feedback

High GCCRF rewards trigger dopamine spikes (discovery/achievement). High learning progress triggers mastery signals. Sustained low rewards cause mild stress (stagnation). High empowerment on relational memories triggers oxytocin (the agent is learning about its human).

### Memory Consolidation

Chunks with high curiosity rewards resist decay longer during consolidation. The curiosity engine uses GCCRF signals to generate and retire exploration targets -- areas the agent should investigate or can stop worrying about.

## Developmental Annealing

The alpha parameter controls the agent's developmental stage:

| Alpha Range  | Stage      | Behavior                                  |
| ------------ | ---------- | ----------------------------------------- |
| -3.0 to -1.5 | Infant     | Curious about common, foundational things |
| -1.5 to -0.5 | Adolescent | Transitioning from common to novel        |
| -0.5 to 0.0  | Mature     | Curious about rare, frontier things       |

Maturity is tied to **dream cycles completed**, not raw data volume. This prevents bulk file imports from "speedrunning" the agent's childhood -- maturity tracks actual consolidation and reflection.

## Configuration

GCCRF configuration is set in the `memory.gccrf` section of the Bitterbot config:

| Setting                | Default                          | Description                                                       |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `weights`              | `[0.25, 0.20, 0.25, 0.20, 0.10]` | Component weights (eta, deltaEta, iAlpha, empowerment, strategic) |
| `alphaStart`           | `-3.0`                           | Alpha at birth (rewards commonality)                              |
| `alphaEnd`             | `0.0`                            | Alpha at maturity (rewards novelty)                               |
| `expectedMatureCycles` | `100`                            | Dream cycles to full maturity                                     |
| `kdeK`                 | `50`                             | Neighbors for density estimation                                  |
| `empowermentK`         | `30`                             | Neighbors for empowerment computation                             |
| `muGain`               | `5.0`                            | Interoceptive modulator sensitivity                               |
| `muThreshold`          | `0.3`                            | Interoceptive modulator threshold                                 |

## FSHO Oscillator Coupling

The Dream Engine's **FSHO oscillator** (Fractional Stuart-Landau Hopf Oscillator) provides a complementary signal to GCCRF for dream mode selection. While GCCRF tells the agent what it _needs to learn_, the FSHO order parameter R tells the agent what the _memory landscape looks like_:

- **GCCRF high prediction error + FSHO low R** → Both agree: explore (scattered, surprising memories)
- **GCCRF high learning progress + FSHO high R** → Both agree: compress (coherent, consolidating memories)
- **GCCRF wants exploration + FSHO wants compression** → Disagreement resolved via weighted normalization (0.3 GCCRF, 0.4 FSHO × validation factor, 0.3 curiosity heuristics)

**FSHO alpha coupling (implemented):** The FSHO order parameter R informs alpha annealing via a running EMA: `effective_alpha = base_alpha + 0.5 × (R_avg - 0.5)`. High R (coherent memory set) shifts alpha toward frontier-seeking; low R shifts toward consolidation. The FSHO signal is also **self-validating** — `computeFshoWeightAdjustment()` checks Pearson correlation between R and DQS, scaling FSHO's mode selection weight between 0.5x (noise) and 1.5x (validated).

### Maturity Calculation

Maturity is now computed from multiple factors rather than dream cycles alone:

- Dream cycles completed (primary signal)
- Knowledge crystal count and diversity
- Exploration target resolution rate
- Bond stability (Jaccard overlap history)

This prevents both "speedrunning" via bulk imports and stalling on a single factor.

### Exploration Target TTL

Exploration targets expire after **48 hours** (reduced from 168h). This prevents stale targets from accumulating and biasing dream mode selection toward exploration when the knowledge gaps may no longer be relevant.

## Dashboard

The Dream Engine dashboard includes a "Curiosity" tab showing:

- Current alpha value and maturity percentage
- All five GCCRF components with their current mean values
- Per-region learning progress (which topics are improving?)
- Reward history chart
- Active exploration targets and their alignment scores

## Related Documentation

- [Dream Engine](./dream-engine.md) — GCCRF mode adjustments, FSHO coupling
- [Architecture Overview](./architecture-overview.md) — full system data flow
- [Knowledge Crystals](./knowledge-crystals.md) — curiosity_reward column (unified scoring)
- [Emotional System](./emotional-system.md) — GCCRF → hormonal feedback loop
