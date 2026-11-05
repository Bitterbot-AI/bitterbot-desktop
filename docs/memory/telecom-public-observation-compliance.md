---
title: "Telecom public-observation compliance pilot"
description: "A two-case model pilot exposes stale references and incomplete publication; an offline follow-up makes current reference availability explicit."
---

The first real-model pilot of structured public observations **failed its compliance gate**. It cost **$0.29996850** against a $1 new-spend cap. Cumulative exposure is **$13.22313990 of $15**, including the older unresolved reservation; **$1.77686010** remains. There were no new unresolved requests, paid retries or replacement cases.

This is a small interface experiment in Bitterbot's existing shadow strategy lab. It establishes neither learning benefit nor recipient transfer. Neither native MMS problem was resolved. One episode stopped at an interface guard, so its final task failure cannot be attributed solely to the actor.

## Frozen pilot and results

The [protocol](../../benchmarks/learning-strategy/data/telecom-public-observation-compliance-v1.zip) selected two unused supported cases from pinned metadata before collection: case 29 covers APN/device roaming; case 33 covers permissions/SIM/account roaming. Each ran once with the original actor and the single missing-allowance reminder. There was no baseline or static-rule comparison. The pilot used adapter `text-v6-public-observations`, one sealed held-out panel in a fresh SQLite store and separate native environments.

| Case  | Termination                         | Model calls | Native tools | Valid nonempty reports | Reminders |        Cost |
| ----- | ----------------------------------- | ----------: | -----------: | ---------------------: | --------: | ----------: |
| 29    | Stale-reference publication blocked |          22 |            7 |                      1 |         1 | $0.12863160 |
| 33    | Human handoff, MMS unresolved       |          39 |           14 |                      5 |         0 | $0.17133690 |
| Total | Compliance gate failed              |          61 |           21 |                      6 |         1 | $0.29996850 |

All 61 requests, responses, public records, reminders, native actions and verdicts replay exactly from 66 frozen source files. Provider receipts reconcile to both the project budget and shadow SQLite ledger. The [audit](../../benchmarks/learning-strategy/data/telecom-public-observation-compliance-v1.zip) and [narrative review](../../benchmarks/learning-strategy/data/telecom-public-observation-compliance-v1.zip) preserve the result. Both cases are now consumed evaluation data.

The first audit invocation used `--import tsx`, which misclassified a TypeScript module reconstructed outside the repository. Running the same auditor with Node's native TypeScript support passed. This was an offline audit invocation correction; no provider request or episode was retried.

## What the episodes taught us

In case 29, the customer successfully published strong signal and failed MMS diagnostics. The reminder activated for the first time in these paid reminder studies. The actor nevertheless continued to APN diagnosis and resets without checking line allowance. Delivery therefore did not establish that the advice was followed or beneficial.

After the APN reset and reboot, a new MMS check produced source `obs-3`. The model tried to combine it with radio observations from `obs-2`, which predated those changes. The host rejected the entire report before actor delivery and retained the response's cost. The validation rule behaved correctly; the customer model did not reliably infer which older references had become invalid.

Case 33 showed the other problem. The model correctly reported restored signal using a fresh network check after reseating the SIM. Subsequent reports published only failed MMS, omitting still-valid signal evidence. Because each report is a complete public snapshot, the omitted signal was unknown to the reminder router. It correctly delivered no reminder. The actor eventually handed off without checking account roaming. Five fact refreshes, including a false-to-true signal change, were observed, but complete reporting was inconsistent.

The narrative review found no task identifiers, reference solutions or verifier assertions in actor-visible dialogue. It did find incidental unsupported narration about apps remaining after reboot. Typed observation validation does not establish general narrative factuality. Customer narration of other private diagnostics, such as SIM status, APN settings and permissions, remains explicitly spoken information rather than automatically published structured evidence.

## Offline implementation follow-up

Adapter `text-v7-current-references` adds a private, current list of valid fact/source references to every customer model request. The list is computed only from completed native tool events and the existing invalidation rules. It contains reference identifiers and fact names, not new observations or hidden state.

The list removes references invalidated by resets, writes or account scope changes and retains unaffected references. Instructions ask the customer to select relevant current earlier diagnostics alongside the newest result. Selection remains explicit; the host never publishes all available facts automatically. The actor and reminder router never receive the private list. Stale references still stop the episode.

Only the current request contains this list. It is not accumulated in conversation history, reducing repeated context and conflicting availability notices. This may improve reference selection, but its effect on model compliance and provider cost has not yet been measured.

Regression tests use the two consumed trajectories as development evidence. The first confirms that only the new MMS reference is available at the recorded failure and that the original stale publication remains rejected. The second confirms that surviving signal evidence is available to select after a permission change, while an MMS-only publication still cannot trigger the reminder. Additional checks cover request history isolation and private availability updates following actor account lookup. These are offline checks, not successful reruns of either task.

The [v4 offline qualification](../../benchmarks/learning-strategy/data/telecom-public-observation-qualification-v4.zip) passes **37 focused tests**, six native scripted fixtures, 72 wording/arm/condition checks and 144 empty/partial snapshot controls. All six fixtures also replay exactly after reconstructing 68 frozen source files in a separate temporary directory. The original 61-call paid pilot continues to replay from its own v6 snapshot after the follow-up. Lint passes on ten touched JavaScript files. The follow-up made **zero provider requests**.

Provider costs throughout this report use the study's frozen list-price usage rates, including cache usage. They are estimates from provider receipts, not invoice reconciliation.

## Decision and next boundary

Keep learning/transfer comparisons paused until the revised interface passes a separately frozen fresh-case compliance check. The next test should measure reference selection, relevant fact co-publication, reminder delivery and subsequent diagnostic actions separately. Preserve strict validation; do not weaken it to turn this pilot into a pass.

Broader prompt evolution still lacks evidence of recipient benefit. Verified reusable procedures remain the more useful next learning hypothesis once interface reliability is adequate. Nothing from this experiment is activated in a live agent or shared to peers.

Replay the paid evidence without new model calls:

```sh
node benchmarks/learning-strategy/telecom/compliance-audit.mjs benchmarks/learning-strategy/results/telecom-public-observation-compliance-v1
```

Run focused offline checks:

```sh
node --import tsx --test benchmarks/learning-strategy/telecom/telecom.test.mjs benchmarks/learning-strategy/telecom/diagnostic-observations.test.mjs benchmarks/learning-strategy/telecom/public-observations.test.mjs benchmarks/learning-strategy/telecom/current-references.test.mjs benchmarks/learning-strategy/telecom/compliance-report.test.mjs
```

The compliance collector keeps its consumed-case rejection and fixed spending limits. Its original cases cannot be used for another paid pilot. A new experiment requires a separate prospective protocol; the frozen paid source copies and outcomes remain unchanged.
