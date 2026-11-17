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
  model and task family. `skills.prior` stayed default off at this stage (switched on
  2026-11-06 for verified verbal evidence). Levers left
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

## Online experience study (2026-11-04)

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

### Result (2026-11-04, Claude Haiku 4.5, 64 cells x 8 episodes per arm)

| Arm             | e0    | e1    | e3    | e5    | e7    | Mean e1+ | Regret |
| --------------- | ----- | ----- | ----- | ----- | ----- | -------- | ------ |
| none            | 21.9% | 35.9% | 17.2% | 26.6% | 28.1% | 27.2%    | 340    |
| lessons         | 23.4% | 39.1% | 31.3% | 48.4% | 43.8% | 40.6%    | 279    |
| episodes        | 25.0% | 39.1% | 71.9% | 67.2% | 70.3% | 63.6%    | 175    |
| records         | 34.4% | 31.3% | 35.9% | 43.8% | 46.9% | 41.3%    | 269    |
| records-index   | 26.6% | 31.3% | 53.1% | 68.8% | 78.1% | 56.9%    | 204    |
| records-lessons | 31.3% | 37.5% | 48.4% | 48.4% | 46.9% | 44.9%    | 255    |
| bandit          | 21.9% | 32.8% | 43.8% | 54.7% | 64.1% | 49.6%    | 240    |

| Contrast (mean pass e1+, paired by cell) | W / L   | Delta    | Family-cluster CI | Holm p    |
| ---------------------------------------- | ------- | -------- | ----------------- | --------- |
| records minus lessons (primary)          | 19 / 21 | +0.7 pp  | [-13.4, 15.6]     | 0.68 *    |
| records minus none                       | 27 / 20 | +14.1 pp | [-0.4, 31.0]      | 0.57      |
| lessons minus none                       | 33 / 20 | +13.4 pp | [-2.5, 29.2]      | 0.20      |
| records-lessons minus records            | 21 / 17 | +3.6 pp  | [-11.8, 20.8]     | 0.63      |
| records minus episodes                   | 12 / 36 | -22.3 pp | [-40.2, -2.7]     | 1.00 \*\* |
| records-index minus records              | 32 / 15 | +15.6 pp | [-0.7, 30.6]      | 0.047     |
| episodes minus none (reference)          | 49 / 9  | +36.4 pp | [23.0, 49.6]      | <0.001 *  |

\* unadjusted sign-test p (primary or reference). \*\* one-sided test in the
predicted direction (records above episodes); the observed direction is the
opposite.

- The primary prediction failed: summarized counts in the notes did no better
  than model-written lessons (+0.7 pp).
- The raw episode log was the best memory format, by a wide margin: 63.6% mean
  pass after the first episode, +36.4 pp over no memory (49 / 9 cells), and
  above the Thompson-sampling reference (49.6%). This contrast was not the
  registered primary, so it is a finding to confirm, not a confirmed one.
- The gain runs through skill choice in every arm: when the last variant read
  is the right one, pass is 86 to 94%; when it is wrong, 2 to 10%.
- Mechanism: every memory arm repeats an accepted skill (95 to 99% stay after
  an accept). They differ after a rejection. Agents with the episode log
  switch away from the rejected skill (stay 33%, about chance among four);
  agents with counts in the notes go back to it 68% of the time, and with
  lessons 59%. Counts as `<evidence>` on the index (records-index) sit in
  between (37%) and recover most of the gap. Reading: a skill named in a
  memory note gets picked again even when the note says it failed.
- Thompson sampling keeps exploring after a win (stays 57%), which costs it in
  an 8-episode horizon with near-deterministic outcomes; a win-stay,
  lose-shift reader of the episode log does better here.
- Spend: about $46 (agent runs plus lesson calls).

### Confirmation study (registered 2026-11-05, before any run)

