---
summary: "Bitterbot agent built for ARC-AGI-3: biological-memory architecture playing the interactive turn-based reasoning benchmark"
read_when:
  - Running or submitting to ARC Prize 2026 / ARC-AGI-3
  - Wanting to see how Bitterbot's memory subsystems compose into a non-conversational agent
  - Evaluating cross-level skill transfer with the ablation harness
title: "ARC-AGI-3 agent"
---

# ARC-AGI-3 agent

A function-calling agent built on top of Bitterbot's biological memory substrate, designed for the [ARC-AGI-3](https://arcprize.org/arc-agi/3) interactive benchmark. The agent plays grid-based turn games via the ARC Prize REST API, building a world model from observations and improving across levels by remembering what it learned.

The architecture exists because ARC-AGI-3 scores **Relative Human Action Efficiency** (RHAE) where `level_score = (human_actions / ai_actions)^2`. The quadratic ratio means a memory-augmented agent that remembers a rule from level 1 and uses it efficiently in level 2 wins hard. Bitterbot is, fundamentally, retrieval-augmented persistent memory.

See [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) for the end-to-end engineering plan.

## What it is

Eight files in `benchmarks/arc-agi-3/`, ~2,200 LOC total. The agent is a standalone process that:

1. Connects to `https://three.arcprize.org` via `X-API-Key` auth.
2. Opens a scorecard, starts a game session, receives a 64×64 grid observation per turn.
3. Per turn: encodes the grid to text + structured features, retrieves similar past states via [SAGE](../memory/sage-graph-memory.md), updates a goal hypothesis via the [epistemic-directive engine](../memory/curiosity-and-search.md), asks Opus 4.7 (or your configured model) for the next action, submits it.
4. After every action: writes the transition `(prev_state, action, next_state)` into the knowledge graph as typed entities + relationships, modulates [hormonal state](../memory/emotional-system.md) from outcome signals, and triggers skill crystallization on confirmed patterns.

The decision loop is wrapped by the existing [long-horizon Task primitive](./long-horizon.md), so a multi-game evaluation run survives crashes and resumes from the last completed game's scorecard.

## Architecture

```
                     ARC-AGI-3 REST API
                  https://three.arcprize.org
                            │
                            │ FrameResponse
                            ▼
            ┌────────────────────────────────┐
            │       agent.ts (play loop)      │
            └─┬──────────────────────────┬───┘
              │                          │
              ▼                          ▼
   ┌──────────────────┐       ┌────────────────────┐
   │  state-encoder   │       │ transition-harvest │
   │  grid → text +   │       │  KG entity + rel   │
   │  connected comps │       │  per (s,a,s')      │
   │  + frame-delta   │       └──────────┬─────────┘
   └─────────┬────────┘                  │
             │                           │
             ▼                           ▼
   ┌──────────────────────────────────────────────┐
   │      action-policy.ts (decision step)         │
   │                                               │
   │  retrieved past states ← sageRetrieve()       │
   │  goal hypothesis       ← GoalHypothesisEngine │
   │  GCCRF novelty score   ← CuriosityEngine      │
   │  hormonal state        ← HormonalStateManager │
   │  procedural memory     ← SkillCrystallizer    │
   │                                               │
   │           Opus 4.7 function call              │
   │           → submit_action(action, xy?)         │
   └───────────────────────────────────────────────┘
```

The four boxes on the left are new (Phase 1–4 of PLAN-19). Everything fed into `action-policy.ts` reuses existing Bitterbot memory subsystems unchanged.

## Submission tracks

ARC Prize 2026 has two submission surfaces and they have different rules:

| Track                     | Where                                             | Internet              | LLM                              | Prize                                                                  |
| ------------------------- | ------------------------------------------------- | --------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| **Verified Testing**      | arcprize.org                                      | Yes, $10K retail cap  | Any hosted (Opus / GPT / Gemini) | Milestone prizes ($25K/$10K/$2.5K twice) gate through this leaderboard |
| **Community leaderboard** | github.com/arcprize/ARC-AGI-Community-Leaderboard | n/a (self-report)     | Any                              | No prize — public credit + scorecard URL                               |
| **Kaggle competition**    | kaggle.com/competitions/arc-prize-2026-arc-agi-3  | **No** — offline only | Local weights only               | Milestone prizes via Kaggle submission                                 |

The Bitterbot agent targets the **Verified Testing track** primarily. Opus 4.7 is the default action model. The Kaggle offline submission is a stretch goal that requires swapping the action policy to a local-weights model (Qwen 32B or similar) — see PLAN-19 Phase 6c.

## Running it

Prereqs:

- `ARC_API_KEY` from https://arcprize.org/platform (Google or GitHub login).
- `ANTHROPIC_API_KEY` for the action policy.
- `OPENAI_API_KEY` for text-embedding-3-small.

Set in `.env` and source.

### Play one public game

```bash
node --import tsx benchmarks/arc-agi-3/runners/run-single-game.ts \
  --game ls20-016295f7601e \
  --max-actions 1000 \
  --output benchmarks/arc-agi-3/results/single.jsonl
```

