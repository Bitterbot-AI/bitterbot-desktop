# Experience-guided skill prior: controlled test

Does validated experience change which skill the agent tries first, and does that
change outcomes? This harness tests the `skills.prior` mechanism
(`src/agents/skills/skill-prior.ts`: an outcome-gated, per-context-cell
Beta-Bernoulli bandit that reorders the `<available_skills>` index) with the
model, tools, verifier and candidate pool held fixed.

The design follows the research report "Test the skill prior as a gated bandit"
(reports/, 2026-11-01): the index-level insertion point, deterministic ground
truth from the canonical capability families, a controlled pool with
mere-appearance decoys, two abort gates before any treatment run, and the control
arms the agent-memory literature has not run (shuffled associations, global
success ordering, ungated co-occurrence).

## Pool

`pool.ts` writes 21 skills under `<out>/pool/<name>/SKILL.md`: for each of the
nine canonical capability families one CORRECT skill (its procedure solves the
family) and one DECOY (same routing description, a wrong rule in the body), plus
three unrelated fillers. Names carry the `xp-` prefix; the index is built from
the pool root alone, so no live skill is ever in the experiment.

## Phases

Every real turn is one embedded agent run on a throwaway validation session in a
scratch workspace that holds the task's files; memory writers are off; the
transcript dies with the trial. The journal lives at `<out>/journal.sqlite`,
never under `~/.bitterbot`. Runs are logged to `<out>/records.jsonl` and resumed
by key, and the run stops at `--ceiling-usd` (token usage at list prices).

```sh
node --import tsx benchmarks/skill-prior/run.ts --phase order    --seeds 3 --trials 1
node --import tsx benchmarks/skill-prior/run.ts --phase headroom --seeds 3 --trials 1
node --import tsx benchmarks/skill-prior/run.ts --phase arms --learn-seeds 6 --eval-seeds 4 --trials 2 --yes
node --import tsx benchmarks/skill-prior/run.ts --phase cards --variant underspecified --eval-seeds 6 --trials 1 --yes
```

