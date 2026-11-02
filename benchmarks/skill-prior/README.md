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
