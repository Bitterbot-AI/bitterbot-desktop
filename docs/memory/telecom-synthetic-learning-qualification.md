---
title: "Synthetic telecom learning: native qualification and first correction"
description: "A runnable shadow adapter, verified synthetic workflows, one repaired failure, one lost success, and a blocked transfer."
---

The synthetic workflow adapter now runs through Bitterbot's existing learning-strategy archive, panel evaluator and SQLite resource ledger. The first baseline completed **3 of 4 cases successfully**. One generated correction fixed the failed MMS case but failed a previously successful mobile-data case. On the two source cases, success remained **1/2 before and 1/2 after**. The candidate failed the source gate, so no peer transfer or held-out recipient experiment ran.

This establishes a working test facility and a concrete failure mode for instruction-based learning. It does not establish an improvement from collective learning, a stable regression rate, or superiority over verified procedure reuse.

**Subsequent result:** the [additive follow-up](telecom-additive-learning-and-transfer.md) repaired both source cases and completed recipient transfer. Both recipient arms passed 2/2, with the transferred strategy costing more. The historical observations and costs below remain unchanged; the follow-up report contains current cumulative accounting.

## Implementation and qualification

The [adapter](../../benchmarks/learning-strategy/telecom/README.md) runs a fresh Python sidecar for every episode. It imports 28 byte-exact source/data files from tau-bench commit `989d3285ae669e49503324bdb9981bf14fccedeb`, with native tool implementations, initialization and environment assertions. The [original data bundle](../../benchmarks/learning-strategy/datasets/tau-bench-v2-en/README.md) contains 150 English tasks; this adapter supports its 41 telecom cases with only environment-assertion grading. Tasks requiring additional action grading are rejected.

All 41 reference repairs pass. All 41 no-op executions fail, and all 41 executions omitting the first required repair fail. Strict replay reproduces the live states. A supplementary guard detects changes to unrelated accounts, lines, bills, plans and server devices; 41 deliberate account corruptions are detected. These checks validate this selected execution path; they are not a comprehensive policy-compliance or natural-language grader.

Models receive normal native tool schemas and can reason before making tool calls. Actor and customer maintain separate conversations and private tools. Hidden task IDs, initialization state, reference solutions and grading criteria remain host-only. The actor sees customer speech and its own account-tool responses. The user simulator receives its private scenario and device tools. Neither receives intermediate grades.

The implementation uses a custom text interaction loop and pinned `claude-sonnet-4-6` for both roles. It uses the English task overrides, but does not reproduce all upstream persona/language bindings or claim official tau-bench scores. Process isolation resets fictional databases; the models cannot submit arbitrary executable code.

## Paid observations

The baseline froze four development cases before model calls. These intentionally span simple and multi-repair problems, rather than representing a random accuracy sample.

| Task index | Workflow                         | Baseline | Learned instruction                                             |
| ---------- | -------------------------------- | -------- | --------------------------------------------------------------- |
| 0          | Two-repair mobile data           | Pass     | Not evaluated                                                   |
| 14         | Seven-repair mobile data abroad  | Pass     | Fail at human handoff; collector later reached its budget limit |
| 21         | Seven-repair service restoration | Pass     | Not evaluated                                                   |
| 45         | Nine-repair MMS abroad           | Fail     | Pass                                                            |

In baseline task 45, the actor repaired device settings, roaming and permissions but never addressed exhausted data. It escalated with MMS still broken. Task 14 had previously demonstrated successful data refueling.

The source learning panel reused those two baseline observations at zero additional provider cost, with explicit attribution to the paid pilot. The proposer received a bounded projection of actor-visible account-tool observations, the initial complaint and binary outcomes. Identifying values were removed. It did not receive reference actions, native assertion details, private customer tool results or reserved-case feedback. **This projection omitted much of the device-side dialogue**, which limits conclusions about the learning method.

