---
title: "Expanded telecom evidence study"
description: "81 audited comparison episodes show no reminder benefit; failure diagnostics identify missed roaming and allowance checks."
---

The expanded study is complete. **Baseline solved 24/27 episodes, static advice 23/27, and conditional reminders 22/27.** All 81 episodes completed naturally, with no interface failures or resource stops. All 3,339 model calls replay exactly from frozen sources, and provider charges reconcile with the existing SQLite research ledger. This panel provides no evidence to promote the conditional-reminder implementation.

The goal is to distinguish a working observation interface from improved task performance, then decide whether to test learned procedures and transfer. This study uses a host-authored reminder. It does not itself demonstrate autonomous learning, cross-user transfer or model-weight updates.

## Main comparison results

| Arm                   | Successful tasks | Success rate | Model calls | Native tool calls | Paid estimate | Uncached equivalent |
| --------------------- | ---------------: | -----------: | ----------: | ----------------: | ------------: | ------------------: |
| Baseline              |            24/27 |        88.9% |       1,151 |               459 |  $10.00771005 |          $29.632353 |
| Static advice         |            23/27 |        85.2% |       1,078 |               440 |   $9.16216095 |          $27.722529 |
| Conditional reminders |            22/27 |        81.5% |       1,110 |               435 |   $9.76196655 |          $28.571502 |

Conditional success was **7.4 percentage points below baseline** and **3.7 points below static advice**. The descriptive 95% case-cluster bootstrap intervals are −18.5 to 0.0 points and −22.2 to +11.1 points respectively. These are nine deliberately selected case clusters, not 81 independent tasks or a population significance test. The results support withholding promotion, not a general claim that conditional reminders are harmful.

Conditional execution averaged 1.52 fewer model calls than baseline (interval −5.04 to +1.44) and 1.19 more than static advice (−3.11 to +6.19). Neither establishes an efficiency gain. Lower spending alongside more unresolved handoffs is not evidence of better problem solving; uncached-equivalent costs also preserve that distinction.

Each cell below counts successes across three unseeded draws. All failures remain included.

| Case | Scenario                                                                  | Baseline | Static | Conditional |
| ---- | ------------------------------------------------------------------------- | -------: | -----: | ----------: |
| 4    | Mobile data: network preference, VPN, account roaming                     |      3/3 |    3/3 |         3/3 |
| 7    | Mobile data: airplane mode, network, data switch, data saver              |      3/3 |    3/3 |         3/3 |
| 20   | Service: airplane mode, APN, overdue suspension                           |      3/3 |    3/3 |         3/3 |
| 34   | MMS: network, data switch, account roaming                                |      3/3 |    3/3 |         3/3 |
| 36   | MMS: network, SMS permission, account roaming                             |      3/3 |    2/3 |         3/3 |
| 37   | MMS: airplane mode, permissions, allowance, both roaming settings         |      2/3 |    3/3 |         1/3 |
| 39   | MMS: APN, data switch, allowance, account roaming                         |      3/3 |    2/3 |         2/3 |
| 40   | MMS: Wi-Fi calling, APN, permission, allowance                            |      3/3 |    3/3 |         3/3 |
| 44   | MMS: airplane mode, network, APN, data switch, SIM, both roaming settings |      1/3 |    1/3 |         1/3 |

## Mechanism and failure findings

The conditional arm delivered **seven reminders in four of 27 episodes**, across only two distinct cases. Three deliveries went to case 40's first repetition, one each to its other repetitions, and two to case 39's failed second repetition. Case 40 already succeeded in every baseline and static repetition. Reminder delivery therefore does not establish an outcome improvement.

Only one of seven deliveries was followed immediately by an actor account lookup; the others were followed by customer device diagnostics or changes. This is a sequence observation, not proof that a reminder had no later influence. Public-only retrospective routing finds six eligible turns in each control arm and seven in the conditional arm; those control trajectories are not counterfactual model outcomes.

The conditional customer had both fresh diagnostic facts privately available at 19 publication events but omitted the complete pair at ten. The complete pair was public nine times. More reliable source availability alone will not solve selective publication or agent follow-through. Device mutations can also invalidate old references without offering new typed signal evidence, which motivated the separate status-bar candidate below.

All **12 failures ended in unresolved human handoff**. The [post-collection review](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip) exactly replayed each failed trajectory and added read-only native probes after termination. All original outcomes were unchanged:

