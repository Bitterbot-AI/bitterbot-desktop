---
title: "Conditional reminder experiment: completed comparison"
description: "Eighteen audited episodes found no conditional benefit: the narrow observation adapter delivered zero reminders."
---

The completed 18-episode comparison did **not** establish a benefit from conditional reminders. Baseline passed 5/6 episodes, static rules passed 6/6, and conditional rules passed 5/6. The conditional arm delivered **zero reminders**, so its outcomes cannot establish a causal benefit or harm from the reminder mechanism. Its preregistered exploratory gate failed against both controls. Keep the implementation in shadow research; improve observation coverage and simulator grounding before another paid comparison.

This followed the [additive strategy experiment](telecom-additive-learning-and-transfer.md), which tied recipient accuracy while using more calls and money. One earlier detour toggled mobile data off although the setting was already enabled. Conditional rules were intended to deliver small corrections using only information already visible to the actor.

## Completed results

All 18 assigned executions ended naturally, with no retries or resource censoring. A human handoff on an unresolved task counts as failure. [Replay auditing](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) passed for all **630 model calls**, 49 frozen source files, native tool trajectories, exact requests, judgments and SQLite/provider costs. There was no frozen-source drift at audit time.

| Arm               | Successes | Model calls | Tool calls | Provider cost | Uncached price equivalent |
| ----------------- | --------: | ----------: | ---------: | ------------: | ------------------------: |
| Baseline          |       5/6 |         220 |         78 |     $0.824561 |                 $4.727277 |
| Static rules      |       6/6 |         215 |         85 |     $0.838027 |                 $4.791621 |
| Conditional rules |       5/6 |         195 |         67 |     $0.685964 |                 $4.225695 |

The [frozen analysis](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) retains every trial. Model and tool calls include both actor and simulated customer. Uncached equivalents price all observed input tokens at the same base rate; they are counterfactuals, not additional charges or latency measurements.

The conditional arm has one paired accuracy regression against each control: case 42 in repetition 1. It also solves case 32 where the second baseline repetition failed, leaving their aggregate accuracy tied. Static rules have the strongest observed accuracy, with five fewer model calls but seven more tool calls and 1.6% more provider cost than baseline. Three cases with two unseeded repetitions cannot establish a stable advantage, and these rules were host-authored rather than learned in this study.

The apparent conditional efficiency is misleading. Its failed case 42 ends after 12 model calls and one tool call; the matched baseline uses 48 model calls and 18 tool calls to succeed. That failed pair accounts for more than the conditional arm's entire net model/tool saving against baseline. No failed episode is removed or rerun to improve the comparison.

## What the traces revealed

[Post-collection diagnostics](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) mark the mechanism **unexercised**: zero deliveries in all six conditional episodes. A new read-only `telecom/diagnose.mjs` makes this activation check reusable without changing the frozen analysis or gate. It also counts tool actions; none of the 18 episodes toggled mobile data OFF, so this panel did not reproduce the earlier bad-toggle behavior.

Two coverage gaps are directly visible. In conditional case 42, the customer says “I'm currently abroad,” which the narrow matcher does not recognize. In both conditional case 32 executions, the actor obtains usage from line records and the allowance from a separate plan record. The extractor only derives exhaustion from `get_data_usage`, which neither trajectory calls. The actor eventually refuels without a reminder. An adapter that joins these records must bind them to the requested line and matching plan; inspecting another line must not contaminate the customer's current facts.

The two failures have different causes:

- `baseline-1-32` repairs connectivity, checks several device settings, resets the APN and reboots, then hands off without checking/refueling the exhausted allowance. A rule triggered only after exhaustion is already observed cannot recover a missing diagnostic check. A future rule should consider a still-failing service, verified connectivity and an unknown allowance, using public evidence only.
- `conditional-1-42` receives a fabricated birth date from the simulated customer. The scenario supplies name and phone number but no birth date. The actor then adds a requirement for matching birth date even though the supplied policy permits phone lookup, and refuses both account help and device troubleshooting. This is a simulator grounding defect interacting with an actor policy error. No reminder fired, and the failure stays in the primary result.

