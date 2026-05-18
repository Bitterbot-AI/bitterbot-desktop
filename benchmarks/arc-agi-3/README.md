# ARC-AGI-3 Agent (PLAN-19)

Bitterbot's agent for [ARC Prize 2026 / ARC-AGI-3](https://arcprize.org/competitions/2026/arc-agi-3).

The agent plays the interactive turn-based reasoning benchmark using Bitterbot's existing memory subsystems (knowledge graph, SAGE retrieval, curiosity engine, epistemic directives, hormonal modulation) wrapped around an LLM action policy. Built per [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md).

For the public-facing architecture overview see [docs/agents/arc-agi-3.md](../../docs/agents/arc-agi-3.md). For the submission process see [SUBMISSION.md](./SUBMISSION.md).

## Status

| Phase | Component                               | Status      |
| ----- | --------------------------------------- | ----------- |
| 1     | `arc-client.ts` — REST client           | Not started |
| 2     | `state-encoder.ts` — grid → text        | Not started |
| 3     | `transition-harvester.ts` — KG wiring   | Not started |
| 4a    | `goal-inference.ts` — hypothesis engine | Not started |
| 4b    | `action-policy.ts` — LLM decision       | Not started |
| 5a    | `agent.ts` — play loop                  | Not started |
| 5b    | `ablation.ts` — 5-cell ablation         | Not started |
| 6     | Submission + writeup                    | Not started |

The plan target is **Milestone #1 (June 30, 2026)** on the Verified Testing track.

## Layout

```
benchmarks/arc-agi-3/
├── README.md                       # this file
├── SUBMISSION.md                   # submission process for both tracks
├── arc-client.ts                   # REST client (Phase 1)
├── state-encoder.ts                # grid → text (Phase 2)
├── transition-harvester.ts         # KG wiring (Phase 3)
├── goal-inference.ts               # hypothesis engine (Phase 4a)
├── action-policy.ts                # LLM action decision (Phase 4b)
├── agent.ts                        # main play loop (Phase 5a)
├── ablation.ts                     # ablation harness (Phase 5b)
├── types.ts                        # FrameResponse, ScorecardSummary, etc.
├── errors.ts                       # ArcApiError, BadGuidError, RateLimitError
├── runners/
│   ├── run-single-game.ts
│   ├── run-ablation.sh
│   └── analyze-runs.ts
├── tests/                          # vitest unit + integration tests
├── fixtures/
│   ├── frame-response-samples/     # captured real FrameResponses
│   └── recorded-games/             # full game replays for offline testing
├── results/                        # per-run JSONL output (gitignored)
└── kaggle/
    └── notebook.ipynb              # offline submission variant (Phase 6c stretch)
```

## Quick start (once implemented)

Prerequisites:

```bash
# In .env (gitignored)
ARC_API_KEY=...        # from https://arcprize.org/platform
ANTHROPIC_API_KEY=...  # action-policy LLM
OPENAI_API_KEY=...     # embeddings
```

Play one public game:

```bash
set -a && source .env && set +a
node --import tsx benchmarks/arc-agi-3/runners/run-single-game.ts \
  --game ls20-016295f7601e \
  --max-actions 1000 \
  --output benchmarks/arc-agi-3/results/single.jsonl

# Live monitor:
tail -F benchmarks/arc-agi-3/results/single.jsonl
```

Run the 5-cell ablation across all 25 public games:

```bash
bash benchmarks/arc-agi-3/runners/run-ablation.sh
```

## Key facts about the benchmark

- **API:** `https://three.arcprize.org`, `X-API-Key` auth, 600 RPM limit, AWSALB sticky cookies per `guid`.
- **Observation:** 1–N frames of `64×64` int grids (values 0–15).
- **Actions:** `RESET, ACTION1..7`. ACTION1-4 directional; ACTION5 contextual; ACTION6 click-with-(x,y); ACTION7 undo.
- **Scoring:** `level_score = (human_actions / ai_actions)^2`, capped 1.15×, weighted by level number, averaged across games.
- **Game set:** 25 public demo + 55 semi-private + 55 fully-private (135 total). Verified Testing scores against semi+fully-private.
- **Verified Testing cap:** $10K retail per evaluation run.
- **Kaggle cap:** 12h Kaggle GPU wall-clock, no internet.
- **Open-source mandate:** code under CC0 / MIT-0; deps Apache-2.0 / GPL-3.0+.

## Development conventions

- TypeScript via `tsx`. Run from repo root: `node --import tsx benchmarks/arc-agi-3/<file>.ts`.
- Tests via `vitest` matching the repo pattern `*.test.ts`. Run: `pnpm vitest run benchmarks/arc-agi-3/`.
- All files stay under the project's 500-LOC soft cap (`scripts/check-ts-max-loc.ts`).
- New `EntityType` and `RelationType` values added to `src/memory/knowledge-graph.ts` must be additive (extends the union; no existing values removed).
- One single-line `ARC {...}` JSON log line per agent turn, matching the `LME {...}` pattern from `benchmarks/longmemeval/` for monitorability.
- Per-game results land as JSONL in `results/`; per-cell summaries land as JSON.

## See also

- [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) — engineering plan, end-to-end
- [docs/agents/arc-agi-3.md](../../docs/agents/arc-agi-3.md) — public-facing architecture
- [SUBMISSION.md](./SUBMISSION.md) — track-by-track submission process
- [docs/memory/sage-graph-memory.md](../../docs/memory/sage-graph-memory.md) — the memory layer this agent leverages
- [benchmarks/longmemeval/](../longmemeval/) — analogous benchmark structure
