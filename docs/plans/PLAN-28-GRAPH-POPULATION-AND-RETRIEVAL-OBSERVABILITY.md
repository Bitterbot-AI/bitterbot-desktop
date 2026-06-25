# PLAN-28: Graph Population + Retrieval Observability

Two complementary moves to take the memory system from "architecturally SOTA" to
"operationally SOTA": **fill the relationship graph** so the flagship graph/
bitemporal layers actually contribute to retrieval, and **instrument retrieval**
so a silently dead layer can never hide again.

**Status:** LANDED (2026-06-25) — Parts A (A1/A2/A3) + B (B1–B4) implemented, wired on by default, tested.
**Builds on:** PLAN-18 (SAGE graph reader), PLAN-23 (SABM beliefs), PLAN-27 (graph-anchored recall)
**Migration:** additive — v21 `retrieval_trace` table; reuses `entities`/`relationships`
**Default:** population on by default behind `BITTERBOT_KG_RELATIONSHIPS` (=0 disables); span attrs + dead-wire detector always on; persisted trace behind `BITTERBOT_RETRIEVAL_TRACE_RATE` (default 0.05, =0 disables)

## Implementation map (as landed)

| Piece                                                                                             | File(s)                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A1 typed extractor (`extractTypedRelationshipFromFact`, `typeEntityName`, `extractTypedEntities`) | `src/memory/kg-relationship-extract.ts`                                                                                        |
| A1 hot-path wiring (all fact-like layers)                                                         | `src/memory/manager.ts` KG-population loop                                                                                     |
| A2 offline mining dream mode (`relationship_mining`)                                              | `src/memory/dream-modes/relationship-mining.ts`, `dream-engine.ts`, `dream-types.ts`                                           |
| A3 one-time backfill (`backfillTypedRelationships`)                                               | `src/memory/kg-backfill.ts`, `manager.ts` (`backfillGeneralRelationships`)                                                     |
| B1 span attributes (`withSpanAttrs`)                                                              | `src/observability/otel.ts`, `manager.ts` (`search`/`searchInner`/`recallForUserTurn`), `proactive-recall.ts`                  |
| B2 sampled trace + B3 dead-wire detector                                                          | `src/memory/retrieval-trace.ts`, migration v21                                                                                 |
| B3 maintenance hook + B4 `retrievalHealth()` surface                                              | `src/memory/manager.ts`                                                                                                        |
| Tests                                                                                             | `kg-relationship-extract.test.ts`, `kg-backfill.test.ts`, `retrieval-trace.test.ts`, `dream-modes/relationship-mining.test.ts` |

---

## 1. Why (measured, not inferred)

Live DB snapshot (2026-06-23):

| Signal                                     | Value            | Implication                                 |
| ------------------------------------------ | ---------------- | ------------------------------------------- |
| `relationships` rows                       | **0**            | SAGE graph-reader channel traverses nothing |
| chunks with `semantic_type='relationship'` | **26 / 11,191**  | the only facts the extractor mines          |
| `fact` + `preference` + `insight` chunks   | **5,807**        | relational content that never becomes edges |
| `graph_gate_training_pairs`                | **5** (need ≥50) | the SAGE CMA-ES optimizer can never run     |
| `relationship_belief_history`              | **0**            | SABM has no beliefs to adjudicate           |

So **PLAN-18 (SAGE) and PLAN-23 (SABM) are complete but dormant** — their substrate
is empty. The cause is narrow gating: relationship extraction only runs on the 26
`relationship`-typed facts (`manager.ts` KG-population loop), while thousands of
`fact`/`insight` chunks carrying "X works on Y", "A manages B", "server located at
Z" are never mined. PLAN-27 lit up _family_ edges; this generalizes that.

Separately, this session surfaced **three** "wired but dead" defects (proactive
recall's null embedding, the uncalled `stimulateFromLiveMessage`, the empty
relationship layer). Each was invisible until manually probed. With this many
composed layers, the absence of **per-layer retrieval telemetry** is itself a SOTA
gap: a no-op layer is indistinguishable from a working one.

---

## Part A — General relationship population

Goal: relationships go from 0 to thousands; `graph_gate_training_pairs` clears 50
so the SAGE optimizer runs; SABM starts recording belief revisions.

### A1. Broaden the deterministic hot-path extractor

`kg-relationship-extract.ts` + the `manager.ts` population loop today: persons
only, `relationship`-typed facts only, leading-pair only.

- Mine **all fact-like layers** (`fact`, `insight`, `preference`, `world_fact`),
  not just `semantic_type='relationship'`.
- Broaden entity typing beyond persons: a dictionary/heuristic typer for
  `project` / `tool` / `organization` / `service` / `location` (extend the
  existing tool-name regex), reusing the query-planner's capitalized-noun-run
  heuristic so it stays no-LLM.