- Nine failures left account roaming disabled: six case-44 failures, one case-36 failure and two case-39 failures. The six case-44 failures also left device roaming off.
- Three case-37 failures left allowance exhausted with no refill, after other device and roaming repairs.
- Both failed case-39 episodes had already refilled 2 GB successfully. Their remaining account-roaming problem was outside the single allowance reminder's scope.

These private final-state diagnostics were never fed to a model during the experiment. They identify missed prerequisites, not a measured learned repair policy.

A separate [offline repair probe](../../benchmarks/learning-strategy/data/telecom-evidence-failure-repair-v1.zip) replayed all 12 failed states and applied only these missing repairs. **All 12 passed the native verifier afterward.** Each recipe was then repeated with each single repair omitted: **all 18 omission controls failed**, with replay consistency and unrelated-state preservation intact. The probe used 30 cloned environments and zero provider calls. Its protocol and code were saved before execution. Recipes were host-authored from private final-state diagnostics; these are post-hoc sufficiency/necessity checks in the simulator, not revised trial scores, observed agent decisions, a consent test or evidence of learning.

## Prospective design

The main comparison panel was fixed before the first expanded compliance run: indices **4, 7, 20, 34, 36, 37, 39, 40 and 44**, with **three repetitions in each of baseline, static-advice and conditional-reminder arms**: 81 episodes over nine distinct cases. The panel combines two mobile-data cases, one service case and six MMS cases. It is a deliberately selected mechanism panel, not a random sample of real users.

The static arm receives the same rule predicates and text in its actor instructions. The conditional arm receives them only when public observations satisfy the rule. All arms use the same actor/customer interface and native tools. Each arm/repetition gets a sealed private SQLite store, and every episode gets a fresh native environment. Block order and case order rotate across repetitions; concurrent provider lanes and caching remain potential timing confounders.

All assigned failures count. Primary task success requires both a passing native verifier and natural termination. Reports separate interface failures, resource stops, unsupported reporting coverage, refreshed evidence, reminder eligibility/delivery, the next diagnostic action, model/tool calls and paid/uncached-equivalent costs. Paired differences are averaged within each case before a descriptive case-cluster bootstrap. Repetitions are not treated as independent tasks, and intervals do not establish population significance.

## Interface qualification record

| Run                              | Adapter | Design                      | Native successes | Interface failures | Reporting gate        |   Paid cost |
| -------------------------------- | ------- | --------------------------- | ---------------: | -----------------: | --------------------- | ----------: |
| `telecom-evidence-compliance-v1` | v7      | 3 fresh cases × 2 draws     |              1/6 |                5/6 | Failed                | $0.69466665 |
| `telecom-evidence-compliance-v2` | v8      | 3 new cases × 2 draws       |              6/6 |                0/6 | Coverage insufficient | $1.50758250 |
| `telecom-evidence-compliance-v3` | v8      | 2 fresh MMS cases × 3 draws |              4/6 |                0/6 | Passed                | $4.23600225 |

All 99 calls from v1 and all 195 calls from v2 replay exactly from their frozen sources and reconcile to the provider and SQLite ledgers. Neither run was silently retried or reclassified as passing its frozen gate.

In v1, all five rejected publications had valid source references but were accompanied by a textual preamble. The original adapter rejected this response shape before validating the payload. Adapter `text-v8-private-publication-preamble` now follows the same boundary used for other native tool calls: accompanying model text stays private, while only the explicit `share_observations.speech` and validated selected records reach the actor. Multiple tool calls, invalid references, stale evidence and unsupported public birth-date claims remain rejected. Regression tests verify both the five recorded payloads and actor/feedback privacy. All 43 focused tests and the native scripted qualification pass.

In v2, all six tasks succeeded with no interface failure. Three episodes never called either supported diagnostic tool, so they had no structured evidence to publish. Only one distinct case exercised refreshed diagnostic publication. The strict reporting gate therefore remained false. This is a coverage failure, not a new claim that successful account/payment workflows require irrelevant diagnostic calls.

A separate focused coverage panel used two prospectively selected, unused complex MMS cases, **46 and 47**, with three draws each. It used the same v8 adapter and unchanged reminder. All six completed naturally, published nonempty records and exercised refreshed evidence across both cases; all 374 calls replayed exactly. Four tasks succeeded and two ended in unresolved human handoff. The interface gate passed without changing its criteria. There were no reminder deliveries: interface coverage and reminder eligibility remain distinct.

The nine-case main comparison panel is identical in the frozen sources of all three qualification runs. No new task outcome was used to change its membership. The model is unseeded, so qualification outcome changes across distinct panels are not controlled estimates of the interface edit's benefit.

