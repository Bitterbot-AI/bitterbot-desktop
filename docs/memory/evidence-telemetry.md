# Evidence Telemetry

An observational layer under the curiosity and dream system. It records what retrieval surfaced, what the agent proactively surfaced to the owner and what came of it, and (in shadow mode) what a "GCCRF as diagnostic only" routing would have decided in the dream engine next to what the legacy routing actually decided. It changes no behaviour in any mode: retrieval order, dream seeds, dream mode choice, hormone events and target closure are exactly what they were before it existed. Later phases read these tables; this phase only writes them.

Code: `src/memory/evidence-telemetry.ts` (writer), `src/memory/surfacing-trial.ts` (PLAN-59 Phase 2 shadow assignment), migrations v79 and v80 in `src/memory/migrations.ts`, call sites in `src/memory/manager.ts` and `src/memory/dream-engine.ts`.

## Modes and defaults

`memory.curiosity.evidence` in `bitterbot.json`:

```json5
{
  memory: {
    curiosity: {
      evidence: {
        mode: "shadow", // "off" | "observe" | "shadow"; default "shadow"
        retentionDays: 90, // rows older than this are pruned on the consolidation tick
        topK: 10, // at most this many retrieval rows per search
      },
    },
  },
}
```

- `off`: nothing is written. The tables still exist (the migration creates them) and old rows are still pruned.
- `observe`: retrieval hits and surfacing events.
- `shadow` (default): observe plus decision traces from the dream engine. Shadow is the default so the divergence traces that decide whether GCCRF stays a live ranking term or becomes a diagnostic accumulate on every node; the traces are a few rows per dream cycle and change nothing the engine does.

A mode that is not one of the three falls back to `shadow` with a warning; a non-positive `retentionDays` or `topK` falls back to the default. The layer works whether or not `memory.curiosity.enabled` is on; `evidence.mode: "off"` is its own switch.

## The three tables

### `retrieval_hits`

One row per returned result, at most `topK` per search, written in one transaction after the final ordering (fusion, boosts, superseded demotion) is fixed. Guest searches (`guestSearch`) are never recorded. The PLAN-59 Phase 1 pilot harness (`benchmarks/plan59-phase1/`) reads this table, decayed with a 30-day half-life, as the demand term of its need estimate whenever it is present and non-empty on the snapshot under test.

| column               | meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `query_id`           | random id shared by the rows of one search                                                          |
| `query_digest`       | HMAC-SHA256 (first 32 hex chars) of the trimmed query under the node-local key                      |
| `session_digest`     | same digest of the session key, or NULL when the call had none                                      |
| `caller`             | short call-site tag (`memory_search`, `deep_recall`, `rlm_context`) or NULL                         |
| `query_len`          | length of the query in characters                                                                   |
| `chunk_id`, `rank`   | the chunk and its 1-based position in the returned list                                             |
| `fused_score`        | the score as returned                                                                               |
| `channel_ranks_json` | per-channel 1-based ranks (`vector`, `keyword`, `graph`) where the channels are in scope            |
| `injected`, `cited`  | NULL in Phase 0 (no cheap signal exists yet; later phases fill them)                                |
| `embedding_model`    | the query embedding model                                                                           |
| `scoring_version`    | `gccrf_state.scoring_version` at write time (`gccrf-v2`), so rows can be split by scorer generation |
| `created_at`         | epoch ms                                                                                            |

Indexes: `created_at`; `(chunk_id, created_at)`; `query_id`.

### `surfacing_events`

What the agent put in front of the owner, and separately what the owner did about it.

