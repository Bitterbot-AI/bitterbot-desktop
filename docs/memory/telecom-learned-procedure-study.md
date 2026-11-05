# Learned telecom procedure experiment

The learned procedure failed its source qualification: **4/8 repairs**, compared with **6/8 for the unchanged baseline** and **7/8 for the manual checklist**. All 24 assigned episodes completed naturally; all 1,148 model calls replay exactly, with no interface failures, tool errors or resource stops. The candidate remains archived and inactive. The 54-episode fresh comparison and 24-episode recipient comparison were not started, preserving all ten reserved cases.

This study tests whether a procedure generated from consumed agent experience improves subsequent behavior through Bitterbot's existing strategy archive. It follows the [expanded evidence study](telecom-expanded-evidence-study.md), which found missed roaming and allowance prerequisites but no benefit from its conditional reminder. The result rejects this candidate for transfer; it does not establish that procedural learning in general cannot work.

## Results and decision

| Arm                | Successful repairs | Model calls | Native tool calls | Native mutation calls | Repeated mutations | Provider usage cost | Uncached equivalent |
| ------------------ | -----------------: | ----------: | ----------------: | --------------------: | -----------------: | ------------------: | ------------------: |
| Unchanged baseline |                6/8 |         406 |               157 |                    43 |                  1 |         $3.87072945 |          $10.808655 |
| Manual checklist   |                7/8 |         384 |               145 |                    46 |                  2 |         $3.51082860 |          $10.179813 |
| Learned procedure  |                4/8 |         358 |               148 |                    40 |                  1 |         $3.31589070 |           $9.537699 |

The learned arm's lower call count and cost do not establish efficiency: four trials ended in unresolved handoff, compared with two for baseline and one for the checklist. All results include failures. Repeated mutations mean identical actor/customer role, tool name and arguments within an episode; an off/on toggle sequence can legitimately repeat. These counts are not a measure of unnecessary changes or consent violations.

| Consumed case | Baseline | Manual checklist | Learned procedure |
| ------------- | -------: | ---------------: | ----------------: |
| 36            |      2/2 |              2/2 |               1/2 |
| 37            |      2/2 |              2/2 |               2/2 |
| 39            |      1/2 |              2/2 |               1/2 |
| 44            |      1/2 |              1/2 |               0/2 |

The learned-minus-baseline difference is **−25 percentage points**, with a descriptive 95% case-cluster bootstrap interval of **−50 to 0 points**. Versus the checklist, it is **−37.5 points**, with interval **−50 to −12.5 points**. Only four deliberately selected, consumed case clusters underlie these estimates. They are neither a population estimate nor confirmatory significance tests. The fixed qualification requirement failed without any need to reinterpret the intervals.

Evaluation cost was **$10.69744875**; the two discovery calls added **$0.104295**, for **$10.80174375** new usage across **1,150 model calls**. All new requests are settled. Cumulative project exposure is **$59.39497260**, including the unchanged **$0.073722** unresolved reservation from the original pilot. Costs use frozen list prices and observed usage receipts, not provider invoices.

## What failed

Read-only native probes after termination found **account roaming disabled in all seven failed trials**. Four case-44 trials also left the device roaming switch off. The remaining three failures had device roaming on. Every failed actor had received the affected line's `roaming_enabled: false` field through `get_details_by_id`; none called `enable_roaming`. The two failed case-39 actors had already added the required 2 GB of allowance, so remaining data exhaustion was not the explanation for those failures.

| Remaining prerequisite     | Failed trials                                                     |
| -------------------------- | ----------------------------------------------------------------- |
| Account roaming            | `learned-0-36`, `baseline-0-39`, `learned-1-39`                   |
| Account and device roaming | `baseline-1-44`, `checklist-0-44`, `learned-0-44`, `learned-1-44` |

The learned addition contains a roaming branch, but only says **“if roaming abroad.”** The failed dialogues did not reliably establish that condition. Reading the account flag also did not cause the actor to revisit the branch before escalation. This points to a gap between conditional advice and acquiring the evidence needed to apply it. Device roaming being enabled is not evidence that account roaming is enabled.