These are post-collection diagnoses, not revised efficacy endpoints. Cases 1, 32 and 42 are now consumed evaluation data and may only support development after tuning.

## Follow-up implementation

The [offline observation and simulator qualification](telecom-observation-qualification.md) implements the extraction and grounding fixes below. With rule text unchanged, the revised router activates on 3/6 original conditional trajectories and 14/24 combined development trajectories, while keeping all six simple domestic controls quiet. A bounded guard intercepts the recorded invented birth date. This follow-up made no new model calls and does not change the paid results above.

The revised adapter strengthens the customer simulator's handling of unknown identity/account facts, supports explicit self-reports such as “currently abroad,” and derives account facts from matching line/plan observations. It preserves uncertainty, entity boundaries, invalidation and the exclusion of private customer tool output. Its birth-date guard is bounded and does not establish general simulator factuality.

The missing-allowance-check condition remains a separate candidate to develop. Require demonstrated positive and negative trigger coverage before freezing another fresh panel. The new diagnostic explicitly distinguishes activation from successful outcomes; activation alone would still not prove a benefit. Retain static rules and a simple verified-procedure control in future comparisons before attributing gains to autonomous or distributed learning. No additional paid run or live promotion was performed after this collection.

## Implemented behavior

The existing strategy schema now accepts up to four optional reminders, each with a bounded text instruction, Boolean/unknown trigger predicates and an optional conjunctive suppression condition. A new `conditional` proposal mode preserves the parent actor text and the fixed proposer while changing reminder data. Rules cannot execute code, register tools, change permissions or change the verifier. Old strategies retain their existing hashes when they have no reminder field.

`StrategyReminderSession` holds facts and evidence references for one episode. Unknown differs from false. It emits a matched reminder once for an unchanged evidence state, suppresses a rule when its skip conditions hold, and re-arms after relevant facts change or are invalidated. Repeated identical reports do not create repeated advice. Reset discards observations between episodes/entities. Hosts declare and freeze the fact vocabulary they interpret; incompatible panels reject conditional candidates before execution instead of silently ignoring reminders.

The telecom host consumes actor account-tool results and public customer speech only. It cannot see customer-private tool outputs, initialization state, reference repairs or grader details. Explicit diagnostic labels provide configured switch values. The status-bar phrase `Data Disabled` supplies an availability cue, not proof that the configured switch is off. Account allowance calculations include refueled data. Possible device-changing requests invalidate device observations; account mutations invalidate account observations. Customer or line changes discard affected state.

Matched advice is inserted into the actor's current observation message and logged with evidence references. It is not sent to the simulated customer. Earlier advice remains chronological context, with instructions to recheck after changes; this is advisory guidance, not a hard prohibition on tool actions. The existing policy remains authoritative.

Extraction deliberately recognizes a narrow set of explicit phrases and diagnostic labels. It is not a general natural-language state tracker. Unsupported paraphrases can miss triggers, and broad mutation-word detection can invalidate facts unnecessarily. These limitations are part of the mechanism being tested; they should not be hidden by reading private simulator state.

The first four rules are **host-authored hypotheses** based on previous development evidence. The framework supports generated rule proposals, but this experiment does not claim autonomous rule discovery or recursive improvement.

## Local qualification

The reminder/session and strategy tests check unknown versus false, evidence references, duplicate suppression, invalidation, reset, conjunctive suppression, schema bounds, preserved actor text, unsupported-host rejection, and immutable panel vocabulary. Native adapter tests exercise role isolation, private-tool exclusion, actor-only advice delivery, account allowance/refueling and customer changes.

All 29 focused tests passed (21 strategy/session/route tests and eight native adapter tests). Repository TypeScript checking, targeted formatting and lint checks passed. The previous additive study's 288 recorded model calls and six episodes still replay correctly with their frozen source snapshots. No new model-benefit claim follows from these engineering checks.

