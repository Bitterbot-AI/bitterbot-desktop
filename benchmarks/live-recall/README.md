# Live-memory held-out recall

A retrieval test built from a node's own memory store instead of a public
dataset. Public benchmarks such as LongMemEval-S saturate: the vector channel
alone already puts some chunk of the gold session in the top 5 on nearly every
question, so two retrievers that are both decent look identical. The operator's
real memory is harder and more relevant: it is full of names, file paths,
identifiers and project words that embeddings blur and exact-term matching
finds, and it is the data the agent actually searches.

## Method

1. **Snapshot.** Take a consistent read-only copy of the live store
   (`VACUUM INTO` on `~/.bitterbot/memory/main.sqlite`). Nothing below touches
   the live database.
2. **Sample.** `make-questions.mts` selects chunks from `memory` and `sessions`
   sources with a live lifecycle and 300 to 1500 characters, orders them by
   `sha256(seed + id)` so the sample is reproducible, drops any chunk the
   secret redactor would change, and takes the first N.
3. **Questions.** A small model (default `claude-haiku-4-5`) writes one
   question per chunk under a fixed prompt: a question the passage answers,
   phrased as someone half-remembering the topic would type it, keeping the
   proper nouns and identifiers, never copying a sentence. The questions
   paraphrase private memory, so the file is written with mode 0600 under
   `~/.bitterbot/benchmarks/live-recall/` and is **never committed**. A
   manifest records the snapshot size, sample counts, seed, model, and the
   SHA-256 of the prompt and of the question file.
4. **Score.** `run.mts` copies the snapshot (search updates access statistics),
   opens it through the normal `MemoryIndexManager` with the live embedding
   provider and hybrid settings and every background engine off, runs each
   question, and records where the source chunk lands: the fused rank and each
   channel's own rank. Metrics: R@1, R@5, R@10 and MRR for the fused list and
   for the vector, keyword and graph channels; a per-source breakdown; the
   commit under test; the snapshot and question-file hashes. The result file
   holds ids and ranks only.

Two runs on the same snapshot and question file differ only in the code under
test, so a before/after is exact: same questions, same store, same embeddings.

## Run

```bash
SNAP=/path/to/snapshot.sqlite
Q=~/.bitterbot/benchmarks/live-recall/questions-$(date +%F).jsonl
node --import tsx benchmarks/live-recall/make-questions.mts --snapshot $SNAP --out $Q --n 60 --seed 1
node --import tsx benchmarks/live-recall/run.mts --snapshot $SNAP --questions $Q \
  --out benchmarks/live-recall/results/live-recall-$(git rev-parse --short HEAD).json
```

Costs: one small-model call per question to generate, one embedding call per
question to score. A 60-question run takes a few minutes.

## Results, 2026-10-27

One node, snapshot of 4,083 chunks, 60 questions (seed 1, `claude-haiku-4-5`), question
file SHA-256 in `results/questions-2026-10-27.manifest.json`. Fused = the list the agent sees.

