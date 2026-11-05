# Explicit prerequisite tracking in telecom support

The completed source comparison found a promising execution benefit: **baseline repaired 12/18 trials, an explicit checklist 16/18, and the same checklist with a per-request evidence ledger 18/18**. All 54 assigned trials are retained. A cold audit reproduced all **2,092 model calls and 283 ledger snapshots** exactly. New provider usage was **$20.65605960**.

| Arm                         | Repairs | Natural completions | Model calls | Native tool calls | Provider usage | Uncached-equivalent cost |
| --------------------------- | ------: | ------------------: | ----------: | ----------------: | -------------: | -----------------------: |
| Baseline                    |   12/18 |               18/18 |         719 |               275 |    $6.57176910 |               $18.791895 |
| Explicit checklist          |   16/18 |               17/18 |         735 |               287 |    $6.44527875 |               $19.297722 |
| Checklist + evidence ledger |   18/18 |               18/18 |         638 |               271 |    $7.63901175 |               $16.785279 |

One checklist trial ended in a simulator publication rejection. The frozen source gate requires **all assigned trials across all arms** to terminate naturally, so it failed and selected no intervention. The six fresh cases and four recipient cases remain unused. The rejected trial stays in the denominator and accounting; neither its outcome nor the gate was revised after observing results.

This is evidence for a host-authored execution aid on six previously consumed development cases. It does not establish autonomous improvement from user experience, generalization to fresh tasks or distributed transfer. The ledger's travel parser often remained unknown despite useful dialogue, and the comparison does not separate structured evidence from the effect of repeated prompt emphasis. These limitations determine the next experiment.

The study follows the [learned-procedure study](telecom-learned-procedure-study.md), where baseline repaired 6/8 cases, a manual checklist 7/8 and a learned procedure 4/8. All seven failed trials in that earlier study left account roaming disabled. The present intervention was engineered from that diagnosis; the agent did not learn or propose it.

## Frozen comparison

Three approaches use the same pinned `text-v8-private-publication-preamble` native adapter, tools, policy, verifier and `claude-sonnet-4-6` actor/customer model:

1. **Baseline:** unchanged actor instructions.
2. **Explicit:** a fixed checklist requires distinguishing verified, unknown and unmet prerequisites; asking about current travel when unknown; separately checking account and device roaming; checking affected-line allowance; obtaining required consent; verifying the requested service; and reviewing unresolved prerequisites before escalation.
3. **Ledger:** exactly the same actor instructions as explicit, plus an ephemeral evidence ledger before each actor request. The ledger is reconstructed solely from actor-visible history, carries source references and lists unknown or unmet applicable prerequisites.

The ledger does not access the customer's private scenario or tools, select native repairs, modify tool responses or veto a human handoff. It preserves the original customer interface and permits legitimate escalation. Customer travel is an attributed, bounded interpretation of public speech, separate from host-validated device diagnostics. Ambiguous wording remains unknown. Unambiguous dialogue takes precedence over parser uncertainty to avoid repeated questioning. The actor must still decide which checks and consent requirements apply.

Each episode starts a fresh native process. Each arm/repetition has an isolated store using the existing strategy archive, development/held-out panels, resource ledger and sealing API. Explicit and ledger intentionally have identical archived actor text; their host-support mode is separately recorded in the frozen protocol, runtime source hashes and contract scope. No proposer is evolved and no live agent or peer is activated.

| Stage                                  | Cases                | Repetitions | Arms                                 | Episodes |
| -------------------------------------- | -------------------- | ----------: | ------------------------------------ | -------: |
| Consumed development                   | 0, 2, 36, 37, 39, 44 |           3 | Baseline, explicit, ledger           |       54 |
| Fresh, only after source qualification | 5, 6, 9, 10, 13, 48  |           3 | Baseline and the selected source arm |       36 |

Cases 36, 37, 39 and 44 are consumed MMS cases from the previous study. Case 0 supplies a consumed domestic mobile-data control; case 2 supplies a consumed mobile-data case whose account roaming is already enabled. They check applicability and extra changes beyond the failure-rich MMS cases. This deliberate six-case panel is not a random sample of user tasks. Model draws are unseeded; cases, not repeated draws, form the clusters in descriptive comparisons.

Source eligibility requires all 54 assigned episodes to finish naturally with zero interface failures, at least **17/18 repairs** for an intervention, at least **two more repairs than contemporaneous baseline**, and no case-level baseline regression. If both interventions qualify, choose the one with more repairs. At equal repair counts, prefer the explicit checklist unless the ledger uses at least 10% fewer model calls and no more uncached-equivalent cost. The source choice is frozen before fresh evaluation. Fresh qualification requires at least two additional repairs over baseline, no case-level regression and all assigned natural completions without interface failures.

These are exploratory advancement decisions, not significance tests or production promotion. There are no within-stage edits, silent retries or outcome-based changes to the gates. A failed source gate preserves the fresh panel. The separate recipient cases 11, 12, 15 and 49 remain reserved; this host-authored mechanism experiment does not perform recipient transfer or claim learned benefit.

