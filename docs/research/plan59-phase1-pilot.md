---
title: "PLAN-59 Phase 1 pilot: consolidation on forked stores"
description: "Development and qualification pilot of gain x need memory consolidation on one node's sealed store. Negative result: the candidate clusters do not co-surface for the owner's question stream, so no arm was run."
---

This is a development and qualification pilot, not externally preregistered.
Its purpose was to check that the Phase 1 harness measures what it should and
to fix the sample size for a later collection. It ran on 2026-10-29 against a
sealed snapshot of one node's memory store, on forks only; the live store was
never written. No final-partition number appears here or anywhere else.

Harness and method: `benchmarks/plan59-phase1/README.md`. Result file:
`benchmarks/plan59-phase1/results/` (ids, hashes, ranks and numbers only).

## Provenance

| item                   | value                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| commit under test      | `ecc86c07` (main, PLAN-59 Phase 0 merged)                                                                                |
| snapshot               | `VACUUM INTO` copy of the live store, read-only source, 3,952 chunks, 368 MB                                             |
| snapshot SHA-256       | `806a57b5a612e385789aac15986ca4022965e189eeba482fd0904c6d6be58cd9`                                                       |
| frozen clock           | 2026-10-29T20:40:17Z (snapshot time)                                                                                     |
| questions              | 449 (450 asked, 1 failed), `claude-haiku-4-5`, seed 59, prompt `34f762f3...`                                             |
| question file SHA-256  | `bc36b6b0bc60999aa060a5d1b92e4f66669c8bd63564b65feab563857c308d32`                                                       |
| partition              | seed 59, by family (chunk path): 212 / 106 / 131 questions, 158 / 79 / 79 families (development / qualification / final) |
| partition file SHA-256 | `f5912bb830a4fe38f3446c83aaa8f8219ba8ee60693771dd372a377bad052087`                                                       |
| scoring                | hybrid RRF, maxResults 50, engines off, recency boost off, hormonal off, evidence telemetry off                          |
| embedding model        | `text-embedding-3-small` (every chunk; re-embed inapplicable)                                                            |

The question file and the partition file paraphrase private memory and live
under `~/.bitterbot/benchmarks/live-recall/` with mode 0600; they are not in
the repository.

## Development baseline (unchanged fork, 212 development questions)

| metric                        | value                 |
| ----------------------------- | --------------------- |
| fused MRR                     | 0.254                 |
| fused R@1 / R@5 / coverage@10 | 16.0% / 34.9% / 46.7% |
| keyword channel MRR / R@5     | 0.421 / 56.1%         |
| vector channel MRR / R@5      | 0.130 / 18.9%         |
| graph channel                 | no hits               |
| search latency p50 / p95      | 2,864 ms / 5,222 ms   |

The keyword channel again carries the fused list on this store, as in the
live-recall runs of 2026-10-27.

## Candidates and qualification

