---
title: "Telecom observation and simulator qualification"
description: "Offline fixes recover missing reminder triggers and intercept an invented customer birth date without new model spending."
---

The [18-episode comparison](conditional-reminders-experiment.md) delivered no conditional reminders. The revised adapter now finds reminders in **3 of those 6 conditional trajectories**, while leaving all six simple domestic control trajectories quiet. Across 24 recorded trajectories from that comparison and the earlier additive study, activation rises from **6 to 14**. These are offline routing results on consumed development evidence; no model decisions or task outcomes were rerun.

The changes remain in the existing telecom benchmark adapter. The core strategy schema, four reminder rules, model, native tools and native verifier are unchanged. Nothing is activated in live Bitterbot sessions or distributed to peers.

## Implemented changes

The observation extractor accepts explicit current travel reports such as “I'm currently abroad” and “I'm in France, so I'm abroad.” Questions, quoted third-person reports, past travel, supported negative reports and hypothetical trips have separate negative tests. Contradictory reports invalidate the fact. This remains bounded phrase recognition rather than general language understanding.

Account observations now join line usage to that line's observed plan allowance. The target follows the phone used in customer lookup, which may differ from the account's primary contact number. Ownership and IDs must agree; inspecting another line cannot overwrite current facts. Single-line accounts can be resolved without a phone target. Direct usage responses must belong to the known customer and line. Missing or malformed values stay unknown, refueling invalidates cached values until fresh observations arrive, and customer/phone changes discard affected state. Tool names such as `toggle_data()` also invalidate device observations.

The simulated customer is explicitly instructed to use declared identity/account knowledge and admit missing information. A narrow birth-date guard additionally catches explicit ISO or English month-name assertions unsupported by the scenario's `known_info`. It never reads the account database or infers a date from persona age. A rejected public response stops that episode with `simulator-grounding-failure`, remains charged and preserved in the transcript, and is excluded from actor delivery and learning feedback. There is no silent retry. Such an episode is invalid for a naturally completed comparison, even if the native state happened to be repaired already.

The adapter revision is now `text-v4-grounded-observations`. Collector snapshots include the new grounding module. The learning collector rejects historical baselines from an older simulator revision before creating a run or dispatching requests; fresh baseline and candidate arms must share the revised simulator.

## Offline evidence

The [qualification result](../../benchmarks/learning-strategy/data/telecom-observation-qualification-v1.zip) compares the frozen v3 router with the revised router over identical recorded observations. Customer-private tool results and speech accompanying tool calls remain excluded. Routing stops at handoff, customer termination or a grounding failure. The four reminder definitions are checked for exact equality between versions.

| Recorded trajectories                        | Frozen router | Revised router |
| -------------------------------------------- | ------------: | -------------: |
| Any reminder, all 24 trajectories            |          6/24 |          14/24 |
| Any reminder, original conditional arm       |           0/6 |            3/6 |
| Any reminder, simple domestic controls       |           0/6 |            0/6 |
| Unsupported birth-date responses intercepted |             0 |              1 |

The guard catches `conditional-1-42` at transcript position 2, before the invented birth date reaches the actor. This would censor the trajectory; it is not counted as a repaired task. The historical result remains a failure in the original analysis.

The revised router produces seven ambiguity reminders, nine abroad reminders and nine exhaustion reminders across the 24 trajectories. The `data-already-enabled` rule has positive unit coverage but still no activation in these recorded traces. Repeated deliveries can follow changed or invalidated observations; more deliveries are not automatically better behavior.

All **15 focused adapter tests passed**, including ownership/line isolation, joins in either observation order, stale-data invalidation, positive and negative travel reports, private-tool exclusion, grounding failures, cost retention and feedback filtering. Targeted lint passed on ten files. Replaying the original study still passes all 18 episodes and 630 recorded model calls against its frozen sources. The [validation record](../../benchmarks/learning-strategy/data/telecom-observation-qualification-v1.zip) and twelve source snapshots preserve this revision.

## Remaining experiment questions

The rules still do not address a missing diagnostic check: `baseline-1-32` never observes its exhausted allowance, so a rule triggered after observing exhaustion cannot intervene. A separate candidate should use an unresolved service, verified connectivity and an unknown allowance to suggest the missing check. That candidate needs its own positive/negative coverage and comparison; it was not mixed into this extraction fix.

The birth-date guard does not establish general simulator factuality and does not catch every date paraphrase or other invented fact. Prompt grounding has not yet been tested with fresh model responses. The observations are also from seven task indices within one synthetic telecom family, not independent real users.

Before any efficacy claim, freeze a fresh panel with baseline, static and conditional controls under the same v4 simulator. Verify actual activation and simulator validity as well as task success, calls and cost. The old trajectories are now development data. The existing 18-episode collector's $5 minimum headroom exceeds the remaining budget, so it cannot be repeated under the current cap without a separately defined smaller protocol or further authorization.

This continuation used **zero new provider calls**. Cumulative exposure remains **$11.68566225 of $15**, leaving **$3.31433775**, including the older unresolved reservation.

Reproduction with the current qualified sources:

```sh
node --test benchmarks/learning-strategy/telecom/telecom.test.mjs
node benchmarks/learning-strategy/telecom/qualify-observations.mjs benchmarks/learning-strategy/results/telecom-conditional-comparison-v2 benchmarks/learning-strategy/results/telecom-additive-transfer-v1
node benchmarks/learning-strategy/telecom/audit.mjs benchmarks/learning-strategy/results/telecom-conditional-comparison-v2
```

These commands perform no paid requests. Preserve existing result files and frozen source copies.