Three provider lanes execute rotated blocks. Each episode allows 128 model calls and $3, with source/fresh circuit breakers of $90/$75. The user's broader spending authorization remains in effect; these limits bound accidental execution. Actual provider usage and unresolved prior liabilities remain in cumulative accounting.

## Qualification

Seven focused tests passed: travel-report interpretation; unknown/domestic/success behavior; owned affected-line selection; invalidation after account changes; latest public snapshot replacement; private-text exclusion; ephemeral request projection; and fixed source selection. The new cold auditor reproduced four historical baseline episodes and **212 calls** exactly. All eight implementation modules passed lint.

Offline projection covered **24 historical episodes and 481 actor requests**, with a maximum projected request size of **58,417 bytes**, below the provider wrapper's 140,000-byte limit. All seven failed handoffs surfaced unknown travel and a pending inquiry. Five retained current evidence that account roaming was disabled; two correctly treated it as unknown after refueling invalidated earlier account observations. An initial qualification assertion expected all seven to remain false; it was corrected to respect invalidation, without relaxing the runtime's evidence boundary. No provider calls were made during qualification, and no historical outcome changed.

This qualification established that the mechanism could represent the observed gap. The subsequent controlled model runs supply the outcome evidence above.

## Isolated publication-recovery candidate

During collection, `explicit-1-39` ended with `unknown-or-stale-observation-reference`: the simulated customer selected a current network-status reference together with an obsolete MMS reference after device changes. The v8 host correctly rejected the entire publication. This remains a charged interface failure in the original study; it is not retried, excluded or converted into a successful support task. The frozen all-natural-completion gate cannot pass this run.

An isolated [candidate runtime](../../benchmarks/learning-strategy/telecom/episode-recovery.mjs) adds one [bounded correction opportunity](../../benchmarks/learning-strategy/telecom/publication-recovery.mjs) for a customer-only, single publication rejected specifically for an unknown/stale reference. The customer receives a private tool error and the existing current reference list. The failed speech and records never reach the actor. A second invalid publication still aborts; other grounding, role and call-shape failures keep their existing behavior. No extra repair is executed by the host.

Four [offline tests](../../benchmarks/learning-strategy/telecom/publication-recovery.test.mjs) passed: exact replay up to the recorded failure; a scripted correction publishing only current references; rejection of a second invalid attempt without leaking either report; and unchanged exact requests/native outcome on a historical no-error episode. The scripted recovery does not fix the unresolved native task, and no real model has yet been asked to perform this correction. Qualification made zero provider requests. This candidate was not imported by the paid collector; all completed-study source hashes remain unchanged. Real-model recovery qualification and a separately frozen confirmation would be necessary before using this runtime for fresh cases.

## Results by case

Each cell contains three unseeded repetitions of the same case, not three independent tasks.

| Case                                            | Baseline | Explicit | Ledger |
| ----------------------------------------------- | -------: | -------: | -----: |
| 0: domestic mobile data                         |      3/3 |      3/3 |    3/3 |
| 2: mobile data, account roaming already enabled |      3/3 |      3/3 |    3/3 |
| 36: MMS, network preference and app permission  |      1/3 |      3/3 |    3/3 |
| 37: MMS, permissions, allowance and roaming     |      1/3 |      3/3 |    3/3 |
| 39: MMS, APN, allowance and roaming             |      3/3 |      2/3 |    3/3 |
| 44: MMS, multiple device conditions and roaming |      1/3 |      2/3 |    3/3 |

The case descriptions abbreviate the native tasks; they are not exhaustive repair instructions. Case 39's explicit result includes the interface rejection. No episode hit a resource stop. Native tools returned no errors; the separate host publication rejection remains an interface failure.

Descriptive paired case-cluster bootstrap intervals use 10,000 fixed-seed resamples of the six cases. Repair-rate differences are **+22.2 percentage points** for explicit versus baseline (95% interval **−5.6 to +50.0**), **+33.3 points** for ledger versus baseline (**+11.1 to +55.6**), and **+11.1 points** for ledger versus explicit (**0.0 to +22.2**). These intervals describe this small, deliberately selected development panel; they are not confirmatory population estimates. Repeated draws and the interface failure do not disappear from the analysis.

The ledger used 11.3% fewer model calls than baseline and 13.2% fewer than explicit. Its actual provider usage was nevertheless higher than either control. Uncached-equivalent cost prices every observed input token at the same base rate; it was lower for ledger, but is a counterfactual and not the amount spent. Prompt placement and caching differ, so fewer calls alone do not establish an operating-cost advantage.

## Failure review and control behavior

Post-collection read-only native probes reproduced all eight failed final states without changing any outcome:

