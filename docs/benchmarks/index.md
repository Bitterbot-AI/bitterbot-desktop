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
generator at the run's seed), `private` (the node's grown capability suite), and
`external`: the deterministically scored subtasks of ContinualSkillBench
(arXiv 2608.03874, Apache-2.0; exact-match and numeric, 279 of 600 across six
domains), cloned on demand with `--external <dir>` and filtered with
`--external-domains`. Its rubric-judged and programmatic subtasks need the
benchmark's own verifiers and are counted, not scored.
Models: `primary` (the agent's default) and `cheap`. Per cell: pass@1, pass^K,
skill read rate, tokens; against the `none` baseline and, for `evolved`,
against `in-context`: an exact sign test, a bootstrap CI and the token delta.
The verdict sentences are fixed in advance; a tie or a loss is stated as
such.

The embedded executor runs each trial in-process under the validation
session flavor with the node's memory manager switched off
(`BITTERBOT_MEMORY_OFF=1`), so a measurement never becomes an experience.

`pnpm benchmark:skills:check` verifies the newest committed report against
the corpus generator version, the exemplar pin and the harness version
(invariant I10). The harness version moves when the measurement itself
changes (version 2: validation shells pinned to the confined gateway host),
so an older report is flagged rather than compared. The
`skills-ablation` workflow runs the harness self-test weekly with a
deterministic executor and can produce a live report on demand.

## Experience-guided skill prior (controlled test)

`node --import tsx benchmarks/skill-prior/run.ts --phase order|headroom|arms|cards`
(and `conventions-run.ts --phase train|pilot|main`)
tests whether an outcome-gated, per-context bandit that reorders the
`<available_skills>` index (`skills.prior`, default off) changes which skill the
agent reads first and whether that changes verified task outcomes. The pool is
controlled: for each canonical capability family one correct skill, one decoy
with the same routing description and a wrong rule, plus unrelated fillers.
Two abort gates run first: order sensitivity (correct skill listed first vs
last) and headroom (forced-skill truth table). The treatment is then compared,
paired by task instance, against directory order, context-free global-success
ordering, shuffled associations and ungated co-occurrence, all learned from the
same episodes. Results are written under the run's output directory, never
under `~/.bitterbot`; see `benchmarks/skill-prior/README.md`.

Pilot, 2026-11-01, Claude Haiku 4.5: on fully specified tasks skills were a net
cost (no skill 81.5%, correct skill forced 70.4%), so the headroom gate blocked
the treatment arms. On the underspecified variant the correct skill helped
(59.3% to 74.1%) but the learned prior did not: pass rate equalled directory
order (69.4% both) and correct-skill reads fell from 80.6% to 61.1% with the
top pick placed first or last. Registered outcome: no value for index
reordering at pilot scale; `skills.prior` stays off.

Evidence cards, 2026-11-02, same model and variant: instead of reordering, each
skill's index entry carried its verified record in the task's family ("5 of 5
runs passed"), 54 paired tasks per arm. The model used the numbers: real counts
beat the same counts swapped between the correct skill and its decoy by 13.0 pp
pass (7 wins / 0 losses, p 0.008) and 24.1 pp correct reads. Correct counts
against no card were +3.7 pp pass, CI [-5.6, 13.0], because the model already
avoided the decoy in 92.6% of trials; exact counts did no better than the same
verdict in words. Evidence shown at the choice is used where order was not,
and its main measured risk is that a wrong record misleads.

Latent-convention twins, 2026-11-03, same model: each task family has four
skills with identical descriptions whose bodies follow different house
conventions, and a hidden per-workspace convention decides which one is right
(each variant right in a balanced quarter of workspaces, 39-skill index). Cards
come from forced training runs only; evaluation is on held-out seeds, 192
instances x 2 trials per arm, six arms. Without evidence the agent passed
26.8% (chance is 25%) and opened a wrong variant first 71% of the time. With
verified records it passed 88.5%: +61.7 pp, 152 wins / 2 losses, family-cluster
CI [54.2, 69.5]. A placebo line of the same shape with no outcome content did
nothing (+1.3 pp), swapped records drove the pass rate to 1.3%, and the learned
order (prior) added nothing alone (0.0 pp) or on top of cards (-1.0 pp). One
of nine families was excluded by the registered truth-table rule (harness
defect). Records here are exact by construction, so this measures the upper
bound of showing accurate evidence; `benchmarks/skill-prior/README.md` has the
full tables.

Record accuracy, same instances: records with a simulated verifier that flips
each logged outcome with probability eps (5 runs per skill) still beat no
records at every level tested (Holm-adjusted): +61.5 pp at eps 0.1, +52.6 at
0.2, +39.8 at 0.3, +13.5 at 0.4. The model's choices stay within 2 to 8 pp of
an ideal reader of the same counts, and ten logged runs instead of five
recover 7.3 pp at eps 0.3.

Second vendor, same design: on OpenAI gpt-5.4-mini verified records lifted
pass from 29.2% to 80.5% (+51.3 pp, 138 wins / 4 losses, cluster CI
[43.2, 59.4]); the placebo line again did nothing (+1.8 pp) and swapped
records dropped the pass rate to 6.0%. Unlike Haiku, gpt-5.4-mini gained a
further 8.6 pp when the learned order was added to the cards (Holm p 0.0002),
though order alone still did not help.

Learning online from accept/reject feedback (cold start, 64 workspace and
family cells, 8 episodes, Claude Haiku 4.5): a plain log of earlier episodes
(skill used, answer, verdict) raised mean pass after the first episode from
27.2% to 63.6% (+36.4 pp, 49 of 64 cells better), more than model-written
lessons (40.6%), counts in the notes (41.3%), counts on the skill index
(56.9%) or a Thompson-sampling reference (49.6%). The registered primary
(counts above lessons) was null. Agents with counts or lessons kept going
back to a skill after it was rejected; agents with the episode log moved on.

A pre-registered confirmation on fresh seeds (both Claude Haiku 4.5 and
gpt-5.4-mini) did not confirm the episode log over counts by its registered
sign test (+16.5 and +15.4 pp, p 0.16 and 0.08). It found a larger, simpler
effect: writing the same counts as words ("REJECTED every time it was used")
raised pass from 45.3% to 67.2% on Haiku and from 34.6% to 73.7% on
gpt-5.4-mini (Holm p 0.023 and below 0.0001), the best format on both models.

## Long-term memory recall (LongMemEval-S)

A full 500-question run of [LongMemEval-S](https://github.com/xiaowu0162/LongMemEval)
under the reference protocol (the benchmark's own GPT-4o judge and
per-question-type prompts), 2026-10-28, with Bitterbot's production retrieval
(hybrid search, session-level recall, k = 10) feeding a Claude Haiku 4.5
reader. The unmodified reference scorer returned the same overall figure.

| metric                                    | value |
| ----------------------------------------- | ----- |
| overall (question-weighted)               | 0.858 |
| task-averaged (mean of 6 type means)      | 0.883 |
| abstention accuracy (30 `_abs` questions) | 0.933 |
| session recall_all@10 (470 non-abs)       | 0.964 |
| multi-session (133), the weakest type     | 0.744 |

Caveats. The score is reader and judge dependent: the same retrieval with an
oracle context (gold sessions only) scores 0.920 with the Haiku reader, so the
remaining gap is mostly context noise and reading, not retrieval misses (58 of
the 71 misses had every gold session in context). A Claude Sonnet 4.5 reader
scored 0.868, one point higher at about three times the cost. Published
numbers from other systems mostly use a different judge or reader and are not
directly comparable. Setup, per-type table, miss analysis and raw outputs:
[benchmarks/longmemeval](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/benchmarks/longmemeval/README.md).

## Reports

Newest first.

- [2026-10-28 LongMemEval-S official protocol](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/benchmarks/longmemeval/README.md#results): 500 questions, Haiku 4.5 reader, GPT-4o judge, 0.858 overall; oracle-context and Sonnet 4.5 reader baselines.
- [2026-09-06 external](skills-2026-09-06-external.md): ContinualSkillBench math, deterministic subset, baseline and harvested arms, primary model, six tasks, two trials.
- [2026-09-06](skills-2026-09-06.md): first run on the reference node; baseline and harvested arms only (no evolved skill live yet), primary model, frozen corpus, six tasks per suite, two trials.
