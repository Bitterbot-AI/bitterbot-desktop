---
title: "Structured public observations for telecom learning"
description: "Explicit diagnostic publication replaces phrase matching, with offline provenance, freshness and common-visibility checks."
---

The telecom adapter now routes diagnostic facts through an explicit public observation contract. It no longer depends on recognizing a customer's phrasing to deliver the missing-allowance reminder. This implements the next step from the [nine-episode comparison](telecom-missing-diagnostic-experiment.md), whose conditional arm never delivered a reminder.

This report records the original v6 offline qualification, which made no paid requests. The subsequent [two-case model-compliance pilot](telecom-public-observation-compliance.md) failed its gate: one stale-reference rejection and one unresolved handoff. It cost $0.29996850 and all 61 calls replay exactly. The current v7 adapter supplies private current-reference availability before customer responses; that follow-up has not yet been tested with a model. Neither version establishes better task outcomes, autonomous learning or transfer between users.

## Publication and provenance

The simulated customer retains its private native diagnostic tools. After a supported check completes, its private tool result includes shareable source references. The customer must explicitly call `share_observations` and select the fact/source references it wants to publish. The host supplies values and narrowly selected evidence fields from those completed diagnostics; the customer cannot submit its own values, substitute a subject or cite an unknown source.

The supported device facts are MMS failure, strong cellular signal, the mobile-data switch and the device roaming switch. MMS comes from the exact pinned `can_send_mms` result. The other facts come from fixed fields in `check_network_status`. Strong signal means a connected 4G/5G network with good or excellent signal; it does not imply working internet or remaining allowance. Network names, unrelated fields, private thoughts, hidden task state and verifier assertions are not automatically published.

Every accepted record includes the fact, boolean value, selected evidence, diagnostic tool, source reference, revision and episode-local device scope. The actor receives a canonical JSON envelope containing separate `speech` and `observations` fields. Report-looking text inside speech cannot create structured facts. Narration remains unvalidated except for the existing bounded birth-date guard; this does not establish general simulator factuality or protect an LLM against every misleading statement.

Baseline, static and conditional arms all receive the same public record format. Only the conditional arm receives selected reminders. Private diagnostic results never enter reminder routing directly. A plain spoken response publishes an empty device snapshot, so remembered device facts cannot survive merely because a later reply omitted evidence.

## Freshness and scope

A newer diagnostic read supersedes older references, including when the newer read fails or has malformed/contradictory labels. Network-changing operations invalidate device observations. Permission and VPN changes invalidate the MMS result while preserving unrelated radio evidence. Account writes invalidate MMS evidence conservatively. Unknown device writes invalidate all supported device facts. Old references cannot be revived by rewording the report.

Public account target changes rotate the episode-local scope and discard old references. Inspecting another line's record does not itself change the selected target. Existing owned-line/plan joins continue to establish account allowance; a known allowance suppresses the missing-check rule. Out-of-order snapshots, duplicate facts, unsupported fields and value overrides are rejected.

The subject is the single customer device in this synthetic episode. Scope rotation is a freshness boundary, not proof of physical device ownership or a general multi-user identity system. A production implementation needs authenticated subject bindings and a policy for external changes and time-based expiry.

Malformed or stale publication stops the episode with `simulator-observation-failure` before actor delivery. Its charged response remains recorded, there is no silent retry, and rejected content is excluded from learning feedback. Successful public records are included once in that feedback. Terminal handoff still stops immediately.

The original adapter revision was `text-v6-public-observations`; the current private availability follow-up is `text-v7-current-references`. Collector snapshots include the contract, and strategy scope hashes include the adapter revision. Historical baseline reuse across revisions is rejected. Legacy phrase routing remains available only for explicit historical diagnostics; structured routing rejects legacy predicates without a supported public observation contract, including travel/location predicates. It does not silently accept them and then fail to trigger.

## Offline evidence

The original [v6 frozen qualification](../../benchmarks/learning-strategy/data/telecom-public-observation-qualification-v3.zip) covers the native tools, three-arm visibility and additional report wording. The fixtures use scripted responses and zero-cost provider stubs; they do not sample a model. The subsequent [v7 qualification](../../benchmarks/learning-strategy/data/telecom-public-observation-qualification-v4.zip) adds current-reference regressions, passes 37 tests and preserves all six fixture/replay, 72 wording and 144 negative-control checks. The table below records the original v6 results.

| Check                                                    |     Result |
| -------------------------------------------------------- | ---------: |
| Focused adapter and lifecycle tests                      |  31 passed |
| Native scripted fixtures: two conditions × three arms    |   6 passed |
| Exact scripted request/trajectory replays                |   6 passed |
| Additional report wording variants                       |         12 |
| Wording × condition × arm checks                         |  72 passed |
| Empty or partial snapshot controls                       | 144 passed |
| Conditional blocked-MMS variants delivering the reminder |      12/12 |

The blocked fixture intentionally remains unrepaired and ends in handoff; the working fixture applies a fixed native repair before reporting. Their native outcomes match those expectations. These fixtures qualify routing and state handling, not agent problem solving. The twelve wording variants are contract invariance checks: typed records remain identical because the router does not classify prose. They are not twelve independent repair successes or a semantic-language benchmark.

Unit coverage additionally rejects invented/stale sources, unsupported facts, duplicate/contradictory claims, mixed publication/write calls, forged envelope text, invalid subject/value fields and ungrounded birth dates. It verifies that invalid publications remain charged and that unselected private fields stay out of actor messages and learning feedback. Repeated sharing of unchanged evidence does not spam the reminder.

The earlier paid comparison remains unchanged: all 326 recorded calls and nine episodes replay correctly from its frozen sources. Preliminary offline qualifications v1 and v2 are retained; v3 additionally covers the canonical envelope and rejection of unsupported legacy facts. No task or result was silently retried with a paid model.

## Next experiment boundary

The completed model-compliance pilot did not pass. It exposed stale-reference selection and omission of still-valid facts needed for a reminder. Current-reference availability is now explicit in the customer model's private request, without automatically publishing any evidence. A fresh prospective model test is still needed before an outcome comparison. Extra schema and record tokens may also add cost.

Keep outcome comparisons paused. The previous nine-episode protocol and the two-case compliance protocol both use consumed cases. A future pilot needs its own fresh cases, explicit success criteria and a budget envelope within the existing cap, or further authorization for a larger cap. Do not reuse historical outcomes as fresh controls under a new interface.

No live Bitterbot agent or peer was activated. Following the compliance pilot, cumulative exposure is **$13.22313990 of $15**, including the older unresolved reservation, with **$1.77686010** remaining.

Reproduce focused checks without provider calls:

```sh
node --import tsx --test benchmarks/learning-strategy/telecom/telecom.test.mjs benchmarks/learning-strategy/telecom/diagnostic-observations.test.mjs benchmarks/learning-strategy/telecom/public-observations.test.mjs benchmarks/learning-strategy/telecom/current-references.test.mjs benchmarks/learning-strategy/telecom/compliance-report.test.mjs
node benchmarks/learning-strategy/telecom/audit.mjs benchmarks/learning-strategy/results/telecom-missing-diagnostic-v2
```

Preserve the frozen qualification artifacts and source copies. The standalone qualification generator writes a new named result directory and refuses to overwrite its versioned qualification file; rerunning the tests above is sufficient for ordinary verification.
