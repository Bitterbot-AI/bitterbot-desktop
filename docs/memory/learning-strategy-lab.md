---
title: "Learning Strategy Lab"
description: "Shadow evaluation of evolving actor and proposer instructions with local execution evidence and authenticated transfer."
---

The strategy lab is a host-only experimental capability of the procedural-learning service, available by default in `shadow` mode. Access `service.strategies` on a `ProceduralLearning` instance. Active and off stores reject lab work. The lab does not schedule research studies or activate its candidates. The same service now also hosts a separate automatic coordinator for production failure experiments, described below. Construction is lazy; each agent has a separate `procedural-learning.sqlite` in its agent directory, which survives memory-vector reindexing.

Hosts obtain the per-agent service with `getProceduralLearning({ cfg, agentId })` from the plugin SDK. No configuration block is required. The returned service may be null when explicitly disabled or when the memory manager is unavailable. A typical experiment registers development and held-out panels, adds the starting strategy with `archive.add`, evaluates it, proposes and evaluates children, selects from `archive.rank(developmentPanelId)`, and freezes the chosen hashes with `archive.seal` before final evaluation. The runnable benchmark below demonstrates this complete sequence, including fixed-proposer controls and recipient imports. Registering a panel is a trusted host operation; the `isolation` declaration is not itself an operating-system sandbox.

## Defaults and automatic behavior

| Component                                                                  | Default             | What runs                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production skill evolution (`skills.evolution.enabled`)                    | `true`              | Idle dream ticks and the post-cycle hook share a learning lane. Evidence, model availability, cadence and budgets apply; task validation, canary monitoring and rollback govern promotion. |
| Automatic coordinator (`memory.proceduralLearning.automation.enabled`)     | `true`              | In shadow mode, coordinates failure-driven production experiments on the default agent, with durable reservations and bounded retries.                                                     |
| Procedural service (`memory.proceduralLearning.mode`)                      | `shadow`            | A local evidence store opens on first host use or eligible learning tick. Research evaluations still need a host adapter and request.                                                      |
| Verified experience (`memory.proceduralLearning.experienceMemory.enabled`) | `true`              | After a settled acquisition run, a registered adapter's optional redacted extractor can attach experience. Held-out runs and invalid or interrupted outcomes are excluded.                 |
| Strategy lab (`service.strategies`)                                        | Available in shadow | The host explicitly supplies panels, proposals and evaluations. There is no scheduler or automatic connection to conversation traces.                                                      |

The production loop is documented in [Skills pipeline](skills-pipeline.md). Enabling the research service does not feed its candidates into that loop. Shadow lookup supplies no lessons for live decisions, and experience recall requires an explicit shadow-evaluation request. Automatic experiment records reference existing journal runs by ID and hash; they do not copy raw conversations into research panels or experience memory.

The defaults need no config. To disable the service:

```json5
{
  memory: {
    proceduralLearning: { mode: "off" },
  },
}
```

To retain the lab but disable experience extraction, set `memory.proceduralLearning.experienceMemory.enabled: false`. This also prevents the adapter's extraction callback from running. To disable the automatic idle coordinator, set `memory.proceduralLearning.automation.enabled: false`. The legacy full-dream evolution hook remains controlled by `skills.evolution.enabled`; set that to `false` to stop production evolution altogether. Existing explicit `off`, `active`, and `enabled: false` settings are respected. Restart the gateway after changing these settings. Malformed procedural settings are rejected when the service is requested; they do not fall back to enabling it.

`active` remains an explicit host-integration choice for procedural execution and retrieval. It is not an autonomous-learning switch and cannot run strategy-lab experiments. No default tool scopes or adapters are registered. The procedural execution budget defaults to zero provider dollars, 100 tool calls and 60 seconds; host-requested strategy evaluations additionally use explicit, durably accounted budgets. Merely opening the service issues no model calls.

## Automatic failure experiments

`service.failureExperiments` coordinates the existing production proposer and task gate. The dream engine schedules this lane; it is not a creative mode. It runs on eligible scheduled ticks even when the full dream skips for lack of new input or a recent cycle. The default agent owns the node-wide skill wiki and executor; secondary managers do not launch competing runs. Learning waits for the configured dream idle threshold (60 minutes by default), respects background usage pauses, and shares `skills.evolution.cadenceHours` (24 hours by default, minimum one hour) with the full-cycle hook. Disabling dreams disables its scheduled entry point.