Exactly one proposal was generated. The actor instructions expanded from general troubleshooting guidance into a longer flow emphasizing data availability and roaming. The proposer itself stayed fixed. On source re-evaluation, the actor fixed task 45, but in task 14 it checked account-side roaming and failed to enable device-side roaming. It then escalated with connectivity unresolved. Single unseeded executions of both actors and customers do not establish that the instruction change caused a repeatable regression.

The predeclared source gate required both source cases to succeed and a strict improvement over baseline. It failed. The signed-envelope transfer stage is implemented, but it did not export or import this candidate. Reserved recipient cases 38 and 41 were not run. No live skills or peer memories changed. This was a one-correction test, not recursive proposer evolution or a comparison against ordinary verified caching.

## Handoff defect and repair

The first collector waited for the customer simulator to end the conversation after a successful `transfer_to_human_agents` call. Sometimes the customer kept exchanging farewells while waiting for a human. The baseline MMS failure incurred 16 extra model calls costing **$0.19541640**; the learned mobile-data failure incurred 26 extra calls costing **$0.38235660**. All of that spend remains in the accounting.

The current adapter stops immediately after a successful handoff and executes no subsequent bundled tool calls. A regression test verifies this behavior. This is an explicit host termination rule for our adaptation; upstream text simulation has its own transfer/stop signaling.

The paid runs remain frozen with their original collector. The audit recreates their source trees in temporary directories and replays every recorded model response, reconstructing the exact requests and native outcomes without new model calls. A separate post-collection diagnostic replays each failure only to its first handoff: both were already native failures, with unrelated state preserved. Thus the farewell defect affects costs and termination classification, but does not explain away either repair failure. The corrected collector has been tested locally; it has not been used for another paid collection.

## Costs and evidence

| Collection                            | Model calls | Paid episodes |   Provider cost |
| ------------------------------------- | ----------: | ------------: | --------------: |
| Native baseline pilot                 |         169 |             4 |     $1.51320420 |
| One proposal and source qualification |         121 |             2 |     $1.34884965 |
| Total added in this work              |         290 |             6 | **$2.86205385** |

The proposal accounts for one call and $0.016233 of the second row. Actor and simulated-customer calls, including post-handoff overhead, are included. Rates use the [Anthropic pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing), checked November 2, 2026, with five-minute cache writes charged at their distinct rate. These are list-price estimates, not invoices.

Across this learning-strategy project, known paid usage is **$7.99940685**. Including the pre-existing unresolved reservation of **$0.073722**, cumulative exposure is **$8.07312885 of $10**, leaving **$1.92687115**. No new request remains unresolved. Discovery costs would be allocated separately to any transferred deployment; none was evaluated here.

Evidence:

- [Native qualification](../../benchmarks/learning-strategy/telecom/qualification-v1.json): all reference and negative controls, Python/dependency versions.
- [Pilot results](../../benchmarks/learning-strategy/data/telecom-native-pilot-v1.zip) and [replay audit](../../benchmarks/learning-strategy/data/telecom-native-pilot-v1.zip).
- [Correction results](../../benchmarks/learning-strategy/data/telecom-correction-transfer-v1.zip), [generated candidate](../../benchmarks/learning-strategy/data/telecom-correction-transfer-v1.zip) and [replay audit](../../benchmarks/learning-strategy/data/telecom-correction-transfer-v1.zip).

Both audits reconcile raw usage with episode costs and the existing SQLite ledger. Four targeted tests cover role/tool restrictions, fresh state, pricing and reservation failures, and terminal handoff behavior. JavaScript syntax, formatting and targeted lint checks pass.

## Implication for Bitterbot

Keep the native workflow adapter and the gate that requires new skills to preserve existing successes. The generated correction solved a real synthetic failure, but did not improve total source success and was correctly withheld from transfer. The evidence does not yet justify enabling automatic broad strategy rewrites.

A better next experiment would constrain learning to a small prerequisite addition, preserve the existing device troubleshooting steps, and retain richer actor-visible evidence. It should compare that change with ordinary verified procedure reuse and freeze independent recipient cases before collection. The two reserved cases here remain available because the source gate stopped the experiment before they were observed by either actor.
