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

## Caveats

- The question writer sees the passage, so questions can be easier than real
  recall: they always contain findable terms. Treat absolute numbers as an
  upper bound and read the before/after differences.
- Only one chunk is the target. A neighbouring chunk from the same note that
  also answers the question counts as a miss; MRR softens this but does not
  remove it.
- The sample is from one node's memory. Numbers are not comparable across
  nodes, only across runs on the same snapshot and question file.