The episode-log result above was not the registered primary, so it gets its
own test. `--study confirm` uses fresh seeds (development 30000..) and six
arms: `none`, `records`, `records-verbal` (the same counts in words: "not
tried yet", "REJECTED every time it was used"), `records-index`, `episodes`,
and `episodes-noanswer` (skill and verdict only, no answer text). Run on
Claude Haiku 4.5 and OpenAI gpt-5.4-mini, 64 cells x 8 episodes per arm.

- Primary, per model: `episodes` minus `records`, per-cell mean pass over
  episodes 1..7, one-sided sign test (predicted positive) with
  family-cluster bootstrap.
- Secondary, Holm: `episodes-noanswer` minus `records` (event format alone),
  `episodes` minus `episodes-noanswer` (does the answer text matter),
  `records-verbal` minus `records` (are numeric counts the problem),
  `records-index` minus `records`.
- Reference: `episodes` minus `none`, `records` minus `none`, and the stay
  rate after an accept and after a reject per arm.
- Predictions: episodes above records on both models; most of the gap
  survives without the answer text; the records arms stay on a rejected
  skill more often than the episode arms.

```sh
node --import tsx benchmarks/skill-prior/online-run.ts --study confirm --episodes 8 --yes
node --import tsx benchmarks/skill-prior/online-run.ts --study confirm --episodes 8 --model openai/gpt-5.4-mini --yes
```

### Confirmation result (2026-11-06)

Mean pass over episodes 1..7, 64 cells per arm:

| Arm               | Haiku 4.5 | gpt-5.4-mini |
| ----------------- | --------: | -----------: |
| none              |     26.3% |        25.0% |
| records           |     45.3% |        34.6% |
| records-verbal    |     67.2% |        73.7% |
| records-index     |     61.4% |        46.7% |
| episodes          |     61.8% |        50.0% |
| episodes-noanswer |     59.8% |        63.6% |

| Contrast                         |                        Haiku 4.5 |                     gpt-5.4-mini |
| -------------------------------- | -------------------------------: | -------------------------------: |
| episodes minus records (primary) | +16.5 pp, 28/20/16, sign p 0.156 | +15.4 pp, 25/15/24, sign p 0.077 |
| episodes-noanswer minus records  |           +14.5 pp, Holm p 0.044 |          +29.0 pp, Holm p 0.0065 |
| episodes minus episodes-noanswer |             +2.0 pp, Holm p 0.50 |           -13.6 pp, Holm p 0.995 |
| records-verbal minus records     |           +21.9 pp, Holm p 0.023 |        +39.1 pp, Holm p < 0.0001 |
| records-index minus records      |          +16.1 pp, Holm p 0.0086 |            +12.1 pp, Holm p 0.24 |

Stay rate after a reject: records 58% (Haiku) and 68% (gpt), records-verbal
24% and 9%, episodes 28% and 60%, episodes-noanswer 29% and 36%. Stay after
an accept is 92-99% in every memory arm.

- The registered primary was not confirmed on either model. The effect points
  the predicted way on both (+16.5 and +15.4 pp, family-cluster CIs above zero)
  but the sign test, which counts many tied cells, does not reach 0.05.
- The clearest result is a secondary one: the same per-skill counts written in
  words ("REJECTED every time it was used") instead of numbers lifted pass by
  22 pp (Haiku) and 39 pp (gpt), the best arm on both models. The agent acts
  on a stated verdict and largely ignores a numeric tally.
- The answer text in the episode log does not help, and on gpt-5.4-mini it
  hurts (the log without answers is 13.6 pp better and abandons rejected
  skills more often).
- The mechanism prediction holds: numeric records keep returning to a rejected
  skill; verbal records and verdict-only logs move on.

Spend $34.70 (Haiku) and $18.79 (gpt-5.4-mini).

## Cross-agent evidence cards (registered 2026-11-14, run 2026-11-15)

Every study above has one agent. This one asks the network question
directly: at the same per-agent budget, is experience that other agents
earned worth more to a recipient than the experience it earned itself?

One recipient and three donors each work two episodes in every cell of the
latent-convention pool, with accept/reject feedback only and their own
earlier outcomes shown as `<evidence>` lines. Each donor then signs its
per-cell counts into a card bundle. The recipient verifies each bundle
(signature against the stated origin, a fixed set of trusted donor keys, no
cell claiming more runs than the budget, and a content hash per skill so a
card about an edited SKILL.md is dropped), and is evaluated on held-out
instances under twelve arms that differ only in the evidence lines:

| Arm                         | Evidence shown                                            |
| --------------------------- | --------------------------------------------------------- |
| `none`                      | nothing                                                   |
| `own-half`                  | the recipient's first half of its budget                  |
| `own`                       | the recipient's full budget                               |
| `peer1`                     | one donor's full budget                                   |
| `peer`                      | three donors' budgets, pooled                             |
| `own-half+peer`, `own+peer` | both sources                                              |
| `peer-liar`                 | the pool with one donor replaced by a signed false report |
| `stale`, `own+stale`        | a pool earned in a workspace with a different convention  |
| `placebo`                   | the pool's usage counts with no outcome                   |
| `oracle`                    | exact records                                             |

A line names its source, for example `Your own runs here: REJECTED every
time it was used (1 use). Runs here by 3 other agents: ACCEPTED every time
it was used (2 uses).` Every variant of the family gets a line once the arm
has any record in the cell, so "not tried yet" stays visible.

The unit of analysis is the cell, because a cell's instances share one
card. Intervals resample families and then cells within a family; tests are
exact one-sided sign tests over cells at 0.025. The confirmatory family is
tested in a fixed order, and everything after the first failure is
exploratory:

1. `peer` minus `own` (primary).
2. `peer` minus `placebo`.
3. (`peer` minus `none`) minus (`own+peer` minus `own`): the pool adds more
   where the recipient has no experience. Interval only.
4. `peer-liar` minus `none`.

The report also gives `peer1` minus `own` with its interval (no claim: 72
cells cannot support a useful non-inferiority margin), the pool's gain at
three levels of local experience, flips per task in both directions, and a
reference reader that uses each card perfectly, which is the ceiling the
shown records can support.

```sh
# Free dry run with a simulated reader; no model calls.
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase all --simulate

# The study: 2,304 episodes, about $30 on Claude Haiku 4.5 at the online
# study's price per episode. Resumable; stops at --ceiling-usd (default 50).
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase experience --yes
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase eval --yes

# Donors on another model (use a new output directory).
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase all --yes --donor-model openai/gpt-5.4-mini --out ~/bitterbot-skill-prior/cross-agent-gpt-donors
```

Limits: the pool is synthetic and its conventions are exact, so effects are
upper bounds. Agents share one host and exchange a signed file; the mesh
transport is not exercised. A pooled count is only as good as its sources:
the reference reader collapses in the `stale` and `peer-liar` arms, and what
the model does there is one of the things the study measures.

### Result (2026-11-15, Claude Haiku 4.5, 72 cells, 144 instances per arm)

The registered primary was **not confirmed**: pooled peer cards did not beat
the recipient's own experience (+5.6 pp, 95% CI [-9.0, 20.1], sign p 0.155).
Every later step is therefore exploratory.

| Arm      |  Pass | Arm           |  Pass |
| -------- | ----: | ------------- | ----: |
| none     | 19.4% | own+peer      | 68.8% |
| placebo  | 23.6% | own-half+peer | 66.0% |
| own-half | 31.9% | oracle        | 81.3% |
| peer1    | 47.2% | own+stale     | 41.0% |
| own      | 51.4% | peer-liar     | 10.4% |
| peer     | 56.9% | stale         |  4.9% |

| Contrast (per cell)                                              | Mean (pp) |    95% CI (pp) | Wins / losses / ties |
| ---------------------------------------------------------------- | --------: | -------------: | -------------------: |
| peer minus own (primary)                                         |       5.6 |   [-9.0, 20.1] |         21 / 14 / 37 |
| peer minus placebo                                               |      33.3 |   [19.4, 48.6] |          34 / 3 / 35 |
| coverage difference in differences                               |      20.1 |    [2.1, 38.2] |          30 / 9 / 33 |
| peer-liar minus none                                             |      -9.0 |   [-19.4, 2.1] |          8 / 21 / 43 |
| peer minus none                                                  |      37.5 |   [20.1, 55.6] |          38 / 3 / 31 |
| own+peer minus own                                               |      17.4 |    [5.6, 31.3] |          25 / 6 / 41 |
| own+peer minus own, recipient had no accepted variant (44 cells) |      25.0 |   [10.2, 43.3] |          20 / 2 / 22 |
| own+peer minus own, recipient had one (28 cells)                 |       5.4 |  [-10.4, 22.4] |           5 / 4 / 19 |
| peer1 minus own                                                  |      -4.2 |   [-18.1, 9.0] |         18 / 19 / 35 |
| peer-liar minus peer                                             |     -46.5 | [-63.2, -28.5] |          1 / 43 / 28 |
| stale minus none                                                 |     -14.6 |  [-24.3, -5.6] |          4 / 21 / 47 |
| oracle minus peer                                                |      24.3 |   [10.4, 38.9] |          27 / 4 / 41 |

What this supports: a peer's records are worth about as much as the same
amount of one's own experience, and a pool adds to own experience, mostly
where the recipient has not yet found an accepted variant. What it does not
support: that peers beat own experience. A pool read as summed counts is
worse than no card when one donor lies or when it comes from the wrong
workspace. 576 experience and 1,728 evaluation episodes, no errored runs,
$47.36 at list prices. Episodes that reached the 120 s timeout count as
failures in every arm; they concentrate in the multi-file-rename family.

### Follow-up: live pool, quorum and guard (registered 2026-11-15, run 2026-11-15)

Registered after an interim read of the first study (about one third of its
evaluation) and before any of these arms ran. The interim read showed two
things: donors repeat each other's exploration, and a pool read as summed
counts is undone by one lying donor or by a pool from the wrong workspace.

- **Live cohort** (`--phase live`): agents `l1..l3` work the same instances
  and index order as donors `d1..d3`, one after another within a cell, and
  each sees its own record plus everything the others have recorded there.
- **Quorum**: one vote per donor per variant; a verdict is shown only when at
  least two distinct donors agree and outnumber the dissent.
- **Guard**: a donor is dropped when its records contradict the recipient's
  own verified outcomes (3 or more contradictions that are at least 25% of
  the checks, across all cells), and the recipient's own record speaks for
  any variant it has tried. The thresholds were set from the experience
  phase, where honest donors contradict the recipient on 7 to 12% of checks.

Seven arms (`--phase eval2`) on the first study's instances, so contrasts are
paired by cell: `live`, `own+live`, `live-liar`, `live-liar-quorum`,
`own+liar`, `own+liar-guarded`, `own+stale-guarded`. In these arms the liar
is one fixed donor that lies in every cell.

Fixed-order family: (1) live minus peer, (2) live-liar-quorum minus none,
(3) own+liar-guarded minus own+liar. Same unit, interval and sign test as the
first study. Limits: the arms were designed after seeing interim data from
the same instances; the liar's records are substituted after the live cohort
ran, so it did not steer their exploration.

```bash
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase live --yes --ceiling-usd 85
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase eval2 --yes --ceiling-usd 85
```

#### Follow-up result (2026-11-15, same model and instances)

The registered first step was **not confirmed**: for the recipient, the live
pool did not beat the one-off pool (+5.6 pp, 95% CI [-7.6, 18.8], sign p
0.209). The two later steps meet their criteria and are exploratory.

During experience, on the same instances and index order:

| Pool             | Arrival 1 |     2 |     3 |     4 |     5 |     6 | Cells with an accepted variant | Distinct variants tried per cell |
| ---------------- | --------: | ----: | ----: | ----: | ----: | ----: | -----------------------------: | -------------------------------: |
| one-off (d1..d3) |     20.8% | 20.8% | 19.4% | 41.7% | 33.3% | 31.9% |                       49 of 72 |                             3.04 |
| live (l1..l3)    |     27.8% | 44.4% | 55.6% | 63.9% | 59.7% | 65.3% |                       54 of 72 |                             2.65 |

Arrival 1 has no evidence in either row, so its 7 pp gap is run-to-run noise.
Live agents reuse a variant once one is accepted (fewer distinct variants
tried), which raises their own pass rate but adds little coverage.

| Arm               |  Pass | Arm              |  Pass |
| ----------------- | ----: | ---------------- | ----: |
| live              | 62.5% | live-liar        | 17.4% |
| own+live          | 71.5% | live-liar-quorum | 54.9% |
| own+liar          | 43.1% | own+liar-guarded | 67.4% |
| own+stale-guarded | 50.0% |                  |       |

| Contrast (per cell)                      | Mean (pp) |   95% CI (pp) | Wins / losses / ties |
| ---------------------------------------- | --------: | ------------: | -------------------: |
| live minus peer (step 1)                 |       5.6 |  [-7.6, 18.8] |         22 / 16 / 34 |
| live-liar-quorum minus none (step 2)     |      35.4 |  [17.4, 54.2] |          37 / 7 / 28 |
| own+liar-guarded minus own+liar (step 3) |      24.3 |   [9.7, 39.6] |          30 / 4 / 38 |
| live-liar-quorum minus live-liar         |      37.5 |  [18.1, 56.3] |          36 / 4 / 32 |
| live-liar-quorum minus live              |      -7.6 |  [-18.1, 3.5] |         10 / 17 / 45 |
| own+liar-guarded minus own               |      16.0 |   [4.9, 29.2] |          24 / 7 / 41 |
| own+liar-guarded minus own+peer          |      -1.4 |   [-8.3, 6.9] |          9 / 12 / 51 |
| own+stale-guarded minus own+stale        |       9.0 |  [-5.6, 22.2] |         22 / 11 / 39 |
| own+stale-guarded minus own              |      -1.4 | [-12.5, 10.4] |          9 / 12 / 51 |
| own+live minus own                       |      20.1 |   [6.9, 34.7] |          28 / 8 / 36 |
| oracle minus own+live                    |       9.7 |   [2.1, 17.4] |          18 / 4 / 50 |

The guard dropped the lying donor (51 contradictions in 60 checks; honest
donors 4 of 58 and 5 of 60) and all three donors of the misapplied pool (19
to 21 contradictions in 47 to 64 checks). With the guard, a pool containing
a liar performs like an honest pool. Read by quorum, a live pool with a liar
recovers most of the honest pool's value without any own experience. 432
live and 1,008 evaluation episodes, no errored runs; $77.09 in total for
both studies.

### Replication of the defences (registered and run 2026-11-16)

The guard and the quorum met their criteria in the follow-up, but as steps
after a failed first step and in arms designed after an interim look. This
replication makes them the confirmatory family on data none of that touched:
fresh instances (`--seed-offset 5000` shifts every experience and evaluation
seed), a fresh recipient, and fresh one-off and live donor cohorts on a
second model (`openai/gpt-5.4-mini`). Arms, quorum size, guard thresholds
and the liar's construction are unchanged.

Arms (`--phase rep`): `none`, `own`, `own+peer`, `own+liar`,
`own+liar-guarded`, `live`, `live-liar`, `live-liar-quorum`.

Fixed-order family: (1) own+liar-guarded minus own+liar, (2)
live-liar-quorum minus none, (3) own+liar-guarded minus own. Same unit,
interval and sign test as before.

```bash
OUT=~/bitterbot-skill-prior/cross-agent-rep
ARGS="--seed-offset 5000 --donor-model openai/gpt-5.4-mini --out $OUT --ceiling-usd 55 --yes"
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase experience $ARGS
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase live $ARGS
node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase rep $ARGS
```

### Replication result (2026-11-16)

2,160 episodes (576 experience, 432 live, 1,152 evaluation), no errored run,
$32.02 at list prices. Recipient `anthropic/claude-haiku-4-5`; one-off and
live donors `openai/gpt-5.4-mini`. Protocol hash `0e3179319500e977`, written
before the first evaluation run. All three registered steps were confirmed.

| Step     | Contrast                        | Mean (pp) |  95% CI (pp) | Wins / losses / ties |   Sign p | Result    |
| -------- | ------------------------------- | --------: | -----------: | -------------------: | -------: | --------- |
| guard    | own+liar-guarded minus own+liar |      18.1 |  [4.2, 31.9] |          26 / 9 / 37 |   0.0030 | CONFIRMED |
| quorum   | live-liar-quorum minus none     |      29.9 | [10.4, 49.3] |          35 / 6 / 31 | < 0.0001 | CONFIRMED |
| net-gain | own+liar-guarded minus own      |      16.0 |  [6.3, 26.4] |          24 / 4 / 44 |   0.0001 | CONFIRMED |

| Arm              | Model pass |
| ---------------- | ---------: |
| none             |      28.5% |
| own              |      47.9% |
| own+peer         |      70.1% |
| own+liar         |      45.8% |
| own+liar-guarded |      63.9% |
| live             |      77.8% |
| live-liar        |      16.0% |
| live-liar-quorum |      58.3% |

The guard dropped the lying donor (53 contradictions in 71 checks) and kept
both honest donors (6 of 59 and 8 of 63).

Exploratory, with intervals and no claim: own+peer minus own +22.2
[9.7, 35.4]; live minus own +29.9 [13.2, 46.5]; live-liar minus none -12.5
[-23.6, -1.4]; live-liar-quorum minus live -19.4 [-34.0, -4.9] (the quorum
recovers 42.4 points of the liar's damage but not all of it);
own+liar-guarded minus own+peer -6.3 [-16.7, 3.5].

During the live phase the GPT cohort's pass rate by arrival was 33.3, 29.2,
55.6, 65.3, 72.2 and 77.8%, against 25.0, 25.0, 25.0, 31.9, 41.7 and 31.9%
for the one-off donors on the same instances, and it ended with an accepted
variant in 63 of 72 cells against 50.

Limits: one cohort of three per condition, so there is no between-cohort
variance; one liar in three, lying in every cell, with no collusion (two
colluding donors would pass a quorum of two); the guard needs the recipient
to hold records of its own; the pool is synthetic with exact conventions;
exchange is a signed file on one host. In this run the unguarded liar cost
the experienced recipient little against its own record (-2.1 pp); the
guard's gain is the pool's benefit it restores, not harm it removes below
the own-experience baseline.

### Published evidence

Raw records, reports, protocols and the signed bundles for all three
cross-agent studies are in [`published/`](published/README.md).
`published.test.ts` recomputes every gate step from the raw records and
verifies each bundle's signature.

## Runtime integration

Cross-agent cards are integrated in the runtime as of this change:
`src/agents/skills/skill-cards.ts` holds the pooling, quorum and guard
functions (this benchmark imports them from there, so what was measured is
what runs), and `skill-cards-runtime.ts` shows a quorum-agreed peer verdict
beside skills the node has not tried. The runtime bundle
(`bitterbot/skill-cards/2`) is keyed by skill content hash and travels on
the opt-in public package mesh. The runtime applies the guard and the
quorum together, a combination the studies did not run. See
`docs/memory/skills-pipeline.md`.

The live adapter can show evidence beside each skill when
`skills.prior.enabled` is explicitly enabled. `skills.prior.evidence` selects
`verbal` (default), `counts`, `verdict` or `off` (ordering only). The feature
itself remains **off by default**. Validation rollouts bypass it, and the
runtime never writes the ledger.

`verbalRecord` lives in `src/agents/skills/skill-prior.ts`; `online.ts` imports
and re-exports that same function. Its wording is unchanged, including
`REJECTED every time it was used (1 use)`, `ACCEPTED every time it was used
(3 uses)` and `accepted 2 of 3 uses, rejected the rest`. The runtime puts
this text in an `<evidence>` line inside the skill block. Zero-run skills
receive no line, although the benchmark prefix still says `not tried yet`.
The confirmation result tested verbal records in a prompt prefix; putting
that wording beside skills is an integration choice that still needs a
controlled live comparison, not an already measured combined effect.

The version-1 ledger has optional exact `verifiedEvidence: {passed, runs}`
counters per context cell and skill content hash. They are independent of
posterior discounting and hierarchical pseudo-counts. An update must pass
the existing eligibility/deduplication gate and explicitly set
`verified: true`. Deterministically scored benchmark callers do so; the
use-only negative control does not, and shuffled-cell controls discard the
counters. Legacy ledgers remain valid for ordering but show no evidence
until new verified outcomes arrive. Malformed counters, unknown hashes and
counts from another context or skill version cannot annotate.

Live calls currently use the `default` context cell. Benchmark truth-table
cells are not automatically live evidence, and this change adds no
production outcome writer. Keep the prior disabled until verified outcomes
can be attributed to a skill version and a meaningful context. A trusted
local file supplies the evidence; loading it does not independently verify
its producer.

To check formatter refactors without spending on new model runs, copy the
cached `online`, `online-confirm` and `conventions` directories outside Git,
then re-render before and after the change:

```sh
node --import tsx benchmarks/skill-prior/online-run.ts --study main --model anthropic/claude-haiku-4-5 --out "$COPY/online" --truth-from "$COPY/conventions" --max-runs 0 --episodes 8 --yes
node --import tsx benchmarks/skill-prior/online-run.ts --study confirm --model anthropic/claude-haiku-4-5 --out "$COPY/online-confirm" --truth-from "$COPY/conventions" --max-runs 0 --episodes 8 --yes
node --import tsx benchmarks/skill-prior/online-run.ts --study confirm --model openai/gpt-5.4-mini --out "$COPY/online-confirm" --truth-from "$COPY/conventions" --max-runs 0 --episodes 8 --yes
```

Compare report bytes excluding only the `Generated` line and any trailing
git provenance line, and compare protocol hashes exactly. The main study
has Haiku data only. Use isolated state and deny network access for a strict
cache-only check: the main runner initializes its lesson writer even when
all lessons are cached, and `--max-runs 0` limits agent runs, not lesson calls.
