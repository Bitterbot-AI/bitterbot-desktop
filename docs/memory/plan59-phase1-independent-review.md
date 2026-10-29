---
title: "Independent review of the PLAN-59 consolidation pilot"
description: "What the stopped Phase 1 pilot establishes, and what needs strengthening before an efficacy comparison."
---

Reviewed PR #329 at `17abd984d741754ff0538d4dc2ee997e728685ce` on 2026-10-29.
This review inspects the submitted source, aggregate evidence and synthetic
tests. It does not rerun private queries, acquire new model responses, or open
the final evaluation partition. The independent workflow-practice retention
study remains separate and unchanged.

All 12 reported CI checks are green at the reviewed head. Independently, all 35 synthetic tests in the five pilot test files pass when run from the submitted sources against the corrected Phase 0 checkout and pinned dependencies. This checks harness behavior; it does not reproduce the private-data pilot or resolve the experiment-design limits below.

The saved result supports the decision to stop: 130 candidate clusters, one
qualifying at the fallback two-query bar, below the declared minimum of five.
It explicitly records `armsRun: false`. The development baseline has 212
questions, MRR 0.25444 and recall@5 0.34906. There is no policy contrast, task
completion effect or retained-learning result to interpret. Reporting this
qualification failure is appropriate.

Several boundaries matter before using this harness for final collection:

- Questions were generated from private passages; this is not the observed
  owner query distribution. The result says the selected candidates rarely
  co-surface under these generated queries. It does not establish that the
  real user's consolidation opportunity is near zero.
- The final gate validates a file hash and `status: frozen`. It does not bind
  the actual CLI settings, model, source closure, snapshot and question hashes
  to an executable frozen contract. Strengthen that check before enabling
  final evaluation. The runner loads the complete question file but selects
  only development/qualification questions for the pilot; say "final not
  scored or used for selection," rather than "final never read."
- Equal operation count K is not equal total cost. Prioritized selection pays
  additional single-operation forks and development searches. Recording those
  costs is useful, but a later equal-budget claim requires cumulative ceilings
  and a baseline allowed to use the same budget for useful work. The current
  scalar `1 + chunksTouched + 2 * embeddingCalls` is not provider dollars.
- The published dollar figures are estimates from text lengths, not provider
  receipts. The result names `ecc86c07+dirty`; an immutable tested source
  manifest is needed for a publishable final comparison.
- `needByFamily` describes counting development queries per family, but
  increments once per matching top-five chunk. Several results from one file
  count as several units of demand. Decide whether this is a redundancy
  signal or query demand, then implement and document that estimand before
  freezing a new experiment.
- Path-based partitioning prevents the same path crossing partitions; it
  does not prove that repeated facts or paraphrases stored under different
  paths cannot cross them. Do not claim semantic leak prevention from a
  path split alone.

These limits do not invalidate the observed stopping decision. They do mean
the pilot is infrastructure and candidate qualification, not evidence that a
curiosity selector works. The next candidate investigation should use corrected
owner retrieval telemetry, preserve the negative result, and qualify on
development data before any final collection.

References: [PR #329](https://github.com/Bitterbot-AI/bitterbot-desktop/pull/329),
[saved pilot result](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/17abd984d741754ff0538d4dc2ee997e728685ce/benchmarks/plan59-phase1/results/2026-10-29T21-11-43-569Z.json).
