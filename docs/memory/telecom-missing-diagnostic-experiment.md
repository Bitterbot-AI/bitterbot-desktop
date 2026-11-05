---
title: "Missing-diagnostic reminder experiment"
description: "A narrowly triggered allowance check, qualified offline and compared on fresh synthetic telecom cases."
---

This experiment addresses a failure that the original reminder rules could not catch: an agent never checked the data allowance, so a reminder conditioned on already observing exhaustion could not help. The new rule suggests that missing check when the customer reports both failed MMS and strong cellular signal, and the affected line's allowance remains unknown. Strong signal does not establish working internet or exhausted allowance.

The implementation remains in Bitterbot's existing shadow strategy lab. It uses the same archive, held-out panels, sealed candidates, SQLite cost ledger and native telecom tools. No live agent or peer receives the candidate automatically. This is a host-authored diagnostic hypothesis derived from development traces, not evidence that an autonomous proposer learned a better learning algorithm.

## Implementation and offline qualification

The new rule is separate from the original four rules. It suggests checking the affected line's usage against its observed plan allowance before repeated device resets or handoff. It explicitly preserves consent requirements and distinguishes missing evidence from a diagnosis.

Two episode-local facts record explicit public reports of failed MMS and strong cellular signal. Questions, supported hypothetical/quoted reports and contradictory observations cannot establish the trigger. Recognized network/reset instructions invalidate both facts, so a failure before such a repair cannot establish failure afterwards. Known allowance, customer/phone changes and private customer tools have negative coverage. The observation parser supports bounded phrases and diagnostic labels; it is not general language understanding. Its mutation-word coverage is also incomplete: permission grants and VPN connection changes require explicit lifecycle handling before broader use.

On 24 consumed development trajectories, the rule would deliver three reminders. It reaches the previously missed diagnostic in `baseline-1-32` at transcript position 35, using the public signal report at 18 and renewed MMS failure at 34, before further device checks and resets. All six simple control trajectories remain quiet. These are fixed-observation replays: no recorded decisions or task outcomes change.

The frozen qualification includes 20 passing tests, including registration of the small panels with the actual strategy lab. The earlier 18-episode study also still replays all 630 recorded calls against its original frozen sources. The new adapter revision is `text-v5-missing-diagnostic`; the grounded customer simulator introduced in v4 is unchanged.

## Prospective comparison

The [frozen protocol](../../benchmarks/learning-strategy/data/telecom-missing-diagnostic-v2.zip) specifies nine episodes: three fresh cases, three arms, one draw per arm/case. Case 2 is a mobile-data/roaming control; case 28 combines MMS permission and allowance problems; case 31 combines MMS network and permission problems without exhausted allowance. Selection uses pinned task metadata, not new model outcomes. Hidden task labels and solutions do not enter model prompts or routing.

The arms are the original actor, the same rule always present as an instruction, and the rule delivered conditionally. Each arm has a fresh sealed SQLite store, each episode a fresh native environment, and all share the same model and grounded simulator. Case order rotates within arms. Arm order is fixed baseline/static/conditional, so caching and order remain confounders; uncached price equivalents accompany actual cost.

Before any provider request, `telecom-missing-diagnostic-v1` was rejected because the existing lab requires at least two cases per panel. Its attempted one-case interleaving schedule and zero-spend failure are preserved. The v2 protocol uses three-case panels. Neither candidate text nor selected cases changed; all sources were refrozen before paid collection.

The collection requires nine natural completions, reports actual reminder activation and subsequent actions, and applies the paired success/call/cost gate against both controls. Zero activation is explicitly unexercised. Grounding failures or resource stops censor the comparison, retain costs and are not silently retried. Three unseeded pairs cannot establish efficacy or justify live promotion.

The cumulative authorized ceiling is $15. Exposure before this comparison was $11.68566225, including the older unresolved reservation. This distinct nine-episode protocol requires $2.50 starting headroom and retains conservative per-call reservations under the global cap.

## Results

All nine episodes completed naturally and passed the native verifier. There were no grounding stops, resource truncations, new unresolved requests or retries.

