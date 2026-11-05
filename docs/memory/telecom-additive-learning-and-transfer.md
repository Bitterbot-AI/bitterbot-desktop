---
title: "Additive telecom learning and recipient transfer"
description: "A small learned checklist repaired source behavior, but tied recipient accuracy while using more calls and money."
---

The smaller correction cleared source qualification: **1/2 baseline successes became 2/2**. The signed strategy was then imported into a fresh recipient store and evaluated on the two previously reserved cases. **Baseline and transferred strategy both passed 2/2**, while the transferred strategy used more model calls, more tool calls and more provider spending. This experiment supports keeping the bounded-edit mechanism, but does not demonstrate a benefit from collective learning.

## What changed

The [first correction](telecom-synthetic-learning-qualification.md) repaired exhausted data in an MMS workflow but lost a previously successful mobile-data repair. Its learning feedback had omitted most device troubleshooting dialogue. This follow-up made four changes before collection:

- The existing strategy lab gained `editMode: "append"`. It accepts at most 600 additional characters, preserves the original actor text, and keeps the proposer fixed. Existing replacement behavior remains available. Text preservation does not guarantee semantic non-regression.
- Development feedback retained ordered actor-visible dialogue and selected account observations from both the original pilot and the failed broad correction. The panel pinned a 32000-character feedback limit. Source evidence occupied 20853 and 18557 characters without truncation. Customer-private tool results, hidden initial states, reference repairs and grader details were excluded. Redaction is specific to the two synthetic source customers, not a real-user privacy mechanism.
- The corrected collector terminated on successful human handoff, removing the earlier farewell-loop defect.
- Both conversation roles used automatic five-minute prompt caching. This preserves prompt content while reducing repeated-history processing costs, as described in the [Anthropic documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The model produced one **555-character addition** about verifying device settings after account fixes, distinguishing device and account roaming, and checking remaining data before further MMS diagnosis. The host appended it to the baseline actor. No hand-written repair was substituted, no second proposal was requested, and the proposer was not evolved.

## Frozen experiment and results

The protocol, inputs and 55 source snapshots were frozen before provider calls. Source cases remained 14 and 45; recipient cases remained 38 and 41. The latter had been reserved by the first study and never run because its source gate failed. The new source gate required both repairs to succeed naturally and a strict improvement over the replayed pilot baseline. All six newly collected episodes ended naturally with native assertions satisfied, strict replay matched, and unrelated account state preserved.

| Stage                    |    Baseline successes | Additive strategy successes |
| ------------------------ | --------------------: | --------------------------: |
| Source qualification     | 1/2, historical pilot |        2/2, newly collected |
| Reserved recipient cases |  2/2, newly collected |        2/2, newly collected |

The source baseline reuses paid historical observations at zero new charge. Several implementation and evidence changes occurred together, and sampling was unseeded. The source result therefore does not isolate the causal effect of append-only editing, richer feedback, or sampling variation. Source selection was adaptive development; only the recipient cases were held out from the proposer.

The transfer used the existing Ed25519 envelope and strategy importer. Each recipient arm started with a fresh SQLite store and no execution evidence; the transferred arm imported instructions and lineage, not source qualifications. Candidates were sealed before recipient evaluation. This exercises authenticated transfer between isolated stores on one host, not a live Rust mesh or deployment across actual users. Both cases are from the same synthetic telecom domain and familiar task families.

| Recipient measure, two cases              |    Baseline | Transferred |
| ----------------------------------------- | ----------: | ----------: |
| Successful repairs                        |           2 |           2 |
| Model calls, including simulated customer |          87 |         116 |
| Native tool calls                         |          32 |          38 |
| Provider spending                         | $0.39645450 | $0.45855555 |
| Uncached price equivalent                 |   $2.035344 |   $2.875689 |

Observed transferred spending was **15.7% higher**, model calls **33.3% higher**, and tool calls **18.8% higher**. These are descriptive results from two pairs, not stable effect estimates. The baseline already solved both cases, so there was no recipient accuracy headroom.

The uncached price equivalent applies the same base input/output prices to every observed token, including cached tokens. It is a counterfactual accounting comparison, not an additional charge or latency measurement. The fixed execution order produced different cache warmth: transferred case 38 was slightly cheaper in billed spending despite consuming more model calls and tokens. Pricing all observed tokens consistently removes that apparent efficiency advantage. The analysis now reports both views and does not label equal accuracy at higher resource use as an improvement. Prices follow the [Anthropic pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing), checked November 2, 2026.

Inspection of case 41 found extra account lookups, a reboot and two data toggles in the transferred trajectory. The baseline solved it without those operations. The actor interpreted a status-bar indication of unavailable data as a reason to toggle the setting, although effective connectivity and the configured data switch are distinct. This is an observed detour; one stochastic execution does not prove that the added checklist caused it.

## Costs and verification

This collection used **288 model calls**, including one proposal, and cost **$1.26398145**. The proposal cost $0.03420000; its two source trials cost $0.37477140. Including the pilot and earlier unsuccessful correction, attributable development spending for this candidate is **$3.27102525**. That discovery allocation is separate from physical provider spending and cannot be ignored when judging deployment economics.

Project-wide known spending is **$9.26338830**. The pre-existing unresolved reservation remains **$0.073722**, giving **$9.33711030 exposure against the $10 cap**, with **$0.66288970 remaining**. This collection has no unresolved request and did not raise the cap.

The replay audit reconstructed all six conversations and native outcomes without new model calls. It checked exact requests, frozen source hashes, proposal composition, the full development feedback persisted in SQLite, the signed envelope, recipient seals, and raw usage against both episode totals and the SQLite resource ledger. Earlier frozen collections still replay successfully.

All 33 targeted tests passed: 16 strategy/route tests, 12 existing experiment-harness tests, and five native adapter tests. Repository TypeScript checking passed with `tsc --noEmit`; `tsgo` could not start because its Windows platform binary is missing. Targeted formatting and lint checks passed.

Evidence:

- [Frozen protocol](../../benchmarks/learning-strategy/data/telecom-additive-transfer-v1.zip) and [candidate](../../benchmarks/learning-strategy/data/telecom-additive-transfer-v1.zip).
- [Results and transfer decisions](../../benchmarks/learning-strategy/data/telecom-additive-transfer-v1.zip).
- [Full replay audit](../../benchmarks/learning-strategy/data/telecom-additive-transfer-v1.zip).
- [Cost and resource analysis](../../benchmarks/learning-strategy/data/telecom-additive-transfer-v1.zip).
- [Adapter and reproduction commands](../../benchmarks/learning-strategy/telecom/README.md); [lab API](learning-strategy-lab.md).

## Implication for the implementation

Keep bounded additions, richer evidence, regression checks and cost-aware reporting in the shadow lab. No live strategy or public peer deployment was activated. The result is an engineering success for local learning and authenticated transfer, but the experiment supplies no positive evidence of recipient benefit over the unchanged actor.

The next hypothesis should be **conditional reminders that reuse verified observations**, rather than adding the same checklist to every task. An observable trigger should justify each reminder; state-changing toggles should follow a check of the actual setting, and already-satisfied prerequisites should not be repeated. That requires a newly frozen evaluation, repeated samples and a strong verified-procedure-reuse control. Cases 38 and 41 are now consumed evaluation data and must not serve as a fresh final test after further tuning. A broader cost/non-regression gate should include unaffected workflows before any production recommendation. Recursive proposer learning and improvement across real users remain unproven.
