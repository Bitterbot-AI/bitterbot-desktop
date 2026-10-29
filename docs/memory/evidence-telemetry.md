# Evidence Telemetry

An observational layer under the curiosity and dream system. It records what retrieval surfaced, what the agent proactively surfaced to the owner and what came of it, and (in shadow mode) what a "GCCRF as diagnostic only" routing would have decided in the dream engine next to what the legacy routing actually decided. It changes no behaviour in any mode: retrieval order, dream seeds, dream mode choice, hormone events and target closure are exactly what they were before it existed. Later phases read these tables; this phase only writes them.

Code: `src/memory/evidence-telemetry.ts` (writer), migration v79 in `src/memory/migrations.ts`, call sites in `src/memory/manager.ts` and `src/memory/dream-engine.ts`.

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

| column             | meaning                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `event_id`         | idempotency key (`INSERT OR IGNORE`), for example `cf:<finding id>:<hour bucket>`                         |
| `kind`             | `curiosity_finding`, `proactive_recall`, `dream_brief`, `dream_digest`, `curiosity_target`                |
| `ref_id`           | the surfaced item (finding id, chunk id, brief id, notification key)                                      |
| `arm`              | `legacy` in Phase 0; later phases add arms                                                                |
| `opportunity_id`   | the curiosity target a finding answered, so a dismiss by target id finds the delivery                     |
| `session_digest`   | digest of the conversation the item was surfaced in, when known                                           |
| `stage`            | `eligible`, `assigned`, `delivered`, `visible`, `responded`                                               |
| `outcome`          | `useful`, `corrected`, `dismissed`, `answered`, `engaged_weak`, `unknown`; NULL until something labels it |
| `label_provenance` | `explicit` (the owner acted), `inferred`, `unknown`                                                       |
| `cost_usd`         | cost attributed to producing the item, when known                                                         |
| `created_at`       | when the stage was reached                                                                                |
| `outcome_at`       | when the outcome was labelled                                                                             |

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

`curiosity.status` (RPC and `bitterbot curiosity status`) returns `evidence: { mode, available, retrievalHits, surfacingEvents, decisionTraces, oldestAt }`.

## Surfaces hooked on main

| surface                                                   | where                                                                  | kind                            | stage                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| curiosity findings voiced in the system prompt            | `MemoryIndexManager.consumeResearchFindings` (research-findings block) | `curiosity_finding`             | `delivered`                                |
| `curiosity.dismiss` RPC                                   | `MemoryIndexManager.curiosityDismiss`                                  | labels the finding by target id | outcome `dismissed`, provenance `explicit` |
| proactive recall facts injected into the prompt (PLAN-27) | `MemoryIndexManager.recallForUserTurn`                                 | `proactive_recall`              | `delivered`                                |
| anticipation brief offered in the prompt                  | `MemoryIndexManager.consumeDreamBrief`                                 | `dream_brief`                   | `delivered`                                |
| daily dream digest sent to the owner (PLAN-53 G4)         | `MemoryIndexManager.sendDreamBrief`                                    | `dream_digest`                  | `delivered`                                |

Found and not hooked in Phase 0: the Curiosity page's list of findings (`curiosity.list`, a read, no delivery event), the skill-pipeline digest, auto-initiated owner messages (`auto-initiate-decider`), and `message_owner` tool sends. None of these carry a curiosity or dream artifact id that a later outcome could be joined to; they wait for Phase 1.

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

No consumer of these tables; no change to retrieval, dream seeds, dream modes, hormones or target closure; no `injected` or `cited` signals; no alternative arms; no inferred usefulness labels; no UI. Phase 0 is the instrument, not the experiment.