| run                                                | fused R@1 | fused R@5 | fused R@10 | fused MRR | vector R@5 | keyword R@5 |
| -------------------------------------------------- | --------- | --------- | ---------- | --------- | ---------- | ----------- |
| AND-joined keyword channel, full boosts (pre-#312) | 0.0%      | 3.3%      | 6.7%       | 0.022     | 16.7%      | 0.0%        |
| OR-joined keyword channel (#312), full boosts      | 3.3%      | 8.3%      | 13.3%      | 0.063     | 21.7%      | 30.0%       |
| same, recency boost off                            | 5.0%      | 11.7%     | 16.7%      | 0.087     | 23.3%      | 33.3%       |
| same, `postFusionBoostScale` 0.25                  | 15.0%     | 33.3%     | 40.0%      | 0.241     | 23.3%      | 55.0%       |
| same, `postFusionBoostScale` 0.1 (new default)     | 20.0%     | 40.0%     | 46.7%      | 0.276     | 23.3%      | 55.0%       |
| same, `postFusionBoostScale` 0                     | 26.7%     | 41.7%     | 48.3%      | 0.336     | 23.3%      | 53.3%       |

Reading: the keyword channel is the strongest single channel on real memory
(names, paths, identifiers), and the fused list was worse than either channel
until the post-fusion boosts were bounded, because the temporal-intent decay
and the recency boost, sized for cosine scores, reordered rank-fused results
wholesale. Channel columns in the full-boost rows undercount: a target pushed
out of the returned 50 by the boosts has no channel rank either.

Result files are in `results/` and hold ranks, chunk ids and sources only.

## Real agent queries (journal replay)

Generated questions always contain findable terms. The event journal records
every `memory_search` the agent has made, with its query text, so the same
code paths can be judged on what the agent actually asks:

1. `extract-journal-queries.mts` pulls the distinct queries from
   `~/.bitterbot/event-journal.sqlite` (stream `tool`, phase `start`). Private
   output under `~/.bitterbot`, never committed; a manifest with counts and the
   file hash is.
2. `replay-judge.mts` searches a copy of the snapshot once per setting,
   pools the top-k passages across settings, and asks a small model ONCE per
   (query, passage) pair whether the passage answers the query. The same
   verdicts score every setting, so the comparison is fair even where the
   judge is not. Output: hit@k (any relevant passage in the top k),
   precision@k, relevant@1, MRR; hashes and ranks only.

   A setting is `boost=<postFusionBoostScale>;rrf=<vector>,<keyword>,<graph>[;k=<rrfK>]`,
   passed as `--settings "boost=0.1;rrf=1,1,1" "boost=0.1;rrf=0.25,1,1" ...`
   (`--scales 1,0.1,0` is the older spelling for boost scales alone). The first
   setting is the baseline. Every search runs with the wall clock frozen at
   `--now` and hormonal modulation off, so a setting's list depends on the
   code and the snapshot only; the recency boost keeps its production default.
   `--rejudge N` asks the judge again about N random pooled pairs to estimate
   its flip rate; the output then carries, per setting against the baseline,
   the paired delta in hit@k and MRR, a paired bootstrap over queries
   (sampling noise), the sd of the delta when every pooled verdict flips at
   that rate (judge noise), and a `nonInferior` flag (both deltas at least
   minus twice the judge-noise sd). `--verdict-cache` checkpoints verdicts
   (hashes and booleans) so a run that loses the network resumes for free.

Results, 2026-10-27: 68 distinct real queries (May to October 2026, median 36
characters), k = 5, judge `claude-haiku-4-5`, 398 pairs judged. Only 33 of the
68 queries had any relevant passage under any setting; the store simply does
not hold an answer for the rest, which is itself a finding about what the agent
asks for versus what it has kept.

| `postFusionBoostScale` | hit@5 | precision@5 | relevant@1 | MRR   |
| ---------------------- | ----- | ----------- | ---------- | ----- |
| 1 (legacy)             | 38.2% | 23.8%       | 32.4%      | 0.342 |
| 0.1 (default)          | 42.6% | 30.9%       | 32.4%      | 0.354 |
| 0                      | 44.1% | 31.2%       | 32.4%      | 0.362 |

Per query, 0.1 against 1 moved the first relevant passage up on 8 queries and
down on 5 (55 unchanged); 0 against 0.1 moved 3 up and 3 down. The direction
agrees with the held-out set; the size of the effect is far smaller on real
queries, which are short and keyword-shaped and sit closer to the keyword
channel's strengths, and 0 is not distinguishable from 0.1 on this sample. The
default stays at 0.1.

Results, 2026-10-29 (`results/replay-journal-fusion-weights-2026-10-29.json`):
the same 68 queries against a fresh snapshot (3,952 chunks), k = 5, clock
frozen, hormonal modulation off, `postFusionBoostScale` 0.1 throughout, RRF
channel weights varied (vector, keyword, graph). 329 pairs judged by
`claude-haiku-4-5` ($0.06); 36 of 68 queries had any relevant passage under
any setting. Re-judging 80 random pairs flipped 3 (3.75 percent).

| RRF weights (vector, keyword, graph) | hit@5 | precision@5 | relevant@1 | MRR   | delta hit@5 vs 1,1,1 | delta MRR vs 1,1,1 | judge-noise margin (hit@5 / MRR) |
| ------------------------------------ | ----- | ----------- | ---------- | ----- | -------------------- | ------------------ | -------------------------------- |
| 1, 1, 1 (unweighted, default)        | 47.1% | 33.5%       | 36.8%      | 0.400 |                      |                    |                                  |
| 0.5, 1, 1                            | 45.6% | 33.5%       | 36.8%      | 0.398 | -1.5 pt              | -0.003             | 3.5 pt / 0.017                   |
| 0.25, 1, 1                           | 47.1% | 32.6%       | 36.8%      | 0.402 | 0.0 pt               | +0.002             | 4.7 pt / 0.026                   |
| 0.1, 1, 1                            | 48.5% | 32.6%       | 35.3%      | 0.394 | +1.5 pt              | -0.006             | 5.1 pt / 0.030                   |

The margin is twice the sd of the paired delta when every pooled verdict flips
independently at the observed 3.75 percent rate; all three keyword-heavier
settings are non-inferior to 1/1/1 under it, and none is better (paired
bootstrap over queries spans zero for every contrast). The large gain the
generated questions showed does not appear on real queries, which are short
and keyword-shaped and already sit where both channels agree. The default
stays 1/1/1: with no measured real-query benefit there is nothing to pay the
comparability cost for. 0.25 and 0.1 are available as configuration. Full
tables and the decision: `docs/research/fusion-weights-2026-10-29.md`.

## Fusion-weight sweep (generated questions, partitioned)

`fusion-sweep.mts` asks how the fused list should combine its channels. It
runs one deep search per question (fused top 200 with every channel's own rank
on each result) from a frozen fork of the snapshot, then re-fuses offline
through the production `rrfFuse` over a grid of RRF channel weights (vector 0
to 1 against keyword 1, graph 0 to 1) and RRF constants (5 to 60). It uses the
PLAN-59 Phase 1 partition (`benchmarks/plan59-phase1/`): the grid is selected
on the development split only, the selected setting is confirmed on the
qualification split with a family-paired bootstrap, and the final split stays
sealed behind that harness's `--final --freeze <sha256>` gate (implemented,
never opened). The capture holds private paths and is written only under
`~/.bitterbot/benchmarks/live-recall/` with mode 0600 and reused on later
runs; a partial capture is checkpointed every ten questions. The result file
holds weights, hashes and numbers only.

```bash
node --import tsx benchmarks/live-recall/fusion-sweep.mts --snapshot $SNAP \
  --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions-$(date +%F).jsonl \
  --capture ~/.bitterbot/benchmarks/live-recall/plan59-fusion-capture-$(date +%F).json \
  --out benchmarks/live-recall/results/fusion-sweep-$(date +%F).json
```

Result of 2026-10-29 (`results/fusion-sweep-2026-10-29.json`) and the
real-query check that kept the default: `docs/research/fusion-weights-2026-10-29.md`.

## Caveats

- The question writer sees the passage, so questions can be easier than real
  recall: they always contain findable terms. Treat absolute numbers as an
  upper bound and read the before/after differences.
- Only one chunk is the target. A neighbouring chunk from the same note that
  also answers the question counts as a miss; MRR softens this but does not
  remove it.
- The sample is from one node's memory. Numbers are not comparable across
  nodes, only across runs on the same snapshot and question file.