The journal remains the durable source queue. Complete, learnable first-party failures can trigger a proposal; held-out, peer, guest, validation, incomplete and environment-failure runs do not become proposal evidence. The wiki maintainer consolidates the window, the proposer reads evidence and stages a candidate, and the existing task gate compares it with the incumbent on independent tasks. Source-contaminated tasks are excluded. A judge's opinion cannot promote it. Passing candidates enter canary exposure; existing monitoring, rollback and maturity rules continue to govern later use and sharing. No research-panel candidate is imported automatically, and no raw failure trace is published by this coordinator.

Each cycle durably reserves model callback dispatches and trial agent turns **before** dispatch. Defaults are 64 model callbacks, 240 agent turns and 60 minutes per cycle (`automation.maxLlmCalls`, `maxAgentTurns`, `maxWallMinutes`). These are dispatch ceilings, not dollar or provider-request counts: one trial turn may make multiple requests. Production model usage remains in the existing usage ledger and subject to its configured budgets; the research service's zero-dollar `executionBudget` is a different host-adapter budget. Wall time is checked between dispatches, and in-flight requests finish under their existing timeouts.

Pause, exhausted dispatch limits and shutdown hold work rather than turning interrupted trials into failure evidence. The host checks readiness again immediately before promotion. Final storage publication checks both the evaluated candidate bytes and the live incumbent used by the comparison; a concurrent skill edit blocks publication. Index sync pauses new dispatch, and a database swap invalidates the running lane's readiness. Idle and full-cycle entry points share one in-flight run. The manager serializes the lane with memory maintenance, retains lifecycle/canary accounting and drains it before closing databases; long experiments may defer other maintenance.

The local `failure_learning_cycles`, `failure_experiments` and `failure_experiment_verdicts` tables contain reservations, failure references, proposal hashes and gate receipts. Inspect `service.status().automaticExperiments` for the latest 20 cycles and experiments; the existing `skill-wiki/iterations.jsonl`, staging metadata, impact trail and canary ledger retain detailed pipeline evidence. Opening status does not dispatch work. An unfinished proposal may retry at the next cadence, at most three attempts for the same sampled failure batch. Maintenance parse failures retain the existing three-attempt policy. Once staged, a candidate resumes through gate housekeeping rather than proposal generation. Dead-process recovery marks interrupted work without erasing its dispatch reservations; a live owner is never stolen. Ledger capacity exhaustion stops new work explicitly.

The integration tests use scripted executors through the real sampler, staging, scratch-workspace runner and task gate. They prove the orchestration and promotion boundaries, not additional model improvement or user benefit. The research results below retain their original failed qualification verdicts.

## Manual strategy experiments

```mermaid
flowchart LR
  E[Local execution feedback] --> P[Proposer instructions]
  P --> A[Versioned actor and proposer candidates]
  A --> D[Sandbox development evaluation]
  D --> R[Archive including unsuccessful branches]
  R --> P
  R --> S[Freeze selected candidates]
  S --> H[Held-out evaluation]
  R --> X[Shareable signed lineage]
  X --> L[Recipient candidate archive]
  L --> V[Recipient local evaluation]
```

A strategy contains an actor instruction, a proposer instruction, exact compatibility scope, immutable parent hashes, a sharing declaration and an expiry. Only these typed data fields are accepted. Strategy data cannot register tools, change permissions, modify GENOME, replace outcome verification, or execute source code. Hosts register sandbox adapters through `registerPanel`, pinning the model, verifier revision, task inputs and development/held-out partition.

`evaluate` executes the actual actor through the host adapter and then calls the independently registered verifier. Complete development batches can rank candidates. Unsuccessful candidates remain available for exploration, but partial batches, invalid verifiers and unresolved costs cannot create a selectable result. `propose` supplies only local development feedback to a host model callback. It supports a fixed-proposer control and an evolving proposer. Generated edits have separate accounting and never count as successful task execution merely because their schema is valid.

For small corrections, `propose({ editMode: "append", evolveProposer: false, ... })` accepts only `{ append: string }`, bounded to 600 characters. The lab appends that text to the unchanged parent actor, retains the host's fixed proposer, and enforces the existing 4000-character actor limit. It rejects replacement fields and proposer evolution in this mode. Malformed generated edits still incur their actual generation cost. This preserves the original text, but additions can still contradict or distract from it; behavioral regression gates remain necessary. Omitting `editMode` preserves the existing replacement behavior.

