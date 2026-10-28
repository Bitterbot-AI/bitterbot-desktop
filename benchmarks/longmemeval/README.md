# LongMemEval Adapter for Bitterbot

Runs the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark (ICLR 2025) against Bitterbot's biological memory system.

Two kinds of runner live here. `runner-official.ts` follows the reference
protocol exactly and produces numbers that can be placed next to published
ones. Everything else (`runner.ts`, `runner-biological.ts`,
`runner-retrieval.ts`, `runner-contrastive.ts`) is diagnostic tooling whose
output is **not comparable** to any published LongMemEval figure: those
runners use their own judge prompt, feed `question_type` hints to the
reader, and until 2026-10-27 wrote the dataset's gold-marked session ids into
the retrieval corpus. Use them to compare Bitterbot against Bitterbot, never
against the leaderboard.

## Official protocol run

The reference pipeline defines a third-party result as: feed each question's
timestamped history to the memory system without the question, ask the
question at `question_date`, write `{question_id, hypothesis}` JSONL, score it
with the unmodified `evaluate_qa.py` using the pinned `gpt-4o-2024-08-06`
judge and its five question-type prompts, and report overall (question
weighted), task-averaged (mean of the six type means) and abstention accuracy.
`official-protocol.ts` holds the reader template, context formatting, judge
prompts and aggregates copied verbatim from the reference at commit
`9e0b455f`; `official-protocol.test.ts` pins them.

```bash
pnpm benchmark:longmemeval:download                   # cleaned S + oracle from HF, hashes checked below

# 1. Answer all 500 questions (hours; resumable with --resume)
pnpm benchmark:longmemeval:official -- \
  --out benchmarks/longmemeval/results/official-s-haiku-4-5.jsonl \
  --reader anthropic/claude-haiku-4-5-20251001 --unit session --k 10

# 2a. Score with the reference scripts themselves (venv + OPENAI_API_KEY)
pnpm benchmark:longmemeval:official:scorer -- benchmarks/longmemeval/results/official-s-haiku-4-5.jsonl

# 2b. Or with the TypeScript port (same judge, prompts, decoding, output format).
#     Refuses a file with fewer than 500 distinct ids unless --allow-partial (pilots).
pnpm benchmark:longmemeval:official:evaluate -- --hyp benchmarks/longmemeval/results/official-s-haiku-4-5.jsonl

# Baselines with the same reader: long context (no retrieval) and oracle (gold sessions only)
pnpm benchmark:longmemeval:official -- --full-context --out benchmarks/longmemeval/results/official-s-fullctx-haiku-4-5.jsonl
pnpm benchmark:longmemeval:official -- --oracle --out benchmarks/longmemeval/results/official-oracle-haiku-4-5.jsonl
```

What the runner does per question, and why each step is there:

| Step                                                                                                                 | Protocol reason                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebuild every turn as `{role, content}` and give sessions positional ids `session-001`…                              | The dataset leaks gold two ways: `has_answer` keys exist only on evidence-session turns, and every evidence session id contains the substring `answer`. Neither may reach the system. |
| One document per session, `Session Date:` header, `role: content` lines (the reference `nl` format)                  | Every retrieved chunk maps to one session and so to one date.                                                                                                                         |
| Back-date each session's chunks to the session timestamp and search with `now = question_date`                       | Recency and temporal-intent boosts measure age; the history is from 2023 and must be scored as of the question, not as of the ingest.                                                 |
| Query = the raw question. No `question_type` anywhere on the inference path                                          | `question_type` is a scoring key in `evaluate_qa.py`; the reference retrieval query is the question text.                                                                             |
| Top-k distinct sessions by best chunk (or top-k chunks with `--unit chunk`), rendered date-sorted as `### Session i` | `run_generation.py` sorts retrieved items by timestamp and labels each with its date; sessions are rendered as `json.dumps` of the turn list, the paper's recommended format.         |
| Chain-of-Note template (`--reading con`), pinned reader id, temperature 0, 800 max tokens                            | The paper's default reading strategy and decoding.                                                                                                                                    |
| Production retrieval settings (`postFusionBoostScale` unset, hybrid RRF, 384/48 chunking)                            | The number has to describe the system as shipped.                                                                                                                                     |
| A reader failure after four attempts is an empty hypothesis, scored wrong                                            | The reference script silently drops failed questions; counting them wrong is stricter and keeps N at 500.                                                                             |
| `now` is never earlier than the latest session                                                                       | In 76 S questions `question_date` precedes the last session (same day); the maintainers say to treat the question as asked right after it.                                            |
| `--full-context` hands the reader every session, date-sorted, no retrieval                                           | The paper's long-context baseline, with the same reader and prompt, so retrieval cost and memory benefit are measured on one footing. `--oracle` with the memory arm is the ceiling.  |