[Offline trace qualification](../../benchmarks/learning-strategy/telecom/qualification-reminders-v1.json) routes reminders over the six old additive-study trajectories without model calls. In the recorded bad-toggle trajectory, the first ambiguity reminder appears before transcript position 19, preceding the toggle that turned data off at position 21. This verifies the trigger location only: the historical actor was not rerun, and no outcome improvement is inferred. Those traces are now development evidence.

## Frozen study design

The [frozen protocol](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) defined 18 executions: three cases, two repetitions and three arms.

| Arm               | Instructions                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| Baseline          | Original actor instructions                                              |
| Static rules      | Original actor plus all four reminder texts and their conditions         |
| Conditional rules | Original actor plus reminders selected from current visible observations |

The static arm uses the same rule content as the conditional arm, making it a stronger control than the previous unrelated broad rewrite. Selection also changes timing and placement, so this is not a pure single-variable experiment. No verified-procedure-reuse control or new network transfer is included.

Cases 1, 32 and 42 cover a simple domestic mobile-data problem, an MMS/data-allowance combination, and an MMS/device-data/roaming combination. No actor in prior collections had executed these cases. Selection used host-side benchmark metadata before collection, not model outcomes. The cases remain in the same telecom task families; this was intended to exercise the mechanism, not measure representative performance. As observed above, scenario coverage did not ensure trigger activation.

Arm order is reversed on the second repetition; case order is reversed too. Each arm/repetition gets a fresh SQLite store and sealed candidates, and each episode starts a fresh native environment. The collector freezes all inputs and sources before any provider request and refuses to run changed sources. No within-run tuning or retries are allowed. Sampling remains unseeded, and two repetitions are exploratory.

The analysis requires all 18 natural completions before assessing the mechanism. It reports paired success changes, model/tool calls, billed costs and uncached price equivalents. The small exploratory gate requires no per-pair accuracy regression, no aggregate model/tool/uncached-price increase against either control, and at least one strict resource reduction against each. Passing this gate would warrant further experiments, not production promotion. All selected cases become consumed evaluation data after running.

## Budget and execution status

The user explicitly approved raising the cumulative cap from **$10 to $15** and running the frozen 18-episode comparison. [Authorization](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) and the [completion record](../../benchmarks/learning-strategy/data/telecom-conditional-comparison-v2.zip) are saved with the evidence. Historical preparation/preflight files remain unchanged.

The run used **$2.34855195** of new provider usage, below the $3–$5 estimate. Known cumulative priced usage is **$11.61194025**; the earlier unresolved reservation remains **$0.073722**. Total cumulative exposure is therefore **$11.68566225 of $15**, leaving **$3.31433775**. This run has no unresolved or active reservations. Prices are frozen list-price estimates from usage receipts, not invoices. Auditing and diagnostics made no model calls.

The collector required at least $5 available headroom to start and reserved conservative request liabilities throughout. The initial preparation v1 was superseded by v2 before any paid collection to include a lint-only source correction. No study source, rule, model, case assignment or budget was changed during collection.

Reproduction:

```sh
node --test benchmarks/learning-strategy/telecom/telecom.test.mjs
node --import tsx benchmarks/learning-strategy/telecom/conditional.mjs prepare unique-study-id
# Defaults to $10; this completed study used the explicitly approved $15 cap:
node --import tsx benchmarks/learning-strategy/telecom/conditional.mjs run unique-study-id 15
node benchmarks/learning-strategy/telecom/audit.mjs benchmarks/learning-strategy/results/unique-study-id
```

After saving a successful audit's stdout as `audit.json`, telecom `analyze.mjs` reports the three-arm comparison. Save that output as `analysis.json`, then run `telecom/diagnose.mjs` on the same result directory for activation and tool counts. Existing result directories must not be overwritten. A future paid study needs new prospectively selected cases and its own frozen protocol; the completed cases cannot be rerun as fresh evaluation. Frozen source snapshots and historical reports must not be edited.