| signal                                                                                                     | value                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `near_merge_hints` pairs at cosine 0.85 or above, both members live and undemoted                          | 1,026, all same-path                                                                  |
| connected components (clusters, capped at six members)                                                     | 130 across 35 paths                                                                   |
| cluster sizes                                                                                              | 64 of two members, 14 of three, 15 of four, 11 of five, 26 of six (the cap)           |
| clusters with two members in a development top 5 for 3 or more queries (the declared bar)                  | 0                                                                                     |
| same, bar lowered to 2 queries (the brief's fallback)                                                      | 1                                                                                     |
| same, 1 query                                                                                              | 4                                                                                     |
| clusters with two members in a development top 10 for 1 or more queries                                    | 7 (2 for 2 or more queries, 0 for 3 or more)                                          |
| clusters with any member in any development top 10                                                         | 27 of 130                                                                             |
| development queries with any cluster member in their top 10                                                | 44 of 212                                                                             |
| development questions whose gold chunk is a cluster member                                                 | 13 (fused ranks: 6 missing from the top 50, 4 in the top 5, one each at 6, 36 and 44) |
| `bound_validity` candidates (superseded canonical facts with dated validity and unbounded evidence chunks) | 45 operations over 63 chunks, 5 with any affected development query                   |
| `retrieval_hits` rows on the snapshot                                                                      | 0 (Phase 0 not yet deployed; the access prior carried the need estimate)              |

With one qualified cluster against a floor of five, the runner stopped before
the arm run, as the pilot rule required. No arm, no priority, no contrast was
computed.

## Reading

The hypothesis that consolidation of co-surfacing near-duplicate clusters is
the largest measurable opportunity on this store (the 2026-10-29 selection
audit) rested on counts: 1,708 near-duplicate pairs at the merge threshold,
783 well-accessed pairs just below it, half the store never retrieved. The
pilot adds the missing fact: for the owner's own passages, phrased as
half-remembered questions, those clusters almost never appear together in the
fused top 5, and most never appear in a top 10 at all. The near-merge zone is
populated by chunks the question stream does not reach, so demoting them
behind a parent could not change a rank that is never assigned. The
qualification rule did exactly what it was for: it kept an operation that
cannot show a retrieval benefit from being measured as if it could.

This is a result about this snapshot and this question stream. Generated
questions always contain findable terms and favour the keyword channel; real
agent queries (the journal replay of 2026-10-27) are shorter and leave 33 of
68 unanswerable, which is a retention problem, not a consolidation one. The
pilot does not show that consolidation never helps, only that its measurable
opportunity on this node, under this protocol, is near zero.

`bound_validity` is carried but inert: on this commit `valid_time_end` is read
by the knowledge graph's temporal filter and the curiosity researcher, not by
either search channel or the post-fusion boosts, so it cannot move a fused
rank. It stays a correctness operation whose retrieval gain is zero by
construction until search reads the column.

## What the harness established

- Forks are byte-independent copies of a sealed snapshot whose hash is
  re-checked at the end of the run (intact). Nothing under `~/.bitterbot`
  was written except the question and partition files.
- Search on main ignores `lifecycle`, `lifecycle_state`, `parent_id` and
  `valid_time_end`; a demotion is visible only through the `chunks_vec` and
  `chunks_fts` rows. The operation therefore removes those rows and keeps
  every column reversible, which is the PLAN-40 Lane 2 convention the indexer
  still honours.
- The final partition is sealed behind `--final --freeze <sha256>` of a
  protocol file marked `status: frozen`; the path is tested and unused.
- 35 colocated tests cover partition determinism and disjointness, need decay,
  the zero-cost guard, cluster creation, demotion, non-deletion and fork
  confinement, `bound_validity` touching only null `valid_time_end`, parent
  mapping, the final-partition refusal and bootstrap reproducibility.

## Cost

| item                                               | value                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| question generation, `claude-haiku-4-5`, 450 calls | about $0.21 (about 156k input, 11k output tokens, estimated from passage and question lengths)                       |
| embeddings, both runs, `text-embedding-3-small`    | about $0.01 or less (about 450 calls over the smoke run and both pilot runs, about 5k tokens per run distinct texts) |
| wall time, snapshot plus questions plus pilot      | about 41 s snapshot (sync writes), 6 min questions, 624 s pilot run                                                  |
| forks                                              | 1 per run (development baseline only; no arm forks were made)                                                        |

## Decision and next hypothesis

Decision for the operation set as declared: **insufficient evidence to run the
contrast; redesign the candidate rule before any collection.** The sample size
cannot be fixed from a run that produced no contrast; the next pilot must first
show a candidate pool of at least five qualifying operations.

What would change the picture, in order of how little it assumes:

1. Qualify co-surfacing on real queries, not generated ones: the Phase 0
   `retrieval_hits` table, once a deployed build has collected a few weeks of
   owner searches, is the demand signal the plan asked for. Re-run the
   diagnostics against it before anything else.
2. Widen the candidate definition away from `near_merge_hints` (a cosine
   neighbourhood computed on the most important chunks) toward result-list
   redundancy: pairs that actually co-occur in fused top 10 lists for the
   owner's queries, whatever their cosine.
3. If neither yields five candidates, drop consolidation as the first
   mechanism pilot. The retention gap (unanswerable real queries) is the
   larger measured problem and belongs to PLAN-55, as the plan's risk section
   anticipated.

Claims not made: nothing here is evidence for or against gain x need
selection in general, nothing about task completion, and nothing about the
final partition, which was never read.
