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

| metric                            | `bitterbot_longmemeval_s_retrieval.json` (code 9708d2d1, AND-joined FTS) | `..._2026-10-27_keyword-or.json` (code 09e5a54e, OR-joined FTS) |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| questions scored                  | 49 (one lost to the empty-embedding NOT NULL bug)                        | 50                                                              |
| R@5 / R@10                        | 98.0% / 100%                                                             | 100% / 100%                                                     |
| vector R@5                        | 98.0%                                                                    | 98.0%                                                           |
| keyword R@5 / R@10                | 0.0% / 0.0%                                                              | 100% / 100%                                                     |
| attribution of the top-5 gold hit | vector-only 98%, none 2%                                                 | multi 100%                                                      |

The vector channel did not change between the two runs; the difference is that the keyword channel now takes part at all. On this slice it agrees with the vector channel on every gold session, which is what the fused score should reflect.

Stratified run (`--per-type 10`: the first 10 questions of each of the six LongMemEval-S question types, 60 questions, quiet bridge), before and after the keyword-channel change:

| question type             | R@5 before → after | R@10 | vector R@5 | keyword R@5 before → after |
| ------------------------- | ------------------ | ---- | ---------- | -------------------------- |
| single-session-user       | 100% → 100%        | 100% | 100%       | 0% → 100%                  |
| multi-session             | 100% → 90%         | 100% | 100%       | 0% → 90%                   |
| single-session-preference | 100% → 100%        | 100% | 100%       | 0% → 80%                   |
| temporal-reasoning        | 100% → 100%        | 100% | 100%       | 0% → 100%                  |
| knowledge-update          | 100% → 100%        | 100% | 100%       | 0% → 100%                  |
| single-session-assistant  | 90% → 100%         | 100% | 100%       | 0% → 100%                  |
| all 60                    | 98.3% → 98.3%      | 100% | 100%       | 0% → 95%                   |

Files: `bitterbot_longmemeval_s_retrieval_2026-10-27_stratified-before.json` and `..._stratified-after.json`. Reading: the vector channel alone already finds the gold session in the top 5 on every one of the 60 questions, so this benchmark at this size cannot show a fusion gain, only fusion noise. The keyword channel went from absent to agreeing with vector on 57 of 60. The two R@5 changes are one gain (a single-session-assistant question the importance boost had pushed to rank 6 under vector-only fusion) and one loss (a multi-session question where the keyword channel's own top 5 did not hold the gold session and its other hits pushed the fused gold rank from 5 to 10). R@10 is 100% in both runs. A harder instrument (LongMemEval-M, or chunk-level rather than session-level recall) is needed before channel weighting can be judged.

Evidence-level view of the same stratified 60 (did a chunk overlapping a `has_answer` turn come back, and at what rank; files `..._2026-10-27_evidence-{before,after}.json`, boosts held at the legacy scale so only the keyword channel differs):

| evidence-level metric | before (AND) | after (OR) |
| --------------------- | ------------ | ---------- |
| fused R@1             | 43.3%        | 47.5%      |
| fused R@5             | 83.3%        | 93.2%      |
| fused R@10            | 96.7%        | 98.3%      |
| fused MRR             | 0.615        | 0.661      |
| vector alone MRR      | 0.645        | 0.642      |
| keyword alone R@5     | 0.0%         | 83.1%      |

Per question the evidence rank improved on 21 and worsened on 9. Per type, single-session-user MRR went 0.66 to 0.82 and knowledge-update 0.51 to 0.60; multi-session was flat at 0.48 and single-session-preference slipped 0.61 to 0.58. Session-level R@5 stayed at 98.3%, which is why the session-level table above could not see any of this. With the keyword channel present, the fused list now beats the best single channel (0.661 against vector's 0.642); before it trailed it.

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
