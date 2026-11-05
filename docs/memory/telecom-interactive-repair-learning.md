# Interactive repair discovery and learning from failed attempts

A strategy generated from failed investigations repaired **3/12 attempts**, versus **0/12 for a strategy generated without that experience**. It used **56 evaluation model calls versus 72**, and cost **$2.87 versus $3.44 including strategy generation**. All three repairs were independently replayed; removing the account-side intervention made each failure return. This is a small development signal, not reliable general learning: the strategy still failed nine attempts, the wins cover only two of four previously consumed cases, and only one strategy was generated per condition. No fresh-case, ordinary-agent or recipient benefit has been established.

This follows the [corrected study's negative fresh result](telecom-corrected-autonomous-learning.md). The new work tests repair discovery on isolated copies of failed final states. It does not rescore the original support episodes or overwrite their results.

[Download the complete repair comparison figures](../../benchmarks/learning-strategy/data/telecom-repair-learning-summary-v1.zip).

## Two separate comparisons

The first comparison asked whether choosing an action after seeing the previous response helps. Both conditions received the same complete public failed trace, policy, role-qualified account/device tool catalog and six-action opportunity. The batch condition committed a whole plan before executing; the interactive condition chose one action at a time, with at most eight decisions including rejected submissions. The original model remained `claude-sonnet-4-6`.

| Comparison         | Condition                  | Verified repairs / assigned | Evaluation model calls | Native diagnostic actions | Evaluation cost |
| ------------------ | -------------------------- | --------------------------- | ---------------------- | ------------------------- | --------------- |
| Feedback interface | Plan upfront               | 0/12                        | 12                     | 42                        | $0.38157225     |
| Feedback interface | Interactive                | 0/12                        | 69                     | 65                        | $2.99680050     |
| Generated strategy | Without failure experience | 0/12                        | 72                     | 70                        | $3.38615055     |
| Generated strategy | With failure experience    | 3/12                        | 56                     | 46                        | $2.70278205     |

All **107 actions in the first comparison targeted the device**; none inspected or changed the account. One batch plan failed argument validation before execution. Three interactive attempts ended with truncated model output and no final native grade. These remain in the assigned denominator as unverified repairs. The other native outcomes were failures. More opportunities to observe feedback did not, by themselves, produce a successful investigation.

The second comparison let the model engineer its own investigation instructions. Both generators received the same base controller, policy, tool contracts and bounded program format. Only the experience generator received all previous attempt summaries plus the complete public source trace and first interactive attempt for each case, selected mechanically by repetition number. Neither generator received a human repair recipe, hidden scenario or criterion-level grade. Both programs compiled on their first submission and were sealed before evaluation; there were no human edits, fallback programs or outcome-driven revisions.

Both new conditions used interactive execution, the same six-action/eight-decision limits, a 2,048-token response allowance and a request for at most 60 words of rationale. The latter is an instruction, not a guaranteed word limit. These common changes address truncation and long deliberation; **a cross-comparison before/after difference cannot isolate learning**. The relevant controlled contrast is experience versus blind within the second comparison. It completed without interface errors, invalid submissions or truncated outputs.

## What the generated strategy discovered

| Previously consumed case | Without experience | With experience |
| ------------------------ | ------------------ | --------------- |
| 36                       | 0/3                | 1/3             |
| 37                       | 0/3                | 0/3             |
| 39                       | 0/3                | 2/3             |
| 44                       | 0/3                | 0/3             |

In each successful trajectory, the model selected `assistant.enable_roaming` for the affected line, then observed `user.can_send_mms` report working service. The account and line identifiers matched the original public customer lookup and line record. The successful action was selected by the model; the host supplied neither that diagnosis nor those repair arguments. The generated program explicitly discussed account-side prerequisites and avoiding repeated checks, but it did not cause consistent execution: nine attempts still missed the repair.

Every successful sequence was replayed from its exact failed parent, followed by three separate single-action omissions. Across **12 verification runs**, all three full sequences succeeded; all three omissions of `enable_roaming` failed; and the six omissions of a read-only check preserved native success. All runs preserved unrelated state. This establishes that the account intervention was **necessary within each tested fixed sequence on its exact input**, not that it is universally necessary or sufficient across accounts, tasks or versions.

Read-only checks have an epistemic purpose even when their removal does not change simulator state. In particular, the final service check must not be discarded merely because the independent grader can observe success without it. A reusable procedure still needs current-state checks, correct customer/line binding and verification after mutation.

Three private evidence records retain the original trace hash, selected actions, full responses, outcome and omission results. They cover **two distinct failed inputs**, not three independent tasks. These are input-bound repair records, not generalized skills ready for activation or P2P sharing.

## Strength and limits of the evidence

The second comparison passes its frozen development screen: both programs valid, all 24 assignments without interface errors, at least three additional experience repairs, and no case-level regression. The observed difference is **25 percentage points**. A descriptive resampling of the four case clusters yields endpoints of **0 to 50 percentage points**. This very small consumed sample and one generated strategy per condition cannot establish a population effect or separate reliable learning from variation between generated strategies. The zero outcomes in the first comparison also do not establish zero potential benefit outside these inputs.

The four starting states were chosen before model collection: the first lexicographic, naturally terminated, failed, replay-matching and unrelated-state-preserving episode for each development case 36, 37, 39 and 44. Their eligible episode counts were 9, 1, 10 and 12. All three repetitions and every failed attempt were retained. Repetitions are not independent tasks. No reserved recipient cases were opened or used; cases 11, 12, 15 and 49 remain reserved.

These investigators have privileged diagnostic access to both account and device tools in synthetic copies. There is no new customer consent conversation during repair. They are not normal support actors. The new diagnostic actions made no purchases or plan changes. No model weights were updated, no procedure was activated, and nothing was published externally or to peers.

## Implementation, auditing and cost

The additions reuse the existing pinned native telecom adapter, public-trace projection, bounded program compiler, frozen-source machinery and durable provider ledger. The new runtime supports sequential selection from actual tool results, whole-batch validation, failed-attempt projection into a generator, sealed strategy evaluation, and exact-input repair/omission records. They remain research components beside the existing learning-strategy lab; the production gateway and P2P activation path are unchanged.

Twenty-four focused tests cover the diagnostic action/session contracts, provider-compatible request wrapper and failure-learning runtime. Four new learning modules and four corrected interface modules passed lint. Cold reconstruction reproduced **81 provider requests and 107 model-selected native actions** for the interface comparison, then **130 provider requests, 116 model-selected native actions and all 12 verification runs** for strategy learning. A targeted review of all 24 final service observations agreed with native grades; all three successful interventions matched the affected customer and line, and no new purchase occurred.

The initial `telecom-interactive-repair-v1` run is preserved as an interface failure: three HTTP 400 responses rejected `maxItems` before any model output or native diagnostic action. The revised request removes that unsupported wire-schema keyword while retaining the same local limits and prompt. This follows the provider's [structured-output constraint guidance](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). The rejected requests supplied no usage receipts, so their **$1.365942 conservative reservations remain unresolved**, rather than being silently priced at zero. All 24 original error records are retained separately and are not efficacy observations.

The first cold auditor also exposed completion-order differences in the presentation order of per-case summary rows. A separate auditor revision compares those rows by case identity and independently recomputes the gate. It changed neither original records nor frozen execution source. All original call/native replays matched. The second collector canonicalizes assignment order before aggregation.

The completed comparisons cost **$3.37837275** and **$6.31740810**, respectively: **$9.69578085** in new receipted usage. Strategy generation cost $0.05843025 without experience and $0.17004525 with experience. Including generation, the second comparison cost $3.44458080 versus $2.87282730, approximately 16.6% less for the experience condition. Uncached-equivalent totals were $4.062369 versus $3.234786; actual cache timing affects paid cost. Cumulative research exposure is **$195.72633330**, including the new unresolved reservations and the older $0.073722 reservation. Every request in the two completed comparisons has a receipt.

## Next experiment

Follow-up completed: the [conditional procedure reuse study](telecom-guarded-procedure-reuse.md) generated two procedures from these verified repairs. Each repaired 12/28 additional failed recorded states and preserved 16/16 healthy states without mutations, but tied advice at 6/12 on the four original inputs and failed its qualification gate. It exposed false success claims and an additional model-discovered repair, motivating verified reuse with continued exploration. The original results on this page remain unchanged.

Use the verified repair records as evidence for a model-generated, conditional procedure that checks the current affected line, preserves prerequisite evidence through execution and verifies service afterward. Keep the successful mutation and its applicability conditions distinct from the incidental checks in its discovery sequence. Compare raw experience retrieval, ordinary instructions, and the verified procedure before testing a separately initialized recipient.

Replicate acquisition with several independently generated strategies, then evaluate across more independent cases and workflow families. The present candidate's 25% source success is too unreliable for a broad claim that Bitterbot gets smarter with every user. A defensible demonstration can show a real model-selected failure-to-repair trajectory and its omission control alongside the full 3/12-versus-0/12 result; a transfer or general learning headline needs additional evidence.

## Artifacts and reproduction

Interface comparison: [frozen protocol](../../benchmarks/learning-strategy/data/telecom-interactive-repair-v2.zip), [audit](../../benchmarks/learning-strategy/data/telecom-interactive-repair-v2.zip), [analysis](../../benchmarks/learning-strategy/data/telecom-interactive-repair-v2.zip), [all trial rows](../../benchmarks/learning-strategy/data/telecom-interactive-repair-v2.zip), and [preserved schema failure](../../benchmarks/learning-strategy/data/telecom-interactive-repair-v1.zip).

Strategy learning: [frozen protocol](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), [both generated strategies](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), [audit](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), [analysis](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), [all trial rows](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), [verification index](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip), and [one full repair/omission record](../../benchmarks/learning-strategy/data/telecom-repair-learning-v1.zip).

Use `interactive-repair2-study.mjs prepare <new-root> <corrected-discovery-root>`, then `qualify`, `collect`, and `verify` with the new root. Audit with `interactive-repair-audit3.mjs <root>`. For failure learning, use `repair-learning-study.mjs prepare <new-root> <audited-interface-root>`, then `collect` and `verify`; finish with `repair-learning-audit.mjs <root>`. All commands use plain Node. Paid collection requires the configured provider credential. Every output root must be new; never edit frozen source or overwrite receipts.

The [chart bundle](../../benchmarks/learning-strategy/data/telecom-repair-learning-summary-v1.zip) retains analysis/audit hashes, plotting-library versions and a source snapshot. Recreate it with `python plot-repair-learning.py <interface-root> <learning-root> <new-output-root>` using Matplotlib.