Each run writes three files: the hypothesis JSONL, `<out>.meta.json`
(protocol commit, dataset SHA-256, git commit with `+dirty` marker, reader,
k, unit, boost scale, session recall of the retrieval stage, every error) and
`<out>.retrieval.jsonl` (ranked opaque session ids and the gold ids per
question, for recall analysis). Scoring writes `<out>.eval-results-gpt-4o` in
the reference format (`autoeval_label: {model, label}` appended to each line).

Things to state with any number: dataset variant and hash, reader model id,
k and unit, that assistant turns are indexed (the reference retrievers index
user turns only), that `_abs` questions are excluded from the retrieval recall
figures (as the reference does), and that `print_qa_metrics.py` reports the
task-averaged figure while most vendors quote the question-weighted one.

Fair comparators for a run scored this way are other results that used the
official judge with a GPT-4o-class reader on the cleaned or original S set.
The paper itself reports GPT-4o full context at 0.606 direct and 0.640 CoN,
and oracle retrieval at 0.870 and 0.924; it has no retrieval-augmented number
on S (the often quoted 0.72 is LongMemEval-M). Vendor figures above 0.90
almost all use a different judge or reader and are not comparable.

### Data

`download.sh` fetches the canonical files from `xiaowu0162/longmemeval-cleaned`
(the September 2025 revision the authors point to; 1,245 empty or leaking filler
sessions removed from S, questions and answers unchanged):

| file                    | saved as                  | SHA-256 (first 16)  |
| ----------------------- | ------------------------- | ------------------- |
| `longmemeval_s_cleaned` | `longmemeval_s.json`      | `d6f21ea9d60a0d56…` |
| `longmemeval_oracle`    | `longmemeval_oracle.json` | `821a2034d219ab45…` |

LongMemEval-M (2.7 GB, about 500 sessions per question) is not downloaded by
default; the runner accepts it as `--data-dir` with the file renamed to
`longmemeval_s.json` only as a stopgap and will grow a `--variant m` flag when
a run is planned.

## What LongMemEval Tests

500 questions across 5 long-term memory abilities:

| Task                        | Questions | What It Measures                                            |
| --------------------------- | --------- | ----------------------------------------------------------- |
| **Information Extraction**  | 156       | Can you pull specific facts from chat history?              |
| **Multi-Session Reasoning** | 133       | Can you connect information across different conversations? |
| **Temporal Reasoning**      | 133       | Can you answer time-dependent questions?                    |
| **Knowledge Updates**       | 78        | Can you handle outdated/changed information?                |
| **Abstention**              | 30        | Do you know when you DON'T have the answer?                 |

## Diagnostic runners (not comparable to published numbers)

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
├── official-protocol.ts    # reference reader/judge templates, formats, aggregates (tested)
├── runner-official.ts      # official-protocol runner (hypothesis JSONL + meta + retrieval log)
├── evaluate-official.ts    # evaluate_qa.py port: pinned judge, per-type prompts, same output
├── official-scorer.sh      # runs the unmodified reference evaluate_qa.py / print_qa_metrics.py
├── adapter.ts              # legacy Bitterbot ↔ LongMemEval bridge (diagnostic runners)
├── runner.ts               # legacy QA runner (type hints, own prompt; not comparable)
├── runner-retrieval.ts     # retrieval-only diagnostics with per-channel attribution
├── evaluate.ts / judge.ts  # legacy scorer (own prompt; not the official judge)
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

Download from HuggingFace: <https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned>
