---
title: "Weighted RRF channel fusion: sweep and real-query validation"
description: "Hybrid memory search fused its vector, keyword and graph channels with unweighted RRF. A partitioned sweep on generated questions and a judge-scored replay of the agent's real queries measured whether down-weighting the vector channel helps, and set the default."
---

This is a retrieval diagnostic and a default decision, not a curiosity
component and not externally preregistered. It ran on 2026-10-29 against a
sealed `VACUUM INTO` copy of one node's memory store; the live store was never
written. Selection used the development split of the PLAN-59 Phase 1 partition
only, confirmation the qualification split, and the final split was never read.

Tools: `benchmarks/live-recall/fusion-sweep.mts` (capture once, re-fuse
offline through the production `rrfFuse`, select on development, confirm on
qualification) and `benchmarks/live-recall/replay-judge.mts` (real queries,
judge-scored, every setting scored on the same verdicts). Result files:
`benchmarks/live-recall/results/fusion-sweep-2026-10-29.json` and
`benchmarks/live-recall/results/replay-journal-fusion-weights-2026-10-29.json`
(weights, hashes, ranks and numbers only). Method notes:
`benchmarks/live-recall/README.md`.

## What was found on main

`src/memory/rrf.ts` fused the channels with plain reciprocal rank fusion,
`1 / (60 + rank)` per channel, unweighted. The `vectorWeight` and `textWeight`
keys under `query.hybrid` apply only to the legacy `mergeStrategy: "weighted"`
path. The PLAN-59 Phase 1 pilot's development baseline had already shown the
fused list losing to its own keyword channel on this store (fused MRR 0.254
against keyword-alone 0.421); this work asks whether channel weights recover
the gap and whether the agent's real queries agree.

## Provenance

| item                | value                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit under test   | `f9ac780a` (main, PLAN-59 Phase 1 harness merged) plus this change                                                                                               |
| snapshot            | `VACUUM INTO` copy of the live store, read-only source, 3,952 chunks, 368 MB                                                                                     |
| snapshot SHA-256    | `03be448df9d4e5570d47d36d68b8bd433a9cfb4e59fc464ed67d861cd0828990`                                                                                               |
| frozen clock        | 2026-10-29T23:41:07Z (capture time) for both the sweep and the replay                                                                                            |
| generated questions | 449, `claude-haiku-4-5`, seed 59; file SHA-256 `bc36b6b0bc60999aa060a5d1b92e4f66669c8bd63564b65feab563857c308d32`                                                |
| partition           | seed 59, by family (chunk path): 212 development / 106 qualification / 131 final (never read)                                                                    |
| capture             | one search per development and qualification question, fused top 200 with per-channel ranks, `maxResults` 200, recency off, hormonal off                         |
| real queries        | 68 distinct `memory_search` queries from the event journal, May to October 2026; file SHA-256 `f3075b7c9129fe562d04d79893176583d4256dc70acbd65f65eddc60fa0406a2` |
| judge               | `claude-haiku-4-5`, one YES/NO verdict per (query, passage) pair, shared across settings                                                                         |
| embedding model     | `text-embedding-3-small`                                                                                                                                         |

The question, partition and capture files paraphrase or name private memory
and live under `~/.bitterbot/benchmarks/live-recall/` with mode 0600; they are
not in the repository.

## Sweep on generated questions

Weighted RRF scores a result as the sum over channels of
`weight / (k + rank)`. The grid was vector weight 0, 0.1, 0.25, 0.5, 0.75, 1
against keyword weight 1, graph weight 0, 0.5, 1, and k 5, 15, 30, 60: 72
settings, re-fused offline from one capture per question. "Live fused" is the
list the search actually returned (unweighted RRF followed by the bounded
post-fusion boosts); "unweighted RRF" is the same ranks re-fused at 1/1/1
without the boosts, so the gap between those two rows is what the boosts cost.

### Development split (212 questions, 158 families): selection

| setting                                   | MRR   | R@1   | R@5   | gold in top 10 |
| ----------------------------------------- | ----- | ----- | ----- | -------------- |
| live fused (unweighted RRF, boosts)       | 0.255 | 16.0% | 34.9% | 46.7%          |
| unweighted RRF 1/1/1, k 60, no boosts     | 0.269 | 17.4% | 37.3% | 48.1%          |
| keyword channel alone                     | 0.417 | 31.6% | 55.2% | 65.1%          |
| best of grid: vector 0.1, keyword 1, k 60 | 0.423 | 32.1% | 56.1% | 65.1%          |

Vector weight against keyword 1 and graph 1 at k 60:

