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
