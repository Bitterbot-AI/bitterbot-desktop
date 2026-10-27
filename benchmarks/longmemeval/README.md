# LongMemEval Adapter for Bitterbot

Runs the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark (ICLR 2025) against Bitterbot's biological memory system.

## What LongMemEval Tests

500 questions across 5 long-term memory abilities:

| Task                        | Questions | What It Measures                                            |
| --------------------------- | --------- | ----------------------------------------------------------- |
| **Information Extraction**  | 156       | Can you pull specific facts from chat history?              |
| **Multi-Session Reasoning** | 133       | Can you connect information across different conversations? |
| **Temporal Reasoning**      | 133       | Can you answer time-dependent questions?                    |
| **Knowledge Updates**       | 78        | Can you handle outdated/changed information?                |
| **Abstention**              | 30        | Do you know when you DON'T have the answer?                 |

## Quick Start

```bash
# 1. Download the data (one-time)
pnpm benchmark:longmemeval:download

# 2. Run the benchmark
pnpm benchmark:longmemeval

# 3. Run with oracle (evidence-only) sessions for comparison
pnpm benchmark:longmemeval --oracle

# 4. Evaluate with LongMemEval's official scorer (requires Python + OpenAI key)
pnpm benchmark:longmemeval:evaluate
```

### Retrieval-only baseline with per-channel attribution (PLAN-58)

```bash
pnpm benchmark:longmemeval:retrieval            # LongMemEval-S, Recall@5 / Recall@10
pnpm benchmark:longmemeval:retrieval -- --oracle
```

`runner-retrieval.ts` does no answer generation. Since every search result
now carries `channels` (rank and native score per vector / keyword / graph
channel), the runner also reports, from the same fused list, what each
channel alone would have recalled at K and which channel(s) found the gold
chunk (`vector-only`, `keyword-only`, `graph-only`, `multi`). The output
JSON records the git commit it measured, so a saved run is the frozen
baseline any later retrieval change is compared against.

Saved runs (LongMemEval-S, first 50 questions, all `single-session-user`, quiet bridge):

| metric                            | `bitterbot_longmemeval_s_retrieval.json` (code 9708d2d1, AND-joined FTS) | `..._2026-10-27_keyword-or.json` (code b7e5d70f, OR-joined FTS) |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| questions scored                  | 49 (one lost to the empty-embedding NOT NULL bug)                        | 50                                                              |
| R@5 / R@10                        | 98.0% / 100%                                                             | 100% / 100%                                                     |
| vector R@5                        | 98.0%                                                                    | 98.0%                                                           |
| keyword R@5 / R@10                | 0.0% / 0.0%                                                              | 100% / 100%                                                     |
| attribution of the top-5 gold hit | vector-only 98%, none 2%                                                 | multi 100%                                                      |

The vector channel did not change between the two runs; the difference is that the keyword channel now takes part at all. On this slice it agrees with the vector channel on every gold session, which is what the fused score should reflect.

## How It Works

1. **Ingest**: Each question's chat history is converted to timestamped session files and ingested through Bitterbot's normal memory pipeline (chunk → embed → store with temporal metadata)
2. **Query**: Each question is run through our memory search (hybrid vector + keyword + importance weighting)
3. **Answer**: Retrieved context is passed to the LLM to generate an answer
4. **Score**: Results are saved as JSONL for LongMemEval's GPT-4o evaluation script

## Architecture

```
longmemeval/
├── README.md
├── adapter.ts          # Bitterbot ↔ LongMemEval bridge
├── ingest.ts           # Convert chat sessions → memory chunks
├── runner.ts           # Main benchmark runner
├── evaluate.ts         # Score aggregation
├── data/               # Downloaded LongMemEval datasets
│   ├── longmemeval_oracle.json
│   └── longmemeval_s.json
└── results/            # Output JSONL + reports
```

## Why Bitterbot Should Excel

Most systems treat this as pure retrieval. Bitterbot has architectural advantages:

- **Temporal reasoning**: Knowledge graph with `validFrom`/`validUntil` on relationships
- **Knowledge updates**: Reconsolidation makes recalled memories labile and updatable
- **Multi-session**: Dream consolidation synthesizes cross-session connections
- **Abstention**: Somatic markers + epistemic directives flag low-confidence areas
- **Information extraction**: Hybrid search (vector + keyword + importance boost)

## Data

Download from HuggingFace: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