| vector weight | MRR   | R@1   | R@5   | gold in top 10 |
| ------------- | ----- | ----- | ----- | -------------- |
| 0             | 0.417 | 31.6% | 55.2% | 65.1%          |
| 0.1           | 0.423 | 32.1% | 56.1% | 65.1%          |
| 0.25          | 0.397 | 28.8% | 53.3% | 62.7%          |
| 0.5           | 0.337 | 22.2% | 48.6% | 58.0%          |
| 0.75          | 0.288 | 18.4% | 41.0% | 53.3%          |
| 1             | 0.269 | 17.4% | 37.3% | 48.1%          |

The graph weight made no difference at any vector weight or k (the three graph
weights tie exactly in every row of the grid): the graph channel contributed no
gold hit on any question. The three worst settings of the grid are the current
1/1/1 at k 60 at each graph weight. Smaller k helped only marginally at the
same vector weight (0.25 at k 15: MRR 0.419).

### Qualification split (106 questions, 79 families): confirmation

| setting                               | MRR   | R@1   | R@5   | gold in top 10 |
| ------------------------------------- | ----- | ----- | ----- | -------------- |
| live fused (unweighted RRF, boosts)   | 0.238 | 14.1% | 33.0% | 44.3%          |
| unweighted RRF 1/1/1, k 60, no boosts | 0.246 | 14.1% | 34.9% | 44.3%          |
| keyword channel alone                 | 0.405 | 26.4% | 59.4% | 68.9%          |
| selected: vector 0.1, keyword 1, k 60 | 0.406 | 27.4% | 59.4% | 68.9%          |

| vector weight (keyword 1, graph 1, k 60) | MRR   | R@1   | R@5   | gold in top 10 |
| ---------------------------------------- | ----- | ----- | ----- | -------------- |
| 0                                        | 0.405 | 26.4% | 59.4% | 68.9%          |
| 0.1                                      | 0.406 | 27.4% | 59.4% | 68.9%          |
| 0.25                                     | 0.380 | 25.5% | 54.7% | 64.1%          |
| 0.5                                      | 0.330 | 21.7% | 45.3% | 56.6%          |
| 0.75                                     | 0.276 | 16.0% | 40.6% | 50.9%          |
| 1                                        | 0.246 | 14.1% | 34.9% | 44.3%          |

Family-paired percentile bootstrap over the 79 qualification families, 2,000
seeded resamples, MRR difference:

| contrast                       | mean   | 95% interval     |
| ------------------------------ | ------ | ---------------- |
| selected minus live fused      | +0.208 | [+0.151, +0.274] |
| selected minus unweighted RRF  | +0.198 | [+0.142, +0.260] |
| selected minus keyword alone   | 0.000  | [-0.043, +0.046] |
| keyword alone minus live fused | +0.208 | [+0.137, +0.291] |

Reading: on generated questions, down-weighting the vector channel to about a
tenth of keyword recovers the whole gap to keyword alone, the confirmation
interval excludes zero by a wide margin, and the weighted setting is
indistinguishable from keyword alone. On this question set the vector channel
adds nothing and the graph channel contributes no hits at any weight.

### Caveats on the sweep

- Generated questions keep the passage's proper nouns and identifiers, which
  favours exact-term matching. The keyword advantage here is an upper bound.
- 19 percent of gold chunks (40 of 212 development, 18 of 106 qualification)
  sat outside the live fused top 200 and count as misses for every setting; no
  re-weighting of the captured ranks can recover them.
- The post-fusion boosts still active with recency off (emotional valence,
  temporal intent) cost about 0.014 MRR on development (0.255 live fused
  against 0.269 re-fused without them).
- The graph channel contributed no hits at any weight, so nothing here
  constrains its weight; it stays at 1.

## Real queries: judge-scored replay

The decision rule was fixed before this run: the default changes only if a
keyword-heavy setting (vector weight 0.25 or 0.1) is non-inferior to 1/1/1 on
the agent's own queries, on both hit@5 and MRR, within the judge noise
estimated from the pooled verdicts; when both qualify the less extreme setting
(0.25) is preferred, and graph stays at 1.

Setup: the 68 distinct `memory_search` queries the agent made between May and
October 2026 (median 36 characters), replayed against the same snapshot with
`maxResults` 5, `candidateMultiplier` 5, `postFusionBoostScale` 0.1 (the
shipped default), the clock frozen at the capture time, hormonal modulation
off and the recency boost at its production default. The top 5 of every
setting were pooled per query and each (query, passage) pair was judged once
by `claude-haiku-4-5` (329 pairs, $0.06); the same verdicts score every
setting. 36 of the 68 queries had any relevant passage under any setting; the
rest have no answer in the store under any weighting.

Judge noise: 80 randomly chosen pooled pairs were judged a second time and 3
verdicts flipped (3.75 percent; the rule-of-three bound for 80 trials is also
3.75 percent). For each setting against 1/1/1, every pooled verdict was then
flipped independently at that rate in 2,000 simulations and both settings
rescored on the same perturbed verdicts; the margin is twice the sd of the
resulting paired delta. Passages shared by both lists flip together, so only
the lists' differences contribute, which is what judge noise on this
comparison means.

