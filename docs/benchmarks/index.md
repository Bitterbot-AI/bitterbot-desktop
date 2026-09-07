# Benchmarks

Published measurements of Bitterbot subsystems, committed with the code they
measure (PLAN-45 D-6: results are published per release, negative ones
included).

## Skill ablation (PLAN-45 5.1 and 5.2)

`pnpm benchmark:skills` runs the node's live skills through the same task
suites the validation gate uses and writes `docs/benchmarks/skills-<date>.md`
with a machine-readable header. Arms:

| Arm          | What the agent sees                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `none`       | No skill in the index                                                                                                                  |
| `harvested`  | The live harvested skills (registry imports, Skill Seekers, accepted peers)                                                            |
| `evolved`    | The live skills this node's evolution loop promoted                                                                                    |
| `in-context` | Per evolved skill S: S's own evidence traces verbatim in the prompt, no skill file (paired with `evolved:S`, the index holding only S) |

Corpora: `frozen` (the pinned seed-0 canonical exemplar), `fresh` (the canonical
generator at the run's seed), `private` (the node's grown capability suite).
Models: `primary` (the agent's default) and `cheap`. Per cell: pass@1, pass^K,
skill read rate, tokens; against the `none` baseline and, for `evolved`,
against `in-context`: an exact sign test, a bootstrap CI and the token delta.
The verdict sentences are fixed in advance; a tie or a loss is stated as
such.

The embedded executor runs each trial in-process under the validation
session flavor with the node's memory manager switched off
(`BITTERBOT_MEMORY_OFF=1`), so a measurement never becomes an experience.

`pnpm benchmark:skills:check` verifies the newest committed report against
the corpus generator version and the exemplar pin (invariant I10). The
`skills-ablation` workflow runs the harness self-test weekly with a
deterministic executor and can produce a live report on demand.

## Reports

Newest first.

- [2026-09-06](skills-2026-09-06.md): first run on the reference node; baseline and harvested arms only (no evolved skill live yet), primary model, frozen corpus, six tasks per suite, two trials.