| column             | meaning                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_id`         | idempotency key (`INSERT OR IGNORE`), for example `cf:<finding id>:<hour bucket>`                                                                                                                   |
| `kind`             | `curiosity_finding`, `proactive_recall`, `dream_brief`, `dream_digest`, `curiosity_target`                                                                                                          |
| `ref_id`           | the surfaced item (finding id, chunk id, brief id, notification key)                                                                                                                                |
| `arm`              | `legacy` (Phase 0 rows, or the trial off), `unassigned` (an `eligible` row, before the draw), `surface` or `withhold` (assigned by the surfacing trial)                                             |
| `opportunity_id`   | shared id of one opportunity across its `eligible`, `assigned` and `delivered` rows: the curiosity target a finding answered (so a dismiss by target id finds the delivery), the event id otherwise |
| `session_digest`   | digest of the conversation the item was surfaced in, when known                                                                                                                                     |
| `stage`            | `eligible`, `assigned`, `delivered`, `visible`, `responded`                                                                                                                                         |
| `outcome`          | `useful`, `corrected`, `dismissed`, `answered`, `engaged_weak`, `explicit_retrieval`, `unknown`; NULL until something labels it                                                                     |
| `label_provenance` | `explicit` (the owner acted), `inferred`, `shadow_crossover` (the crossover marker below), `unknown`                                                                                                |
| `cost_usd`         | cost attributed to producing the item, when known                                                                                                                                                   |
| `details_json`     | small JSON for the stage; an `assigned` row carries `{ blockId, blockMinutes, carryOver }` (v80); NULL otherwise                                                                                    |
| `created_at`       | when the stage was reached                                                                                                                                                                          |
| `outcome_at`       | when the outcome was labelled                                                                                                                                                                       |

Exposure and outcome are kept apart on purpose. A surfaced item is `delivered`; usefulness is only `explicit` when the owner acted. Silence is `unknown` (NULL outcome), never "ignored" or "disliked". A label that arrives for an item with no delivered row (for example a dismiss of a target whose finding was never voiced) creates a `responded` row so the action is kept.

### `decision_traces`

Shadow mode only. One row per decision the dream engine took where a GCCRF-as-diagnostic routing could have differed.

| column            | meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `kind`            | `dream_seed_rank` or `dream_mode_select`                                                 |
| `legacy_json`     | the decision that was used, canonical JSON (sorted keys)                                 |
| `proposed_json`   | the decision the GCCRF-free routing would have made                                      |
| `diverged`        | 1 when the decision differs. For modes this compares the selected list, not the weights. |
| `scoring_version` | `gccrf_state.scoring_version` at write time                                              |

- `dream_seed_rank`: legacy = the ids `selectSeeds` returned under `ORDER BY (importance_score + COALESCE(curiosity_reward, curiosity_boost, 0)) / (dream_count + 1)`; proposed = the same `WHERE` and `LIMIT` under `ORDER BY importance_score / (dream_count + 1)`. The dream-count penalty is kept on both sides because it is not a GCCRF signal.
- `dream_mode_select`: legacy = the modes `selectModes` chose with their adjusted weights and the GCCRF weight in force (0.25 to 0.3); proposed = the modes chosen from the same enabled set with the GCCRF adjustment zeroed. Both selections consume the same random draws, so a divergence reflects the weights and nothing else. The reserved utility-lane slot and the exploration auto-trigger are shared by both.

### `evidence_meta`

`digest_key` (32 random bytes, hex, created once on first use) and `schema_note`. Deleting the key makes every stored digest unlinkable to anything; it is never exported.

## What is never stored

- Query text, in any form. Only a keyed digest and the length.
- Session keys. Only their keyed digest.
- Result text or snippets. Only chunk ids, ranks and scores; join to `chunks` when you need the text.
- Anything in `off` mode.

Digests are HMAC-SHA256 under a key that exists only in this node's database, so two nodes never produce the same digest for the same query and a digest cannot be reversed without the key.

## Retention and cost

`prune()` runs once per consolidation tick (every 30 minutes by default) after the existing steps, deleting rows older than `retentionDays` in chunks of 2000 with an event-loop yield between chunks, so a backlog can never starve the gateway loop (see the event-loop notes in the memory docs). Every write is best-effort: a telemetry failure is caught and debug-logged and never reaches search or dreaming. A search writes at most `topK` rows in one transaction. The seed-rank shadow query is one extra indexed read per dream cycle; the mode shadow is pure arithmetic.

## How to query it

```sql
-- what did the agent search for most, by digest, this week?
SELECT query_digest, COUNT(DISTINCT query_id) AS searches
  FROM retrieval_hits WHERE created_at > strftime('%s','now','-7 days') * 1000
 GROUP BY query_digest ORDER BY searches DESC LIMIT 20;

-- which chunks keep coming back at rank 1?
SELECT c.path, c.start_line, COUNT(*) AS n
  FROM retrieval_hits r JOIN chunks c ON c.id = r.chunk_id
 WHERE r.rank = 1 GROUP BY r.chunk_id ORDER BY n DESC LIMIT 20;

-- surfacing: delivered vs explicitly labelled, by kind
SELECT kind,
       SUM(stage = 'delivered') AS delivered,
       SUM(label_provenance = 'explicit') AS labelled,
       SUM(outcome = 'dismissed') AS dismissed
  FROM surfacing_events GROUP BY kind;