## Separate offline candidate

Inspection of the consumed qualification trajectories found fresh status bars returned by device mutations. The current paid adapter invalidates old records after these changes but does not expose fields from the returned status bar as selectable evidence. This can leave current signal evidence unavailable to the reminder even though the customer has just observed it.

The standalone `statusbar-probe.mjs` candidate is **not imported by the paid adapter**. Its [offline qualification](../../benchmarks/learning-strategy/data/telecom-statusbar-probe-v1.zip) replays six consumed trajectories, adds 58 read-only native network checks, and confirms all 101 projected field values against those checks. All six original native outcomes remain unchanged. Three unit tests cover malformed/duplicate outputs, role restrictions, private network names and misleading display semantics. No new provider calls were made, and all running comparison source hashes remained unchanged.

The native “Data Disabled” display can indicate lack of cellular connectivity even when the device's data switch is on. The candidate therefore never infers `device.dataEnabled=false` from that display. It projects only supported fields, excludes Wi-Fi names and other unrelated content, and never reads customer prose. These checks qualify a bounded parser for this pinned native serializer, not its future publication lifecycle, model selection of references or task benefit. Integration and fresh evaluation remain separate work.

## Decision and next experiment

Keep the v8 observation boundary and the repeatable evaluation infrastructure. Do not promote the allowance reminder or interpret this result as progress in autonomous learning. The next useful hypothesis is a **learned procedure that verifies unresolved prerequisites before handoff**, covering affected-line allowance, account roaming and the separate device roaming switch. It should request consent where required, reuse fresh evidence, test the requested service, and allow legitimate escalation.

Generate a bounded procedure from consumed development traces through the existing strategy archive, then compare unchanged baseline, a host-authored checklist, and the learned procedure on fresh cases. Freeze the procedure before evaluation; measure successful repairs, unnecessary changes, calls and cost. Only a successful source gate should permit a separate recipient comparison through the existing signed-transfer path. This would test whether experience improves another agent, which the current host-authored reminder experiment does not.

Do not spend the remaining fresh cases on more variants of this narrow reminder. The remaining unused supported indices are 5, 6, 9, 10, 11, 12, 13, 15, 48 and 49; verify the provider ledger again before assigning them. Main-study cases are now development evidence and cannot be described as fresh evaluation after tuning. Additional generated fault combinations would need native reference-repair and negative-control qualification before use.

## Audit, accounting and data

The expanded phase ran **99 paid episodes across 17 distinct cases**, including the three qualification attempts, with **4,007 model calls** and **$35.37008895** in estimated provider charges. The main comparison accounts for $28.93183755. Cumulative project exposure is $48.59322885, including the previously recorded unresolved $0.073722 reservation; all new requests are settled. The earlier $15 user cap was explicitly superseded. The main run's $75 engineering circuit breaker was not reached. Frozen list prices and usage receipts estimate charges; they are not an invoice.

The main audit verifies 79 unchanged source files, all exact request/response replays, final native judgments, scoped sealed SQLite stores, and provider/SQLite accounting. The lane audit confirms at most three requests in flight with no unresolved new reservations. Forty-three interface/runtime tests and the scripted native qualification passed before collection. Four protocol/provider concurrency tests and three separate status-bar parser tests also passed.

The generic reporting gate displayed in the main analysis is false because ten control/device episodes did not publish nonempty typed records. All ten succeeded without calling either supported diagnostic source (`check_network_status` or `can_send_mms`). This is distinct from an interface failure: the prerequisite focused qualification passed, and all 81 main episodes completed naturally. No outcomes were excluded or relabeled because of reporting coverage.

This is a custom text adaptation of pinned tau-bench v2 telecom tools with native environment assertions and an additional unrelated-state guard. It is not an official tau-bench score or a complete conversation-policy/consent evaluator. Actor and customer use the same model, there are only nine main case clusters, and no real users, live mesh transfer or autonomous learning were evaluated.

Reusable evidence:

- [Frozen protocol](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip)
- [Exact replay audit](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip)
- [Primary analysis and case-cluster intervals](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip)
- [One row per trial, including failure-state probes](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip)
- [Per-case results and all failed-trial diagnostics](../../benchmarks/learning-strategy/data/telecom-evidence-comparison-v1.zip)

Raw synthetic requests/responses, failed qualification gates, source snapshots and SQLite ledgers remain in `benchmarks/learning-strategy/results/`. No live agent or peer has been activated.