`editMode: "conditional"` accepts only `{ reminders }`, preserves the parent actor text, and requires a fixed proposer. A strategy can carry at most four bounded rules over Boolean/unknown observations, with optional suppression predicates. The host must pin its supported `reminderFacts` vocabulary in the panel and interpret observations through an episode-local `StrategyReminderSession`; unsupported vocabularies are rejected before execution. The session suppresses repeated advice for unchanged evidence and supports explicit invalidation and reset. It never reads a task or verifier. The [completed conditional reminder experiment](conditional-reminders-experiment.md) passed replay auditing but failed its exploratory gate; no reminders activated in six conditional episodes. Hosts need observation-coverage qualification as well as outcome verification before claiming mechanism benefit. Rule data remains subject to the existing provenance, expiry, shadow-mode and transfer restrictions.

A panel may pin `feedbackLimit` between 1 and 32000 characters when the default 6000-character development feedback limit loses useful observations. This limit becomes part of the immutable panel identity. It does not change held-out feedback isolation or sharing rules. Hosts should construct bounded, redacted evidence before evaluation; increasing the limit does not make private conversations shareable. The telecom adapter uses ordered actor-visible dialogue and selected account fields from synthetic source cases, explicitly excluding private customer tool results.

The lab reuses the procedural resource ledger. Every proposal or execution reserves costs before dispatch. Unknown spending blocks further operations in that store. The host must reconcile actual receipts; interruption is not a free call. Cooperative cancellation and sandbox enforcement remain host responsibilities. Existing procedural shutdown waits for in-flight lab operations before closing SQLite.

This extends instruction and workflow learning; it does not train model weights. The database boundary is per agent, following the existing service. A shared agent is not automatically partitioned by individual user. Multi-user operation still needs explicit consent, feedback redaction and an appropriate tenant boundary before a learning panel can be marked shareable.

`archive.seal(scope, hashes)` freezes candidate selection before held-out execution. Sealed scopes reject further search. Held-out results cannot rank parents or appear in proposal feedback, and a held-out candidate/panel combination cannot implicitly rerun. Exact input hashes catch identical cross-partition inputs; the host must additionally ensure semantic and task-family separation. Adaptive development scores are not final generalization estimates.

A seal is permanent within that store and scope. This first implementation supports finite research studies; it has no automatic experiment-epoch rollover or research-panel scheduler. Run a new independent study in an isolated store rather than deleting a seal to continue tuning on an exposed final panel. Ordinary procedural learning is unaffected by a strategy seal.

The archive supports explicit withdrawal with transitive descendant invalidation. Expired or missing ancestors also make descendants unavailable. No strategy receives an active-skill state. A proposal trained on a private panel remains private even when its parent was shareable. Hosts must explicitly mark a panel's complete feedback as shareable before inheriting shareable provenance; this is a data-governance declaration, not an automatic privacy classifier.

`exportStrategyPacket` requires local development execution and shareable, available ancestry. `importStrategyPacket` checks the existing native Ed25519 envelope signature and content hash and atomically imports the bounded lineage. It imports no source qualification, authority, or executable capability. The receiving host evaluates applicability and behavior in its own environment. The ordinary filesystem loader quarantines strategy packets; manual skill acceptance and crystal ingestion reject them. There is no strategy auto-publication route.

Development evaluation is not qualification for production and does not prove a sharing decision safe. Hosts should provide only redacted, bounded feedback and retain private user information locally. Distinct signing keys do not establish independent experiments. Global reputation and consensus are outside this initial implementation.

The [experiment harness](../../benchmarks/learning-strategy/README.md) implements a bounded 2-by-2 study and separate recipient comparisons. Its synthetic functions, strong outcome oracle and small search population limit generalization. Actual 24-hour retention, live Rust mesh propagation, real-user benefit and deployment-level performance are not established by engineering qualification.

## Main integration boundary

Omitted `memory.proceduralLearning` settings enable lazy shadow access and the production failure-experiment coordinator; `mode: "off"` returns no service. Automatic work uses the existing production staging and task gates. The host research facility and verified-experience capture do not authorize research-candidate promotion. Signed research packets cannot become active filesystem skills through trust or manual acceptance.

The [latest repair-reuse study](telecom-guarded-procedure-reuse.md) found that each generated procedure repaired 12/28 additional failed recorded states and preserved 16/16 healthy states without mutations, with zero model calls during execution. Generation used model calls. Both tied advice at 6/12 on the original inputs and failed the frozen qualification gate. The four consumed case clusters do not establish fresh-task, real-user or recipient-transfer benefit. Default availability does not change those results or qualify those candidates for production. See the [complete evidence archive](../../benchmarks/learning-strategy/data/README.md), including unsuccessful runs.