-- shadow: how often would the GCCRF-free routing have decided differently?
SELECT kind, COUNT(*) AS traces, SUM(diverged) AS diverged
  FROM decision_traces GROUP BY kind;
```

`curiosity.status` (RPC and `bitterbot curiosity status --json`) returns `evidence: { mode, available, retrievalHits, surfacingEvents, decisionTraces, oldestAt, surfacingTrial }`; the `surfacingTrial` block is described below. The plain-text CLI status does not print the evidence block.

## Surfaces hooked on main

| surface                                                   | where                                                                  | kind                            | stages                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| curiosity findings voiced in the system prompt            | `MemoryIndexManager.consumeResearchFindings` (research-findings block) | `curiosity_finding`             | `eligible`, `assigned`, `delivered`                         |
| `curiosity.dismiss` RPC                                   | `MemoryIndexManager.curiosityDismiss`                                  | labels the finding by target id | outcome `dismissed`, provenance `explicit`                  |
| proactive recall facts injected into the prompt (PLAN-27) | `MemoryIndexManager.recallForUserTurn`                                 | `proactive_recall`              | `eligible`, `assigned`, `delivered`                         |
| anticipation brief offered in the prompt                  | `MemoryIndexManager.consumeDreamBrief`                                 | `dream_brief`                   | `eligible`, `assigned`, `delivered`                         |
| daily dream digest sent to the owner (PLAN-53 G4)         | `MemoryIndexManager.sendDreamBrief`                                    | `dream_digest`                  | `eligible`, `assigned` before the send; `delivered` after   |
| explicit owner search (`memory_search` tool)              | `MemoryIndexManager.search`, after the retrieval row                   | crossover marker                | outcome `explicit_retrieval`, provenance `shadow_crossover` |

Found and not hooked: the Curiosity page's list of findings (`curiosity.list`, a read, no delivery event), the skill-pipeline digest, auto-initiated owner messages and `message_owner` tool sends. Auto-initiated owner messages have no single call site that is cheap to hook as `owner_message`: they leave through `notifyOwner`, which is shared with task completions, stall sweeps, monitor alerts, cron notices and guest messages, most of which are essential or owner-requested and so exempt from the trial; hooking the shared sink would log exempt content as eligible. None of these carry a curiosity or dream artifact id that a later outcome could be joined to.

## Surfacing trial (shadow stage)

PLAN-59 Phase 2 asks whether proactively surfacing autonomously learned information is useful to the owner. Answering that needs a condition in which such content is withheld, and a withhold condition is an exposure decision the owner takes separately (PLAN-59 section 7, decision 2: live exposure accepted in principle, start gated). Before it can start, the instrument must run in shadow: every eligible surfacing opportunity is logged, assigned to an arm by a randomised block design, and then delivered exactly as today. This section describes that shadow stage. Nothing the owner sees changes in it, and the test `manager.surfacing-trial-neutrality.test.ts` asserts byte-identical output from every hooked surface with the trial off and in shadow.

Code: `src/memory/surfacing-trial.ts`. Config: `memory.curiosity.evidence.surfacingTrial` (see [configuration reference](/gateway/configuration-reference#memory-curiosity-evidence)).

### What is logged

For every opportunity at one of the four hooked surfaces, three `surfacing_events` rows with the same `kind`, `ref_id`, `opportunity_id` and `session_digest`, in this order:

1. `eligible`, arm `unassigned`, event id `eligible:<delivered event id>`. Logged before the draw; an opportunity logged eligible is never excluded afterwards.
2. `assigned`, arm `surface` or `withhold`, event id `assigned:<delivered event id>`, `details_json` `{ blockId, blockMinutes, carryOver }`.
3. `delivered`, the Phase 0 row, now carrying the assigned arm instead of `legacy`.

For the prompt-injected surfaces (findings, recall, brief) the three rows are written in one transaction at the moment the content is returned to the prompt builder. For the dream digest, `eligible` and `assigned` are written before `notifyOwner` and `delivered` after it returns, so a failed send leaves an assigned opportunity without a delivery, which is the truth. The Phase 0 idempotency key is kept: a repeat of the same item in the same hour bucket is ignored as a whole, never half-logged.

### Block design

Block id = `floor(now / blockMinutes)` (default 240 minutes). The arm for (kind, block) is read from the first four bytes of `HMAC-SHA256(seed, "<kind>\n<blockId>")`: `surface` below 2^31, `withhold` otherwise. The draw is balanced in expectation and stratified by surface kind, and consecutive blocks are independent draws rather than an alternation (a test checks 2,000 consecutive blocks for 45 to 55 percent `withhold` and about half equal neighbours). The seed is `surfacingTrial.seed` when configured; otherwise it is `HMAC-SHA256(digest_key, "plan59:surfacing-trial:seed")`, derived once from the node's own `evidence_meta` key, so assignment is deterministic per node and cannot be reconstructed from the logged rows. Neither the key nor the derived seed is stored in any row.

### Carry-over

Before drawing, the trial looks for the most recent `assigned` row with the same `kind` and `ref_id` inside `carryOverDays` (default 7). If one exists its arm is reused and the new `assigned` row has `carryOver: true` in `details_json`; a repeated appearance of an item is therefore consistent within the window, and a fresh draw happens only after it. Carry-over is per kind: the same chunk surfaced by proactive recall and cited in a dream brief are two items.

### Exemptions

Content the owner explicitly asked for is not an opportunity and is never logged as eligible: the answer to a `curiosity.ask` question, anything returned by an explicit memory search, recall of the owner's own stated facts in reply to a direct question. Essential warnings (task failures, stall sweeps, monitor alerts, security notices) are likewise not opportunities. The rule follows PLAN-59 section 4.2 and decision 2: only optional, autonomously learned content (findings, briefs, digests, unprompted recall) can ever be withheld, so only that content is assigned. The four hooked surfaces are exactly those.

### Shadow crossover marker

When a search with caller `memory_search` (the owner's explicit `memory_search` tool) returns a chunk that a `withhold`-assigned opportunity surfaced within the carry-over window, the opportunity's `delivered` row (falling back to its `assigned` row) is labelled outcome `explicit_retrieval`, provenance `shadow_crossover`. Proactive-recall opportunities match on `ref_id` (the chunk id); curiosity findings match through `curiosity_findings.chunk_id` to the target the finding answered. The marker never overwrites an outcome the owner gave (`dismissed`, `answered`), never creates a `responded` row, and fires once per opportunity. Other callers (`deep_recall`, `rlm_context`, the CLI) are not explicit owner retrieval and set nothing.

In shadow nothing was withheld, so this does not measure crossover from a withheld condition. It measures the baseline rate at which items the trial would have withheld are retrieved by the owner anyway, which the live design needs in order to size its crossover expectation.

### Status

`curiosity.status` returns, inside `evidence`:

```json5
surfacingTrial: {
  mode: "shadow", // "off" | "shadow"
  active: true, // false when the evidence layer is off or the tables are missing
  blockMinutes: 240,
  carryOverDays: 7,
  blocks: 12, // distinct randomisation blocks with at least one assignment
  byKind: {
    proactive_recall: { eligible, assigned, surface, withhold, delivered, carryOver, crossover },
    // curiosity_finding, dream_brief, dream_digest likewise
  },
  balance: 0.48, // share of assignments that drew withhold; null before the first
}
```

`delivered` here counts rows under a trial arm only; Phase 0 `legacy` rows are not part of the trial. `bitterbot curiosity status --json` prints the same object.

### What shadow does not measure

Shadow measures the instrument, not the effect: that eligibility fires at the right places, that assignment is balanced and consistent, how many opportunities each surface produces per block, and the baseline explicit-retrieval rate. It says nothing about whether surfacing is useful, because both arms deliver. No arm is ever read by a surface in this stage; the arm label is written and never consulted.

### Switches

`memory.curiosity.evidence.mode: "off"` wins: with the evidence layer off the trial writes nothing regardless of its own mode. `surfacingTrial.mode: "off"` with the evidence layer on restores the Phase 0 rows exactly (`delivered`, arm `legacy`). The mode enum is `off | shadow`; `live` is not accepted and falls back to `shadow` with a warning. The live withhold condition, the only part of Phase 2 that changes what the owner sees, is a separate decision and a separate PR; it will add `live` and make a surface read the arm.

## Readers of the GCCRF score on main

The shadow traces exist to measure the score where it changes a decision. These are the places on main that read `curiosity_reward` or a GCCRF component today:

| reader                                          | where                                                                                                             | effect                                                                                                                                                | traced                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| dream mode selection                            | `DreamEngine.selectModes` via `computeGCCRFModeAdjustments`                                                       | weight 0.25 to 0.3 on the per-mode adjustment derived from the recent `curiosity_reward` distribution                                                 | yes (`dream_mode_select`)            |
| dream seed ranking                              | `DreamEngine.selectSeeds`                                                                                         | `importance_score + COALESCE(curiosity_reward, curiosity_boost, 0)` in the `ORDER BY`                                                                 | yes (`dream_seed_rank`)              |
| dream curiosity-reward stats                    | `dream.curiosityReward` RPC (`src/gateway/server-methods/dream.ts`)                                               | read-only aggregate for the UI; no decision                                                                                                           | no (read only)                       |
| importance boost on assessment                  | `CuriosityEngine.assessChunk` (`boostThreshold` 0.4, `boostMultiplier` 1.3)                                       | multiplies a new chunk's importance when its reward clears the threshold                                                                              | no (Phase 1 candidate)               |
| hormonal events from the score                  | `HormonalStateManager.stimulateFromGCCRF` (`src/memory/hormonal.ts`)                                              | `curiosity_progress` dopamine +0.2, `curiosity_aligned` dopamine +0.1, `curiosity_stagnant` cortisol +0.15 after a sustained run of sub-floor rewards | no (hormone log exists)              |
| hormonal retrieval and consolidation modulators | `getRetrievalModulation`, `getConsolidationModulation` read in `MemoryIndexManager.searchInner` and `consolidate` | hormones (which the score moves) scale the recency bias, importance boost, merge threshold and decay resistance                                       | indirectly, through `retrieval_hits` |
| research target ranking                         | `curiosity-researcher.ts` (priority + 0.25 x region ROI)                                                          | the ROI is use-based, not score-based                                                                                                                 | no (not a score reader)              |

## Engineering gate

`benchmarks/live-recall/evidence-gate.mts` runs the layer against a `VACUUM INTO` copy of a real store (never the live file; any `--db` path under `~/.bitterbot` is refused), with the journal replay queries from `extract-journal-queries.mts`, recency boost off so repeated searches are deterministic. It fails hard if the ordered chunk-id list differs between `off` and `observe` for any query.

Results, 2026-10-28, one node's store, 68 real queries, 3 repetitions, interleaved:

| check                                          | result                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| store                                          | 368 MB `VACUUM INTO` copy (47 s), 3955 chunks                                                  |
| migration v78 to v79                           | 362 ms                                                                                         |
| queries                                        | 68 real `memory_search` queries x 3 reps, maxResults 10, topK 10                               |
| search mean, off / observe                     | 1234 ms / 1310 ms                                                                              |
| search p50, off / observe                      | 1202 ms / 1224 ms (delta 22 ms)                                                                |
| search p95, off / observe                      | 2342 ms / 2694 ms (delta 352 ms over 10 samples)                                               |
| neutrality: ordered chunk ids identical        | PASS, 204 of 204 comparisons (within-mode drift across reps: off 1, observe 1, the same query) |
| rows after the off pass                        | 0 (PASS)                                                                                       |
| rows == min(topK, returned) per observe search | PASS, 2720 rows over 272 searches                                                              |
| query text anywhere in the rows                | none (PASS)                                                                                    |
| prune at 90 days                               | removed 1360 of 1360 backdated rows, kept 1360, 144 ms (PASS)                                  |
| stats() == COUNT(*)                            | PASS                                                                                           |

Reading: the migration is one DDL transaction well under a second on a real store. The observe-mode write adds about 22 ms at the median to a 1.2 s search (one WAL commit of 10 rows on this disk); the p95 delta rests on 10 samples and is noise-dominated. The two modes return identical ordered lists on every query and repetition. The one within-mode drift (the same query, the same repetition, in both modes) is a property of search on main, not of the telemetry: the graph channel reads the wall clock and access counters that every search advances, which is also why the gate freezes `Date.now` and runs with the recency boost and hormonal modulation off.

## Deliberately not built (Phase 1 and later)

No consumer of these tables that changes behaviour; no change to retrieval, dream seeds, dream modes, hormones or target closure; no `injected` or `cited` signals; no arm that any surface reads (the Phase 2 shadow stage writes arms and consults none); no inferred usefulness labels beyond the shadow crossover marker; no UI. Phase 0 and the Phase 2 shadow stage are the instrument, not the experiment.