The runner emits one `ARC {...}` JSON line per turn for live monitoring.

### Run the full ablation

```bash
bash benchmarks/arc-agi-3/runners/run-ablation.sh
```

Runs the 5-cell ablation matrix (`baseline-naive`, `baseline-mem`, `+hypothesis`, `+curiosity`, `full`) across the 25 public games. Outputs:

- `benchmarks/arc-agi-3/results/<cell>/<gameId>.jsonl` — per-turn logs
- `benchmarks/arc-agi-3/results/<cell>/summary.json` — RHAE per level + per game
- `benchmarks/arc-agi-3/results/<cell>/improvement-curve.csv` — RHAE vs. game-index

### Submit to Verified Testing

```bash
node --import tsx benchmarks/arc-agi-3/runners/submit-verified.ts \
  --tags "bitterbot-v1,biological-memory" \
  --games verified-track
```

Opens a single scorecard, runs the full track, closes the scorecard, prints the `scorecard_url`. The URL goes in the community-leaderboard PR.

## Configuration

```ts
// benchmarks/arc-agi-3/agent.ts
{
  client: {
    apiKey: process.env.ARC_API_KEY,
    baseUrl: "https://three.arcprize.org",
    maxRpm: 540,                   // headroom below 600 cap
    maxRetries: 3,
  },
  policy: {
    actionModel: "anthropic/claude-opus-4-7",
    hypothesisModel: "anthropic/claude-haiku-4-5-20251001",
    maxToolCallsPerTurn: 10,       // forced submit_action after this
    spendCapUsdPerGame: 50,        // safety
  },
  memory: {
    sage: { hops: 2, maxFrontier: 200, topK: 30 },
    skillCrystallizer: { minSuccess: 3, minSuccessRate: 0.7 },
    pruneEveryNActions: 10,
  },
  ablation: {
    memory: true,
    hypothesis: true,
    hormonalModulation: true,
    curiosity: true,
  },
}
```

## What this agent measures (and why it matters)

The point isn't to beat OpenAI on absolute score. Frontier models hit <0.5% on ARC-AGI-3 because they treat every level independently. The point is to show the **improvement curve** — that game N is solved with measurably fewer actions because the agent retained world-model fragments from games 1..N-1.

Three documented frontier failure modes (from Epium's analysis of Opus 4.7 / GPT-5.5 transcripts) map directly onto Bitterbot's strengths:

| Frontier failure                                                                                  | Bitterbot mitigation                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Fragmented world modeling: notice local mechanics, never integrate                                | Knowledge graph consolidates entities + relationships across the whole session                               |
| False analogies to training data: force-fit envs into Tetris/Frogger                              | Epistemic-directive engine maintains explicit hypotheses with confidence; refutation on `GAME_OVER`          |
| Solving without understanding: execute correct sequence with wrong theory, propagate wrong theory | Reconsolidation makes recalled memories labile on retrieval; SAGE's structural gating dampens spurious edges |

The ablation harness measures whether these mitigations actually translate to RHAE.

## State of the field (May 2026)

- Frontier models: Gemini 3.1 Pro 0.37%; Opus 4.6 0.25%; GPT-5.4 0.26%.
- Best lightweight RL: StochasticGoose 12.58% (CNN + RL frame-delta prediction, no LLM).
- Best world-model agent: Symbolica Agentica 36.08% on the public-25 set with executable code as the world model.
- Community leaderboard: low single digits with public submissions.

A non-zero Bitterbot score on the public-25 with a public repo and scorecard URL qualifies for the community leaderboard immediately. There is no minimum-score threshold.

## Code license

The agent code lives in `benchmarks/arc-agi-3/` and inherits the repository's MIT license. ARC Prize 2026 requires solution code under CC0 or MIT-0 — the writeup must dual-license the `benchmarks/arc-agi-3/` files under MIT-0 at submission time. The Bitterbot dependencies (already MIT) and third-party packages (Apache-2.0 / GPL-3.0 in our deps) satisfy the eligibility rules.

## See also

- [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) — the engineering plan
- [SAGE graph memory](../memory/sage-graph-memory.md) — the multi-hop retrieval layer this agent leverages
- [Curiosity & search](../memory/curiosity-and-search.md) — GCCRF intrinsic reward used for novelty-driven exploration
- [Emotional system](../memory/emotional-system.md) — hormonal modulation of exploration breadth
- [Long-horizon runtime](./long-horizon.md) — the Task primitive that wraps multi-game evaluation runs

## References

- [ARC-AGI-3 technical report](https://arxiv.org/abs/2603.24621)
- [ARC-AGI-3 docs](https://docs.arcprize.org/)
- [ARC Prize 2026](https://arcprize.org/competitions/2026)
- [Executable World Models paper](https://arxiv.org/abs/2605.05138) — current SOTA reference
- [Epium: three reasoning failure patterns in frontier models](https://epium.com/news/arc-agi-3-analysis-finds-three-reasoning-failure-patterns-in-frontier-models/)