| Phase      | Question                                                                                                                                                                                                                                                                                                                    | Abort rule                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order`    | With the whole pool in the index, does the first SKILL.md read depend on whether the family's correct skill is listed first or last (decoy adjacent)?                                                                                                                                                                       | If `readCorrect` does not move, the index-level insertion is inert; re-register around the pre-action interceptor. If almost nothing is read at all, the model routes on the task text alone. |
| `headroom` | Forced-skill truth table per instance: no skill, correct alone, decoy alone.                                                                                                                                                                                                                                                | If correct-forced minus no-skill is below the minimum detectable effect, the pool must be redesigned (the model does not need the skill).                                                     |
| `arms`     | Learn on development seeds with Thompson ordering; the treatment (cell = family), a context-free global ledger and an ungated co-occurrence ledger all see the same episodes. Freeze, then evaluate on qualification seeds: `baseline`, `global`, `prior`, `shuffled` (treatment weights permuted across cells), `ungated`. | Registered outcomes: contextual value, popularity only, no value, harm, inconclusive.                                                                                                         |

Seeds are partitioned 50/25/25 into development / qualification / final by
`sha256(salt:seed)` (`tasks.ts`); the final split is not touched by this harness.

`--variant underspecified` removes the clause that disambiguates the rule from
six of the nine prompts (inclusive range, zero-based index, transitive count, the
identifier format, negatives count, ERROR only), so the correct skill carries
information the task text no longer does. Truth is unchanged. Records and
reports for the variant carry a `-u` suffix. `--placement first|last` sets where
the top-ranked skill is listed (default `last`, see below).

## Pilot findings (2026-11-01, Claude Haiku 4.5, 3 development seeds)

- Order gate, fully specified tasks: the model read a skill in 89 to 96% of
  trials and, when the correct skill and its decoy were adjacent, read the
  LATER one (correct-first read the decoy in 7 of 27 trials, correct-last in
  0; 1 win / 6 losses on the paired diagnostic). The insertion is live and the
  preferred placement for this model is last, which is why `--placement`
  defaults to `last`.
- Headroom gate, fully specified tasks: no skill 81.5%, correct skill forced
  70.4%, decoy forced 66.7%. The correct skill cut date-window and regex-valid
  from 100% to 33%. Headroom is absent by the registered rule, so no treatment
  arm was run on that task shape; the underspecified variant exists because of
  this result.

## Analysis

`analysis.ts` pairs by task instance (same seed, family and files) and reports the
exact sign test and paired bootstrap CI the validation gate uses, per family.
`readCorrect` is the mechanism diagnostic; `pass` is the endpoint. Nothing here
writes to the live skill-prior ledger.

## Limits

Nine engineered families, one or two seeds per family per phase in the pilot, and
a single cheap model. These runs size the confirmatory study; they are not it.

- Arms, underspecified variant (54 learning episodes, 36 paired evaluation
  tasks on qualification seeds): pass rates were baseline 69.4%, global 72.2%,
  prior 69.4%, shuffled 80.6%, ungated 66.7%, and no pass contrast excluded
  zero. The prior LOWERED correct-skill reads against directory order (80.6%
  to 61.1%, 0 wins / 7 losses, CI excludes zero), with the top pick placed
  last or first alike (best-first re-evaluation on the same frozen ledgers:
  61.1%). The ledger learned the right associations (the correct skill had
  the highest posterior in 8 of 9 family cells); presenting that ranking as
  index order did not help. Paired inspection shows why: directory order
  happens to list each correct skill next to its decoy, while the prior
  isolates the correct skill at the top. Isolated, the model often read no
  skill at all and still passed; on ledger-sum it read the decoy three times
  out of three. Choice is driven by description match and a preference for
  later entries, not by rank.
- Registered outcome at pilot scale: no value for index reordering on this
  model and task family. `skills.prior` stays default off. Levers left
  untested: the pre-action interceptor (redirect a read of a low-posterior
  skill to its higher-posterior sibling) and withholding low-posterior
  entries, which would break the reorder-never-remove invariant and needs its
  own decision. Spend for all phases: about $12.40 at list prices.

## Evidence cards (2026-11-02, Claude Haiku 4.5, underspecified variant)

The `cards` phase shows measured outcomes instead of reordering: each skill's
index entry gets an `<evidence>` line with its verified record in the task's
family cell ("Verified record in past tasks like this one: 5 of 5 runs
passed.", `annotateSkillsPrompt` in `src/agents/skills/skill-prior.ts`).
Counts are exact, taken from the 40 gated learning episodes of the arms phase,
and frozen. Index order is directory order in every arm. Arms: `baseline` (no
card), `card` (real counts), `card-swapped` (the correct skill and its decoy
exchange records: if the model reads the numbers this should hurt), `card-text`
(the same verdict in words, no numbers). 54 paired tasks per arm on six
qualification seeds.

| Arm          | Pass  | Read correct | Read decoy |
| ------------ | ----- | ------------ | ---------- |
| baseline     | 72.2% | 68.5%        | 7.4%       |
| card         | 75.9% | 68.5%        | 7.4%       |
| card-swapped | 63.0% | 44.4%        | 29.6%      |
| card-text    | 77.8% | 66.7%        | 11.1%      |

- The model uses the evidence. Real against swapped counts: pass +13.0 pp
  (7 wins / 0 losses, CI [5.6, 22.2], p 0.008), correct reads +24.1 pp
  (15 / 2, p 0.001). Wrong numbers pull it to the decoy.
- Correct evidence adds little here: card minus baseline +3.7 pp pass, CI
  [-5.6, 13.0]. Without a card the model already read the decoy in only 7.4% of
  trials on this index, so there was little error for evidence to correct.
- Exact counts did no better than the same verdict in words (card minus
  card-text -1.9 pp, CI [-13.0, 7.4]).
- Registered reading: evidence shown next to the choice is causally used,
  unlike index order (arms phase), but on this pool its benefit is bounded by
  the baseline error rate; its main measured effect is that bad evidence
  misleads. That makes the accuracy of the record, not its presence, the
  thing to protect.
- The first run of this phase was invalid and is archived beside the records:
  the system prompt's skills compactor merged any `<skill>` block carrying an
  extra line into the next block, so annotated entries pointed at the decoy's
  SKILL.md. Fixed in `src/agents/system-prompt-skills.ts` (#351) before the
  run reported here. Spend for this phase, including the invalid run: about $9.

## Latent-convention twins (2026-11-03, Claude Haiku 4.5)

`conventions.ts` builds a harder pool: for each of nine families, four skills
(`xp-<family>-a..d`) share one routing description word for word, and their
bodies follow different house conventions (for example inclusive versus
end-exclusive date windows, ERROR only versus ERROR plus FATAL). Eight named
workspaces each have a hidden convention per family; each variant is right in
two of eight workspaces, assigned by a seeded shuffle, so no name or position
is right on average. Every instance is rejection-sampled so the four
conventions give four different answers. The memory cell is
`<workspace>:<family>`.

```sh
node --import tsx benchmarks/skill-prior/conventions-run.ts --phase train --train-seeds 2 --yes
node --import tsx benchmarks/skill-prior/conventions-run.ts --phase pilot --pilot-seeds 1
node --import tsx benchmarks/skill-prior/conventions-run.ts --phase main --eval-seeds 3 --trials 2 --families <list> --yes
```

- `train`: forced single-skill runs on development seeds (576). Only these
  verified runs feed the records; they also give the truth table.
- `pilot`: headroom gate with no card on separate development seeds. Rule:
  wrong variant opened first in at least 30% of trials and pass at most 65%.
- `main`: qualification seeds, six arms in the same randomized index order per
  instance: `none`, `card` (verified record per variant in this cell),
  `swapped` (the right variant's record exchanged with a wrong one),
  `placebo` (a usage line of the same shape with no outcome), `prior` (order by
  the learned ledger, top pick last), `prior-card`. The protocol is hashed on
  the first main run; a changed protocol needs a new `--out`.

Truth table: right variant forced 82.6% pass, wrong variant forced 0.2%
(144 / 432 runs). `multi-file-rename` failed with the right variant too (0 of
16: the agent cannot complete the rename in the validation sandbox), so the
registered rule excluded it from `main`. Pilot gate: pass 27.8%, wrong
variant first 69.4%: passed.

Main, 8 families x 8 workspaces x 3 seeds = 192 instances, 2 trials each:

| Arm        | Pass  | Read correct (first) | Read wrong variant (first) | pass^2 |
| ---------- | ----- | -------------------- | -------------------------- | ------ |
| none       | 26.8% | 27.6%                | 71.1%                      | 12.0%  |
| card       | 88.5% | 95.8%                | 3.4%                       | 83.9%  |
| swapped    | 1.3%  | 0.5%                 | 97.7%                      | 0.5%   |
| placebo    | 28.1% | 26.3%                | 72.7%                      | 13.0%  |
| prior      | 26.8% | 25.3%                | 74.0%                      | 15.1%  |
| prior-card | 87.5% | 96.1%                | 2.9%                       | 81.8%  |

| Contrast (pass)       | W / L / T     | Delta    | Family-cluster 95% CI | Holm p   |
| --------------------- | ------------- | -------- | --------------------- | -------- |
| card minus none       | 152 / 2 / 38  | +61.7 pp | [54.2, 69.5]          | primary  |
| card minus placebo    | 148 / 3 / 41  | +60.4 pp | [52.3, 68.0]          | < 0.0001 |
| card minus swapped    | 177 / 0 / 15  | +87.2 pp | [77.6, 95.1]          | < 0.0001 |
| prior minus none      | 42 / 41 / 109 | 0.0 pp   | [-7.0, 7.3]           | 1.0      |
| prior-card minus card | 13 / 17 / 162 | -1.0 pp  | [-5.2, 2.9]           | 1.0      |

- When the description cannot tell the variants apart, a verified record next
  to each one is what the agent chooses by: right first reads went from 27.6%
  to 95.8%. The placebo shows the content does the work, not the presence of
  an extra line.
- Ordering by the learned prior did not move the choice, alone or with cards,
  which replicates the arms-phase result on a pool built to give it room.
- Without cards the agent favours the first-listed variant (45.5% pass when
  the right variant is listed first, 18.7 to 22.2% otherwise); with cards
  position stops mattering (85.9 to 91.2%).
- Swapped records are followed almost perfectly (1.3% pass), so a wrong
  record is as strong as a right one. Record accuracy is the property to
  protect.
- Limits: one model; engineered conventions that never change within a cell;
  records exact by construction (100% vs 0%), so +61.7 pp is the upper bound
  for perfectly accurate evidence. Noisy or stale records, and a second model
  vendor, are the next tests. Spend for train, pilot and main: about $40 at
  list prices.

### Record accuracy (2026-11-03, same model and instances)

`--phase noise` re-runs `none` and `card` as anchors and adds records with a
controlled verifier error: each variant shows `n` logged runs whose true
outcome is flipped with probability `eps`. Draws are nested (a higher `eps`
only adds flips, `n = 10` extends `n = 5`). The ideal follower is a reader that
always picks the highest shown pass rate, ties split.

| Arm                 | Pass  | First read right | Ideal follower right | Minus none (pass, cluster CI) |
| ------------------- | ----- | ---------------- | -------------------- | ----------------------------- |
| none                | 28.1% | 27.6%            |                      |                               |
| card (real records) | 86.5% | 95.8%            | 97.7%                | +58.3 pp [50.3, 66.1]         |
| eps 0.1, n 5        | 89.6% | 97.7%            | 99.7%                | +61.5 pp [53.6, 69.0]         |
| eps 0.2, n 5        | 80.7% | 88.5%            | 95.9%                | +52.6 pp [43.5, 61.5]         |
| eps 0.3, n 5        | 68.0% | 72.9%            | 79.3%                | +39.8 pp [31.5, 48.2]         |
| eps 0.4, n 5        | 41.7% | 45.6%            | 48.8%                | +13.5 pp [3.9, 22.9]          |
| eps 0.3, n 10       | 75.3% | 82.0%            | 90.8%                | +47.1 pp [35.9, 57.8]         |

- The anchors replicate the main run (none 28.1% vs 26.8%, card 86.5% vs
  88.5%).
- Every noisy arm beats no records after Holm adjustment (largest Holm p
  0.0016, at eps 0.4). Evidence degrades smoothly with verifier error rather
  than collapsing.
- The model tracks the ideal follower closely: it is 2 to 8 pp below it on
  right first reads. When the shown records have a unique best, the model
  opens that skill first in 98.7% (real records) down to 84.4% (eps 0.4) of
  trials; the shortfall grows as counts get close.
- More runs offset a noisier verifier: at eps 0.3, ten logged runs instead of
  five raise pass by 7.3 pp (48 wins / 24 losses, p 0.003; cluster CI
  [0.0, 14.6]) and right first reads by 9.1 pp.
- Practical reading: a verifier that is right 80% of the time keeps most of
  the benefit (+52.6 pp); at 60% it keeps little (+13.5 pp). Show the run
  count, require a minimum before showing a record, and treat record accuracy
  as the quantity to protect. Spend for this phase: about $32.

### Second vendor (2026-11-04, OpenAI gpt-5.4-mini)

Same design, seeds, families and arms, with the model swapped
(`--model openai/gpt-5.4-mini`; phases tagged `cv-*@gpt-5.4-mini`, so the
records and protocol are separate). gpt-5.4-mini trained its own truth table
(512 forced runs: right variant 96.1%, wrong 0.8%) and passed the pilot gate
(none 23.4%, wrong-first 70.3%). Main: 192 instances x 2 trials per arm, no
errors.

| Arm        | Pass (gpt-5.4-mini) | Pass (Haiku 4.5) | First read right (gpt-5.4-mini) |
| ---------- | ------------------- | ---------------- | ------------------------------- |
| none       | 29.2%               | 26.8%            | 27.9%                           |
| card       | 80.5%               | 88.5%            | 85.9%                           |
| swapped    | 6.0%                | 1.3%             | 4.7%                            |
| placebo    | 31.0%               | 28.1%            | 31.0%                           |
| prior      | 22.1%               | 26.8%            | 20.6%                           |
| prior-card | 89.1%               | 87.5%            | 91.4%                           |

| Contrast (pass)       | Wins / losses | Mean delta | Cluster 95% CI | Holm p |
| --------------------- | ------------- | ---------- | -------------- | ------ |
| card minus none       | 138 / 4       | +51.3 pp   | [43.2, 59.4]   | <0.001 |
| card minus placebo    | 141 / 8       | +49.5 pp   | [41.1, 57.0]   | <0.001 |
| card minus swapped    | 168 / 1       | +74.5 pp   | [64.8, 83.6]   | <0.001 |
| prior minus none      | 33 / 55       | -7.0 pp    | [-14.3, 0.5]   | 0.99   |
| prior-card minus card | 39 / 12       | +8.6 pp    | [3.6, 14.3]    | 0.0002 |

- The primary result replicates across vendors: verified records lift pass by
  about 51 pp (Haiku 62 pp), the placebo line does nothing, and swapped
  records pull the model below its no-record rate.
- One difference: on gpt-5.4-mini the learned order adds to the cards
  (+8.6 pp, Holm p 0.0002), while on Haiku it did not (-1.0 pp). gpt-5.4-mini
  follows its cards less tightly (wrong first read 12.5% vs Haiku 3.4%) and
  has a stronger first-listed bias without cards (53.5% pass when the right
  variant is listed first vs about 20% otherwise). Putting the best-supported
  variant first therefore recovers trials where the card alone did not win.
  Order alone still does not help (-7.0 pp, CI spans 0).
- Spend for this replication: about $16 at list prices.

## Online experience study (design, not yet run)

`online-run.ts` drops the agent cold into each `<workspace>:<family>` cell of
the latent-convention pool and runs a stream of episodes with accept/reject
feedback only. What carries forward differs by arm, with retrieval held fixed
(same cell, all prior episodes): `none`, `lessons` (the same model writes a
two-sentence lesson after each verdict), `episodes` (skill used, answer,
verdict), `records` (accepted/runs per variant), `records-index` (the same
counts as `<evidence>` lines), `records-lessons`, and a `bandit` reference
(Thompson sampling picks the skill, forced alone into the index). Outcomes
are credited to the last variant read. Primary: records minus lessons on the
per-cell mean pass over episodes after the first; secondaries Holm-adjusted;
regret against the truth-table oracle. The protocol is hashed on the first
run. Pure logic and tests: `online.ts`, `online.test.ts`.

```sh
node --import tsx benchmarks/skill-prior/online-run.ts --episodes 8 --yes
```