| Arm                  | Success | Model calls | Tool calls | Paid USD | Uncached equivalent USD |
| -------------------- | ------: | ----------: | ---------: | -------: | ----------------------: |
| Baseline             |     3/3 |         107 |         37 | 0.440330 |                2.334234 |
| Static instruction   |     3/3 |          97 |         34 | 0.377029 |                2.156274 |
| Conditional reminder |     3/3 |         122 |         45 | 0.420150 |                2.685543 |

The conditional reminder delivered **zero reminders**. Its mechanism remains unexercised, and the frozen descriptive gate fails against both controls. Conditional execution used 15 more model calls and eight more tool calls than baseline, and 25 more model calls and eleven more tools than static instructions. Its slightly lower billed cost than baseline is not an efficiency result: its uncached price equivalent is higher, and no reminder reached the model. The static arm's smaller totals are descriptive observations from three unseeded pairs, not proof of a durable benefit.

The [audit](../../benchmarks/learning-strategy/data/telecom-missing-diagnostic-v2.zip) reproduces all **326 model requests** and nine episodes from frozen sources, including exact prompts, public/private routing, native outcomes, usage receipts, sealed stores and SQLite totals. No collector source changed during collection. The [analysis](../../benchmarks/learning-strategy/data/telecom-missing-diagnostic-v2.zip) retains every assigned trial; the [diagnostics](../../benchmarks/learning-strategy/data/telecom-missing-diagnostic-v2.zip) explicitly mark zero activation.

## What the fresh cases revealed

The offline qualification did not generalize across ordinary report wording. In `conditional-0-31`, the customer reported a “5G connection with excellent signal” at transcript position 14, then repeated MMS failure at 18. The bounded signal parser did not recognize the report, so the reminder never fired. In `conditional-0-28`, the public report was “a good 5G signal” at position 10, followed by another explicit MMS failure at 30; that wording also failed to establish the signal fact. The agent eventually checked and refueled the allowance without a reminder.

This is an observation-interface failure, not evidence that the missing-check advice is effective or ineffective when delivered. It also confirms that passing tests built from consumed trajectories is insufficient for coverage of fresh conversations. The mobile-data control itself varied substantially without reminder delivery, illustrating why raw arm totals cannot establish a mechanism effect.

## Decision and next implementation direction

Keep the bounded candidate archive, provenance, local qualification and exact replay machinery. Do not promote this reminder or spend the remaining budget on another phrase-matching revision. The current evidence does not support this implementation as an effective learning mechanism for live users.

The next adapter should carry structured **public observation records** alongside customer speech, with an explicit allowlist, value, subject, supporting public evidence and observation version. All arms must receive the same public records. Private customer tool results, hidden task state and grading assertions must not silently become actor observations. Tests should cover paraphrase invariance, contradictory reports, line changes, permission changes, VPN changes and post-repair invalidation. A record without adequate public provenance should remain unknown.

Qualify that interface offline with withheld report variants before another model comparison. Then use fresh cases with both a known diagnostic opportunity and negative controls, and measure actual activation and subsequent actions before making a success or efficiency claim. No further provider calls or production activation were made after this collection.

New usage was **$1.23750915**. Cumulative exposure is **$12.92317140 of $15**, including the older $0.073722 unresolved reservation, leaving **$2.07682860**. Cases 2, 28 and 31 are now consumed development evidence and cannot serve as fresh final evaluation after tuning.

Reproduce the completed audit and descriptive analysis without provider calls:

```sh
node benchmarks/learning-strategy/telecom/audit.mjs benchmarks/learning-strategy/results/telecom-missing-diagnostic-v2
node benchmarks/learning-strategy/telecom/analyze.mjs benchmarks/learning-strategy/results/telecom-missing-diagnostic-v2
node benchmarks/learning-strategy/telecom/diagnose.mjs benchmarks/learning-strategy/results/telecom-missing-diagnostic-v2
```

Preserve the frozen sources and original outputs. `conditional.mjs prepare-diagnostic <new-id> 15` now rejects these consumed cases before creating a new run or making a provider call; a future study needs a separately frozen protocol and fresh cases.