- Keep it **conservative** (PLAN-27's lesson): only emit a typed edge when a
  relation verb (`relationTypeForText`) AND two typed entities are present; never
  the `related_to` fan-out on the hot path. A wrong edge is worse than no edge.

### A2. Offline LLM-assisted relationship mining (the recall engine)

Deterministic extraction is high-precision but low-recall. Add a dream mode
(`relationship_mining`) that, during calm cycles, batches unprocessed fact chunks
through a cheap LLM (Haiku, strict JSON, like the SAGE query planner) to extract
typed triples, then ingests them via `KnowledgeGraphManager.ingestExtraction`.

- Hormonally gated like graph optimization (`cortisol > 0.7` skips — don't
  restructure memory under stress; mirrors `graph-optimization-hook.ts`).
- Cursor/marker over processed chunks so each cycle drains the backlog
  incrementally and idempotently.
- Every mined triple that an agent later cites becomes a SAGE training pair —
  this is what finally feeds the optimizer past its floor.

This mirrors SAGE's writer-reader loop and SABM's "decide during rest" — the
write path stays deterministic; the LLM works offline.

### A3. One-time backfill

A bounded pass (like PLAN-27's `backfillIdentityRelationships`) over existing
fact/insight chunks through the A1 extractor, so history populates immediately
rather than waiting for A2 to drain it.

### Acceptance

- `relationships` > 0 and climbing (target: low thousands on this corpus).
- `graph_gate_training_pairs` ≥ 50 within a few dream cycles → optimizer fires.
- SABM `getStats()` shows non-zero `flaggedContradictions` / `beliefRevisions`.
- A retrieval trace (Part B) shows the graph channel contributing to fused results.

---

## Part B — Retrieval observability

Goal: every retrieval reveals which layers fired and what each contributed, and a
dead layer raises an alarm.

### B1. Per-layer span attributes (reuse existing infra)

`manager.search` already runs inside `withSpan("memory.search", …)`
(`src/observability/otel.ts:191`). Attach per-layer counts as span attributes:
`vector_hits`, `keyword_hits`, `graph_hits`, `fused`, `mood_boost_applied`,
`temporal_intent`. Do the same for proactive recall: `graph_facts`,
`identity_facts`, `vector_facts`, `open_loops`. Near-zero overhead; immediately
visible in any OTel backend.

### B2. Sampled persisted retrieval trace

A `retrieval_trace` table (modeled on `dream_telemetry` + `recordDreamTelemetry`)
records, for a sampled fraction of retrievals, the per-layer contribution counts +
final-result provenance. Enables offline "is each layer pulling its weight"
analysis and before/after ablations (the LongMemEval harness can read it).

### B3. Dead-wire detector (the insurance)

A rolling per-layer contribution counter; if a layer contributes **0 across N
consecutive retrievals** while the system is otherwise active, emit a `warn`
("graph channel contributed 0 over last 200 searches — populated?"). This single
check would have caught all three defects from this session. Runs in the existing
maintenance cycle; cheap counters, no hot-path cost.

### B4. Surface the counters

Fold graph/SABM `getStats()` + the rolling layer counters into the management/
telemetry surface so health is visible without a DB probe (the way I had to query
it by hand for this analysis).

---

## 2. Integration points

| Concern                  | File                                                                         | Hook                                     |
| ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| Hot-path extraction (A1) | `kg-relationship-extract.ts`, `manager.ts` KG-population loop (~2960)        | broaden layers + entity typing           |
| Offline mining (A2)      | new `dream-modes/relationship-mining.ts`, `dream-engine.ts` mode registry    | batched LLM triples → `ingestExtraction` |
| Backfill (A3)            | `manager.ts` (sibling of `backfillIdentityRelationships`)                    | one-time scan                            |
| Span attrs (B1)          | `manager.ts` `searchInner` / `computeGraphChannel`; `proactive-recall*.ts`   | `withSpan` attributes                    |
| Trace table (B2)         | `migrations.ts` (new `retrieval_trace`), writer modeled on `dream-schema.ts` | sampled insert                           |
| Dead-wire detector (B3)  | `manager.ts` maintenance cycle                                               | rolling counters + warn                  |
| Counters surface (B4)    | management telemetry + KG `getStats()`                                       | expose                                   |

---

## 3. Why it respects the deployment

- **No LLM on the hot path.** A1 is deterministic; A2's LLM work is offline,
  batched, and hormonally gated inside existing dream cycles.
- **Additive + flag-gated.** Population behind `BITTERBOT_KG_RELATIONSHIPS`;
  observability behind a sampling rate (0 = off). Existing behavior unchanged when
  disabled.
- **One small migration.** A single `retrieval_trace` table with safe defaults.
- **Reuses infra.** `withSpan`, `recordDreamTelemetry`, `ingestExtraction`,
  `getStats`, the dream-mode registry, and the graph-optimization gating pattern.

---

## 4. Tests

- Extraction: typed triples from `fact`/`insight` text across entity types;
  conservative (no edge without a typed verb + two typed entities); no `related_to`
  fan-out on the hot path.
- Backfill: bounded, idempotent, produces edges from seeded fact chunks.
- Mining dream mode: cortisol-skip gate; cursor advances; malformed-LLM-JSON
  tolerated; training pairs created.
- Observability: span attributes populated; sampled trace rows written; **dead-wire
  detector fires** when a layer is forced to contribute 0 over the window (the
  regression that pins the meta-gap).

---

## 5. Risks & sequencing

- **Precision under generalization.** Broad extraction risks junk edges that
  pollute graph retrieval. Mitigate: conservative hot path (A1), LLM precision +
  SABM adjudication offline (A2), and the trace (B) to measure edge quality before
  widening.
- **Entity explosion / dedup.** More extraction → more entities → canonicalization
  matters (the "Victor"/"the user"/"Bitter" problem). Track entity growth in B;
  entity-merge is a fast follow, not in scope here.
- **Sequence:** B first (cheap, and you want the instrument _before_ you change the
  thing it measures), then A3 backfill (immediate population), then A1 (go-forward),
  then A2 (the high-recall engine). Measure graph-channel contribution rising in the
  trace at each step.

---

## See also

- `docs/memory/sage-graph-memory.md` — the reader this finally feeds.
- `docs/memory/sabm-belief-adjudication.md` — the adjudication that wakes up once edges exist.
- `docs/plans/PLAN-27-GRAPH-ANCHORED-PROACTIVE-RECALL.md` — the family-edge sliver this generalizes.