| Trials                                            | Remaining conditions observed                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseline-0-36`                                   | Network preference still 2G-only; messaging lacked SMS permission. Account roaming was already repaired.                                                     |
| `baseline-0-37`, `baseline-1-37`                  | Usage exceeded the 15 GB allowance; no required 2 GB refuel had occurred. Account and device roaming were enabled.                                           |
| `baseline-0-44`, `baseline-2-44`, `explicit-0-44` | Account and device roaming remained disabled.                                                                                                                |
| `baseline-2-36`                                   | Account roaming remained disabled; device roaming was enabled.                                                                                               |
| `explicit-1-39`                                   | Interface rejection stopped the trial with account roaming disabled. The required 2 GB refuel had occurred. This is not attributed solely to actor behavior. |

The current failures therefore extend beyond the earlier roaming-only diagnosis. They reinforce checking all applicable prerequisites, including allowance and device settings, before concluding that escalation is necessary. These probes describe remaining conditions; this study did not run new final-state repair or omission experiments.

All 18 control trials on cases 0 and 2 succeeded. Every domestic trial performed exactly the two expected native mutations, with no account or device roaming change. Every already-enabled-account trial performed the two expected device mutations, with no account roaming change. No control refueled data. This is useful applicability evidence, but it does not establish comprehensive consent or noninterference compliance. The ledger also increased mean model calls on these controls: 19 versus baseline 18.7 on case 0, and 27.3 versus 21.3 on case 2.

Across the full study, baseline/explicit/ledger performed 80/77/78 native mutation calls, respectively. Exact repeated mutation calls were 4/1/0. A repeated call is defined by identical role, name and arguments; that count alone does not establish whether an action was redundant or necessary.

## What the ledger does and does not establish

The audit verified delivery and reconstruction of all 283 ledger snapshots. Travel remained `unknown` in **239/283 snapshots** and in **14/18 final ledger states**. Only one international trial finished with travel parsed as true; all three domestic trials finished with it parsed as false. The actor could still understand original dialogue and correctly complete tasks, as the instructions explicitly permit.

Consequently, 18/18 repairs is not evidence that the bounded travel parser reliably understood the conversations. Manual inspection found repeated travel questioning, including `ledger-2-36`; not every repeated question is unnecessary, since some replies omit an answer. The exported `travelQuestions` heuristic counts travel-related actor utterances containing a question mark, including consent and device-guidance questions. It must not be presented as an exact count of redundant inquiries.

The ledger adds evidence and reminders near each actor decision, while the explicit checklist appears in the system instructions. Its advantage could arise from current evidence, repeated attention to prerequisites, prompt placement, or a combination. This experiment does not isolate those causes. Nothing here demonstrates a model weight update, an automatically learned procedure, persistent cross-user learning, or improved performance after peer transfer.

## Next experiment

First qualify the isolated one-retry publication correction with real model responses on consumed development material. Keep invalid facts private, count the rejected and corrected requests, retain the one-correction bound, and require unchanged behavior when no publication error occurs. The current four scripted offline tests establish the boundary behavior only.

Then freeze a new development comparison with a **repeated checklist control** delivered at the same frequency and message position as the ledger, alongside the unchanged baseline and ledger. Use the same qualified runtime for every arm, freeze the schedule and selection rule before calls, and compare successful repairs, requests, actual cost, and unnecessary questioning/actions. Keep the current parser fixed for that causal comparison; evaluate any richer travel extraction separately so its effect is not mixed into the control change.

Only a clean, prospectively qualified comparison should spend the six remaining fresh cases. The four recipient cases remain reserved for a later experiment in which a procedure is actually learned and transferred. The distributed-learning claim requires that full chain: experience produces a candidate, held-out evaluation validates it, and an independent recipient benefits. This run establishes none of those later steps.

## Audit, accounting and evidence

The cold auditor checked 90 frozen source files, all assigned native outcomes, exact model requests/responses, ledger projections, lane receipts and per-arm SQLite accounting. All **54 trial rows**, **2,092 calls**, and **283 snapshots** reconciled. Every new request is settled; there are no active collectors or new unresolved reservations. Cumulative exposure is **$80.05103220**, including the unchanged **$0.073722** unresolved reservation from the original pilot. Provider usage figures are receipt-based list-price estimates, not invoices. Qualification, replay and post-collection review made no new provider calls.

The primary result is complete but marked `censored` by the collector because one assigned episode ended at an interface rejection. This label does not mean assignments are missing. The audit and completion validation passed; the distinct efficacy advancement gate failed. No fresh or recipient collection, live activation or peer publication occurred.

- [Primary analysis and frozen gate decision](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Exact cold replay audit](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Final reconciliation and remaining-case validation](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [All 54 trial rows](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Post-collection native review](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Frozen source protocol](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Offline projection qualification](../../benchmarks/learning-strategy/data/telecom-prerequisite-source-v1.zip)
- [Protocol and selection gate](../../benchmarks/learning-strategy/telecom/prerequisite-protocol.mjs)
- [Evidence ledger](../../benchmarks/learning-strategy/telecom/prerequisite-ledger.mjs)
- [Collector](../../benchmarks/learning-strategy/telecom/prerequisite-study.mjs), [cold auditor](../../benchmarks/learning-strategy/telecom/prerequisite-audit.mjs), and [analyzer](../../benchmarks/learning-strategy/telecom/prerequisite-analyze.mjs)
