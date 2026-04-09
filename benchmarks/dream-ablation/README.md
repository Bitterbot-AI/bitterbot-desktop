# Dream Engine Ablation Test Suite

Systematic evaluation of whether each dream engine component adds measurable value to memory retrieval quality.

## Design

Uses the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) dataset — 500 questions across 5 long-term memory abilities — as the evaluation corpus. Each **ablation variant** selectively disables one dream component while keeping everything else identical, then measures the accuracy delta against the full biological baseline.

### What each variant tests

| Variant | What's disabled | What we learn |
|---------|----------------|---------------|
| `full-bio` | Nothing (baseline) | Reference accuracy with all systems |
| `no-dreams` | Entire dream engine | Top-level: do dreams help at all? |
| `replay-only` | All modes except replay | Is memory strengthening alone sufficient? |
| `compression-only` | All modes except compression | Is deduplication alone sufficient? |
| `no-llm-modes` | Cloud LLM modes (mutation, sim, extrap, explore, research) | Are the zero-cost modes enough? |
| `no-simulation` | Simulation mode | Do cross-domain connections help multi-session reasoning? |
| `no-extrapolation` | Extrapolation mode | Do predictive insights help temporal reasoning? |
| `no-curiosity` | CuriosityEngine (GCCRF) | Does intrinsic motivation improve seed selection? |
| `no-hormonal` | Hormonal modulation | Does emotion-weighted prioritization help? |
| `no-fsho` | FSHO oscillator | Does the oscillator add signal or noise? |

### Metrics captured per variant

**Accuracy** (from GPT-4o judge, same as LongMemEval):
- Overall accuracy (%)
- Per question type: info-extraction, multi-session, temporal-reasoning, knowledge-update, abstention

**Dream metrics** (from bridge instrumentation):
- Total dream cycles, insights generated, LLM calls used
- Mode frequency distribution
- Average insights per question

**Memory metrics** (from SQLite queries):
- Active/archived chunk counts
- Dream insight count
- Average curiosity reward and importance score

## Running

### Prerequisites

```bash
# Download LongMemEval dataset (if not already present)
pnpm benchmark:longmemeval:download

# Set API keys
export OPENAI_API_KEY=...      # Required (embeddings)
export ANTHROPIC_API_KEY=...   # Required (answer generation with Opus)
```

### Single variant (quick test)

```bash
node --import tsx benchmarks/dream-ablation/runner.ts --variant full-bio --limit 50 --verbose
```

### Full ablation (all 10 variants)

```bash
# ~10 hours at 500 questions x 10 variants
node --import tsx benchmarks/dream-ablation/runner.ts --variant all
```

### Evaluate accuracy

Use the LongMemEval evaluator on each variant's JSONL output:

```bash
for f in benchmarks/dream-ablation/results/*_longmemeval_s.jsonl; do
  node --import tsx benchmarks/longmemeval/evaluate.ts \
    --results "$f" \
    --dataset benchmarks/longmemeval/data/longmemeval_s.json
done
```

### Compare results

```bash
node --import tsx benchmarks/dream-ablation/compare.ts
```

Produces:
- `results/ablation_comparison.json` — full comparison matrix
- Printed table showing accuracy deltas per variant per question type
- Dream metrics summary per variant

## Interpreting Results

### Value signals

| Signal | Interpretation |
|--------|---------------|
| `no-dreams` < `full-bio` by >2% | Dreams add measurable value |
| `no-llm-modes` ≈ `full-bio` | Free modes (replay+compression) are sufficient — LLM modes don't justify cost |
| `no-simulation` drops multi-session by >3% | Simulation cross-domain connections are useful |
| `no-fsho` ≈ `full-bio` | FSHO is noise — could be removed or simplified |
| `no-curiosity` < `full-bio` | GCCRF scoring improves what gets dreamed about |

### Cost analysis

Compare `full-bio` total LLM calls vs `no-llm-modes` total LLM calls. The delta is the "price of creative dreaming" per question — multiply by your per-call cost to get the marginal value proposition.

### Actionable outcomes

- Components where removal causes <1% accuracy drop are candidates for removal (dead weight)
- Components where removal causes >3% drop are validated as essential
- The 1-3% zone needs more data (run with full 500 questions, not limit 50)