| RRF weights (vector, keyword, graph) | hit@5 | precision@5 | relevant@1 | MRR   |
| ------------------------------------ | ----- | ----------- | ---------- | ----- |
| 1, 1, 1 (unweighted, default)        | 47.1% | 33.5%       | 36.8%      | 0.400 |
| 0.5, 1, 1                            | 45.6% | 33.5%       | 36.8%      | 0.398 |
| 0.25, 1, 1                           | 47.1% | 32.6%       | 36.8%      | 0.402 |
| 0.1, 1, 1                            | 48.5% | 32.6%       | 35.3%      | 0.394 |

Paired contrasts against 1/1/1 (68 queries):

| setting    | delta hit@5 | delta MRR | queries up / down | query bootstrap 95% (hit@5; MRR)  | judge-noise margin (hit@5; MRR) | non-inferior |
| ---------- | ----------- | --------- | ----------------- | --------------------------------- | ------------------------------- | ------------ |
| 0.5, 1, 1  | -1.5 pt     | -0.003    | 2 / 4             | [-5.9, +2.9] pt; [-0.030, +0.025] | 3.5 pt; 0.017                   | yes          |
| 0.25, 1, 1 | 0.0 pt      | +0.002    | 5 / 4             | [-7.4, +7.4] pt; [-0.031, +0.032] | 4.7 pt; 0.026                   | yes          |
| 0.1, 1, 1  | +1.5 pt     | -0.006    | 6 / 5             | [-5.9, +8.8] pt; [-0.048, +0.033] | 5.1 pt; 0.030                   | yes          |

Reading: on real queries the weights barely matter. Every keyword-heavier
setting is non-inferior to 1/1/1 under the rule, none is better, and the
paired bootstrap over queries spans zero for every contrast. The 0.17 MRR gain
the generated questions promised does not appear: real queries are short and
keyword-shaped, and on the 36 answerable ones both channels mostly agree, so
re-weighting moves the first relevant passage on only 6 to 11 of 68 queries
and in both directions. The generated-question result stands as a statement
about that question style (proper nouns and identifiers kept), not about what
the agent asks.

These numbers are not comparable with the 2026-10-27 replay (hit@5 42.6
percent, MRR 0.354 at the same boost scale): the snapshot, the frozen clock,
the hormonal setting and the code under test all changed.

## Decision: default kept at 1/1/1

The rule fixed before the run said: change the default to the less extreme of
vector 0.25 and 0.1 that is non-inferior to 1/1/1 on the real queries (hit@5
and MRR within twice the judge-noise sd), otherwise keep 1/1/1. Both 0.25 and
0.1 clear that bar. The default nevertheless **stays at vector 1, keyword 1,
graph 1, k 60**, for this reason: the rule assumed the generated-question gain
was real and only needed a non-inferiority check on real queries, but the
replay showed no gain at all (MRR 0.402 against 0.400 and identical hit@5 at
0.25; MRR 0.394 at 0.1). The premise for changing behaviour is gone. A default
change with no measured real benefit is not worth the comparability cost to
every saved retrieval run, and down-weighting the vector channel risks the
public LongMemEval-S score, where the vector channel alone finds the gold
session on nearly every question, before anyone has measured it.

What this change delivers instead is the capability and the measurement:
vector 0.25 and 0.1 are available as `query.hybrid.rrfWeights`, both are
non-inferior to 1/1/1 on the agent's real queries, and 0.1 is the sweep
optimum on generated questions. The precondition for any future default
change is a LongMemEval-S retrieval check at vector 0.25 (the official-protocol
runner in `benchmarks/longmemeval/` measures the shipped default; a run with
`rrfWeights` set to 0.25 against the saved 1/1/1 runs answers it). Until then
1/1/1 is both the default and what every saved run used, so nothing becomes
incomparable.

## Claims not made

Nothing here is evidence that the vector channel is useless in general: the
generated questions favour exact terms, 19 percent of their gold chunks were
outside every list, and the real queries are one node's 68. Nothing here
touches task completion or the final partition. The graph channel's weight is
unconstrained by this data. The retention gap (32 of 68 real queries with no
relevant passage under any setting) remains the larger measured problem and is
not a fusion question.

## Cost

| item                                                    | value                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| capture, 318 deep searches (fused top 200)              | about 40 minutes of machine time, 318 embedding calls |
| sweep re-fusion, 72 settings, both splits               | seconds, offline                                      |
| replay, 4 settings x 68 queries                         | about 6 minutes, 68 embedding calls (memoised)        |
| judge, `claude-haiku-4-5`, 317 calls incl. 80 re-judged | 50,343 input and 1,508 output tokens, $0.06           |