A separate [offline dependency probe](../../benchmarks/learning-strategy/data/telecom-procedure-failure-repair-v1.zip) replayed each failed native state and applied only its missing roaming repairs. **All seven repaired states passed**, while **all eleven single-repair omission controls failed**. Each replay preserved unrelated state. These are host-authored, final-state-informed interventions without model decisions or a new consent conversation. They confirm remaining dependencies in this simulator; they do not improve the agent's score or demonstrate learned benefit.

Keep the existing archive, isolation, receipt ledger, replay audit and promotion gates. Do not transfer this candidate or treat the checklist's one extra success over baseline as established benefit. The next hypothesis should explicitly represent **unknown prerequisites**: ask whether the user is abroad when that fact is unknown; if applicable, check account and device roaming separately; after a repair, verify the requested service; before a handoff, review applicable unresolved prerequisites while preserving legitimate escalation and consent. This should first be qualified on consumed development cases as a separately frozen experiment. A learned version must discover the same evidence-acquisition behavior from allowed experience and beat an equally capable manual control before fresh cases are used.

The change to test next is the execution of prerequisites, rather than another larger free-text troubleshooting list. This study does not implement that new intervention or claim generalization beyond its four MMS source cases.

## Frozen design

The learner receives twelve baseline trajectories from consumed cases 36, 37, 39 and 44, with three draws per case: nine successes and three failures. Its evidence contains ordered public dialogue, actor-visible observations and terminal success. Private customer tool responses, private accompanying model text, reference repairs, post-collection state diagnoses, the manual checklist and fresh task metadata are excluded. Synthetic identifiers are redacted. Repeated provenance identifiers are compacted into complete public fact snapshots while preserving every public turn and fact value; omitted facts remain unknown.

The model generates an instruction addition through the existing `ProceduralLearning.strategies` proposal/archive API. Baseline instructions, policy, verifier, tools, proposer and model remain fixed. The manual checklist was written before generation. Each arm has its own store per repetition and each episode starts a fresh native process. Three provider lanes execute rotated blocks. Exact source snapshots, request/response records, usage receipts and SQLite accounting are retained.

| Stage                | Cases                        | Arms                                | Repetitions | Assigned episodes | Advancement requirement                                                                                                                         |
| -------------------- | ---------------------------- | ----------------------------------- | ----------: | ----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Source qualification | Consumed 36, 37, 39, 44      | Baseline, manual checklist, learned |           2 |                24 | Learned repairs all eight naturally and exceeds contemporaneous baseline success                                                                |
| Fresh comparison     | Reserved 5, 6, 9, 10, 13, 48 | Baseline, manual checklist, learned |           3 |                54 | Natural completion throughout; learned exceeds baseline, matches or exceeds checklist success, and has no case-level regression versus baseline |
| Recipient comparison | Reserved 11, 12, 15, 49      | Baseline, transferred learned       |           3 |                24 | Descriptive independent recipient evaluation after both earlier gates pass                                                                      |

These gates are exploratory decisions, not significance tests or production promotion criteria. Source cases are development data. Fresh panels are small convenience samples of related synthetic tasks; repeated unseeded draws are not independent user trials. Later panels remain unused if an earlier gate fails. No within-stage tuning, retries or candidate reselection is allowed.

The pinned native telecom adapter is `text-v8-private-publication-preamble`, using tau2 commit `989d3285ae669e49503324bdb9981bf14fccedeb` and `claude-sonnet-4-6` for actor and simulated customer. This is a custom text adaptation, not an official tau2 benchmark score. Every episode permits 128 model calls and $3, with stage circuit breakers of $45, $90 and $60. The user's earlier budget limit is superseded; these finite limits bound accidental execution. Both actor and customer calls count.

## Discovery record and amendment

All attempts are retained:

1. `telecom-procedure-discovery-v1` exceeded the provider wrapper's 140,000-byte request bound locally. It made zero provider calls. Compacting redundant snapshot provenance preserved all twelve trajectories and their public speech/facts.
2. `telecom-procedure-discovery-v2` made one proposal call costing $0.098850. The machine addition was 669 characters, violating the frozen 600-character contract, and contained nonexistent `check_data_usage`.
3. `telecom-procedure-discovery-v3` made one mechanical repair call costing $0.005445. It received only the original draft, validation errors, public tool-name inventory and unchanged baseline instructions. It corrected the tool name to `get_data_usage`, but remained 667 characters and was again rejected. It received no new outcomes or host-authored procedure.
4. Before behavioral evaluation, `telecom-procedure-discovery-v4` explicitly amended both arms' addition allowance to 800 characters and adopted the unchanged repaired machine draft. It used the existing complete-actor API with an exact preserved baseline prefix. The production schema and machine wording stayed unchanged, and this adoption made no further provider call. The original failed contracts remain failed. All behavioral panels and gates stayed fixed.

The adopted candidate hash is `412d2fa5df27d16f9c9e73e8324d1493bcbe575a531ee768d0b136013d073bcd`. It has canonical baseline lineage, a fixed proposer, twelve replayed development outcomes and zero imported live outcomes. Total physical discovery cost is **$0.104295** across two calls. Allocation of that discovery cost to a deployment is separate from additional spending.

The unchanged 667-character learned addition is:

> MMS troubleshooting order: (1) check_network_status — fix airplane mode (toggle_airplane_mode), missing SIM (reseat_sim_card), mobile data off (toggle_data), weak/2G signal (set_network_mode_preference 4g_5g_preferred); (2) if roaming abroad, verify account roaming enabled (enable_roaming if not) and device roaming on (toggle_roaming if not); (3) get_data_usage — if at or over limit, offer refuel with price and consent before proceeding; (4) check_apn_settings — if MMSC URL missing, reset_apn_settings then reboot_device; (5) check_app_permissions(messaging) — grant missing storage and sms permissions; (6) recheck can_send_mms after each fix before continuing.

The fixed 580-character manual checklist is:

> Before escalating unresolved data/MMS, identify the affected line and verify unmet prerequisites. Check allowance via get_data_usage or line usage joined to its plan; obtain consent before refueling exhausted data. When abroad, check account roaming separately from the device roaming switch. Ask for current settings and change only disabled settings. Reuse fresh observations, retain device/APN/permission troubleshooting, avoid repeated resets, and test the requested service after repairs. Strong signal does not prove data works. Escalate when available checks are exhausted.

## Validation and evidence

Six focused tests cover fixed panel assignments and gates, source projection, exclusion of private canaries, exact public speech/fact preservation, request size and existing archive lineage. The new cold auditor also reproduced nine historical episodes and 400 calls exactly, then rejected a deliberately altered request. Those preflight checks made no provider calls. Discovery audit confirms the unchanged draft, exact baseline prefix, native tool names and settlement of both paid proposal calls.

The completed source stage passed frozen-source replay of every exact request/response and native result, followed by reconciliation with provider receipts and SQLite. Analysis includes every assigned outcome, natural termination, interface failures, model/tool calls, cost and case-cluster comparisons. Mutation counts are descriptive; native assertions do not comprehensively grade necessity or conversational consent. Final validation also reconstructed both discovery requests, verified unchanged source hashes, reconciled every exported trial and confirmed that the fresh and recipient panels remain unconsumed.

Primary artifacts:

- [Adopted discovery and audit](../../benchmarks/learning-strategy/data/telecom-procedure-discovery-v4.zip)
- [Frozen source protocol](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip)
- [Primary analysis](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip), [replay audit](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip) and [completion validation](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip)
- [All 24 trial rows](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip) and [post-collection failure/action review](../../benchmarks/learning-strategy/data/telecom-procedure-source-v1.zip)
- [Offline repair/omission results](../../benchmarks/learning-strategy/data/telecom-procedure-failure-repair-v1.zip)
- [Procedure protocol and gates](../../benchmarks/learning-strategy/telecom/procedure-protocol.mjs)
- [Collector](../../benchmarks/learning-strategy/telecom/procedure-study.mjs), [cold auditor](../../benchmarks/learning-strategy/telecom/procedure-audit.mjs) and [analyzer](../../benchmarks/learning-strategy/telecom/procedure-analyze.mjs)
