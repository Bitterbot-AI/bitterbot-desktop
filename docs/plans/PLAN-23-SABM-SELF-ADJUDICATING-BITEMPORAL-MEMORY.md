# PLAN-23: SABM, Self-Adjudicating Bitemporal Memory

**Goal:** Turn Bitterbot's append-only relationship store into a queryable, auditable belief history by grafting MemGraphRAG's typed mutual/temporal/granularity conflict taxonomy (arXiv:2606.00610, KDD'26) onto the existing bitemporal knowledge graph as a deterministic programmatic classifier, resolving contradictions non-destructively at write-time and re-adjudicating them during dreams as a biological reconsolidation event. Adjudication aggressiveness is hormonally gated and destructive resolution is reconsolidation-timed, so "when and how aggressively the agent revises its beliefs" becomes a function of affective state, a moat no surveyed system has.
**Date:** 2026-06-03
**Status:** Draft. Awaiting review.

---

## Summary

MemGraphRAG's headline contribution is a three-type conflict taxonomy (mutual / temporal / granularity) with per-type non-destructive actions (discard-incorrect / add-time-scope / keep-both-via-containment), plus evidence-grounded resolution that adjudicates against source passages rather than recency. Its own stated limitations are that this taxonomy is prompt-only and unverifiable, that it runs once over a static corpus, and that it has no bitemporal model to write the "add time scope" branch into. Bitterbot already has the missing pieces: a bitemporal relationship model with `validFrom`/`validUntil`, evidence provenance via `evidenceChunkIds`, an embedding conflict resolver, a labile-window reconsolidation engine, and a hormonally-modulated dream engine. SABM composes them into one continuous self-adjudication loop that exceeds both MemGraphRAG (no bitemporality, prompt-only taxonomy, one-shot) and Zep/Graphiti (bitemporality + edge invalidation but recency/LLM resolution, no typed taxonomy, no biological consolidation).

### What already exists vs what is new

| Capability                       | Already exists                                                                  | File                                                                    | What SABM adds                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Bitemporal validity (valid time) | `validFrom`/`validUntil` open-closed interval, evidence merge on conflict       | `knowledge-graph.ts:81-92,216-296`                                      | A second transaction-time axis on relationships (mirrors chunks) + `superseded_by` provenance       |
| Chunk-level conflict resolution  | tiered cosine 0.85/0.95 ADD/UPDATE/NOOP, no LLM                                 | `conflict-resolver.ts:8-30,40`                                          | Reuse as the chunk-level pre-filter feeding candidate relationships into the graph adjudicator      |
| Reconsolidation labile windows   | `flag_contradiction` action, 30-min labile window, `isLabile`/`getLabileChunks` | `reconsolidation.ts:42,60-78`                                           | `flag_contradiction` becomes the re-adjudication trigger; destructive close only post-labile-window |
| Knowledge-gap detection          | per-perspective novelty, severity classes                                       | `divergence-detector.ts:17-78`                                          | Untouched; it detects gaps, not contradictions, and stays orthogonal                                |
| Graph reader (L-hop)             | normalized activation spread, optional gateFn, hormonal delta                   | `graph-reader.ts:288-462`, `sage-memory.ts`                             | Contradiction edges become first-class retrievable so the reader surfaces belief history            |
| Edge topology features           | 8-feature vector, lazy compute                                                  | `graph-topology.ts`                                                     | Reused unchanged for candidate scoring                                                              |
| Hormonal delta modulation        | `effectiveDelta(base,h) = base - 0.4·cortisol + 0.4·dopamine`                   | `structural-gate.ts:212-218`                                            | Same shape reused to gate adjudication aggressiveness (`effectiveLlmThreshold`)                     |
| Dream modes                      | 8 modes (replay…interceptor_harvest), FSHO weighting, cortisol>0.7 gate         | `dream-types.ts:12-20`, `dream-engine.ts`, `graph-optimization-hook.ts` | New 9th `reconsolidation` mode that drains the re-adjudication queue                                |

**New:** a typed deterministic `belief-adjudicator` (mutual/temporal/granularity via a cardinality table, LLM only on ambiguous mutual conflicts), a `belief-history` read API (`beliefAsOf`, `beliefHistory`), and one additive migration (v16) adding the second temporal axis to `relationships`.

---

## SOTA positioning

### Where Bitterbot already leads (keep, do not rebuild)

- **Affective modulation of memory** (cortisol/dopamine/oxytocin biasing the structural gate, `structural-gate.ts:212`) is unique. The 2026 graph-memory survey (arXiv:2602.05665) explicitly flags hormonal/affective modulation as not substantively addressed in the field.
- **Offline self-optimization during rest** via the dream engine, the survey's consolidation-during-sleep ideal.
- **Genuine bitemporal validity already present** (`knowledge-graph.ts`, `temporal-filter.ts:39`), so Bitterbot matches the Zep/supermemory table-stakes temporal axis and only needs the second (transaction-time) axis on relationships to fully close the Graphiti gap.

### The specific moves that push above SOTA

1. **Typed deterministic taxonomy over a bitemporal graph.** MemGraphRAG's taxonomy lives only in GPT-4o-mini prompts (their stated limitation: unverifiable). SABM ships a programmatic classifier where temporal and granularity conflicts resolve with **no LLM**, restricting the small/local desktop model to ambiguous one-to-one mutual conflicts. This directly counters arXiv:2602.19320's silent-corruption-on-weak-backbones finding.
2. **The taxonomy's most valuable branch becomes executable.** MemGraphRAG's "temporal conflict, add time" has nowhere to write the time. Bitterbot has `validFrom`/`validUntil`, so the branch is real here.
3. **Continuous re-adjudication, not one-shot.** MemGraphRAG adjudicates once at offline index time. SABM defers the expensive corpus-wide re-adjudication to a recurring dream mode, making it continuous while keeping the write path cheap.
4. **Affect-aware, reconsolidation-timed belief revision.** Destructive resolution happens only after a memory's backing chunk exits its labile window, and only when calm (cortisol gate). No surveyed system (Zep, Mem0, supermemory, HippoRAG2, MemGraphRAG, LightRAG) ties belief revision to affective state.
5. **Auditable, rollback-able belief history.** A discarded belief is never deleted (`valid_until` + `superseded_by` + a `contradicts`/`refutes` edge), so "what did I believe about X as of last Tuesday's ingestion" is a first-class bitemporal query.

The publishable primitive: **typed conflict resolution executed continuously over a bitemporal graph with hormonally-gated, reconsolidation-timed destructiveness.**

---

## Diagnosis: where the current writer loses belief fidelity

1. **`upsertRelationship` is blind to same-(source,type)/different-target.** On a conflicting active relationship of the same `(sourceId,targetId,type)` it merges evidence and averages weight (`knowledge-graph.ts:236,249-251`). It never asks whether `A manages X` and `B manages X` are mutually exclusive. The logical-contradiction case the conflict resolver was built for never reaches the graph.
2. **`supersedeRelationship` exists but is never wired in** (`knowledge-graph.ts:296`). The bitemporal invalidation primitive is dead code.
3. **`contradicts` (enum value at `knowledge-graph.ts:65`) and `refutes` (line 79) are never emitted.** Contradictions are not first-class retrievable; the belief history cannot be reconstructed.
4. **The relationship layer is never populated by the heuristic extractor.** `manager.ts:2499` initializes `kgRelationships` as an empty array and passes it to `ingestExtraction` at line 2527 without ever filling it. The adjudicator is moot until candidate triples actually flow.
5. **Relationships have only one temporal axis.** Chunks gained `transaction_time` in v14 (`migrations.ts:271-286`); relationships did not, so as-of-ingestion rollback is impossible for beliefs.

---

## Recommended first increment (the spine)

Ship this as the first PR. It is the smallest slice that delivers standalone
value, de-risks everything downstream, and produces the data a baseline
ablation needs. It is **Phases 0 through 2**, scoped to four concrete
deliverables:

1. **Populate the relationship layer** (Phase 0). Route co-occurring extracted
   entities into actual relationship writes at `manager.ts:2499/2527`. Today the
   layer is empty, so this is pure upside even if nothing else lands.
2. **Add the transaction-time axis** (Phase 1, migration v16). Give
   relationships `transaction_time` + `superseded_by` and the
   relationship-aware `temporal-filter.ts` branch. Additive, idempotent, no
   interval rewrite.
3. **Ship the deterministic typed taxonomy** (Phase 2). The
   mutual/temporal/granularity classifier (`belief-adjudicator.ts`) with no LLM
   on the write path - temporal and granularity resolve deterministically; the
   ambiguous-mutual LLM branch is deferred to the Phase 5 dream mode.
4. **Ship the queryable belief-history API** (Phase 2). `beliefAsOf(entity, ts)`
   and `beliefHistory(entity)` over the bitemporal interval chain, plus the
   `getStats` telemetry counters (conflicts-by-type, close-vs-scope ratio) the
   ablation needs to be interpretable.

Everything beyond the spine (write-time wiring, the reconsolidation dream mode,
hormonal gating, bridging, ontology layer) is deferred until the spine ships
data and a LongMemEval SABM-on/off baseline exists. Do not build the moat
phases against an empty relationship layer.

## The Plan: Phases 0 through 6

Each phase ships behind a flag and is additive. Migrations are non-destructive (no rewrite of existing valid intervals).

### Phase 0 - Populate the relationship layer (prerequisite, ships standalone)

**Goal:** Route candidate `(sourceType, relationType, targetType)` triples from the heuristic extractor into actual relationship writes, since today the entire relationship layer is never populated (`manager.ts:2499`). High-value on its own even if nothing else lands.

**What to build:** Fill `kgRelationships` before the `ingestExtraction` call at `manager.ts:2527` by pairing co-occurring extracted entities with a heuristic `relationType` (default `related_to`, refined by entity-type pairs, e.g. person+project → `works_on`). Conservative: emit only high-confidence pairs; everything else defaults to `related_to` at low weight.

**Files:** edits to `manager.ts` (~40 LOC). No new module, no migration.
**Test:** `manager.kg-relationships.test.ts` asserting that a fixture turn with two co-occurring entities yields a written relationship.
**Flag:** `memory.kgRelationships.populate` (default `true`).

---

### Phase 1 - Schema: second temporal axis on relationships (migration v16)

**Goal:** Give relationships the transaction-time axis and invalidation provenance that only chunks have.

**Migration v16** (`src/memory/migrations.ts`, next sequential version after v15 at line 652; mirror the chunks `transaction_time` block at lines 271-286):

```sql
-- v16: SABM. Relationships gain the second temporal axis + invalidation provenance.
ensureColumn(db, "relationships", "transaction_time", "INTEGER");
UPDATE relationships SET transaction_time = COALESCE(created_at, updated_at)
  WHERE transaction_time IS NULL;                 -- idempotent backfill, no interval rewrite
ensureColumn(db, "relationships", "superseded_by", "TEXT");   -- winning rel id, invalidation provenance
CREATE INDEX IF NOT EXISTS idx_rel_txtime    ON relationships(transaction_time);
CREATE INDEX IF NOT EXISTS idx_rel_superseded ON relationships(superseded_by);
```

The backfill is a one-time `UPDATE ... WHERE NULL`, idempotent and non-destructive, exactly like the chunks backfill. No index rebuild on the hot write path.

**Generalize `temporal-filter.ts`:** `buildTemporalWhereClause(filter, alias)` already takes an alias and has an `asOf` transaction-time branch (`temporal-filter.ts:39,65-67`), but the column set assumes the chunk shape. Add a relationship-aware variant so `valid_from`/`valid_until`/`transaction_time` filter on a relationship alias.

**Files:** `migrations.ts` (v16), `temporal-filter.ts` (relationship branch). Test: `migrations.v16.test.ts` (backfill correctness, idempotent re-run) and `temporal-filter.rel.test.ts`.
**Flag:** none (schema is unconditional and additive); behavior gated downstream.

---

### Phase 2 - Typed belief adjudicator (deterministic, no LLM on the hot path)

**Goal:** A typed mutual/temporal/granularity classifier with per-type non-destructive actions, fixing MemGraphRAG's prompt-only taxonomy.

**New modules:**

- **`src/memory/belief-adjudicator-types.ts`** (~120 LOC): `ConflictType = "mutual" | "temporal" | "granularity" | "none"`; `ConflictAction = "close" | "scope" | "refine" | "keep-both" | "noop"`; `CardinalityRule` per `RelationType` (`"one-to-one" | "one-to-many" | "many-to-many"`); `AdjudicationResult { type, action, target, confidence }`; `AdjudicationConfig { enabled, llmThreshold, dreamReadjudicate }`. Follows the `*-types.ts` convention.
- **`src/memory/belief-adjudicator.ts`** (~300 LOC): `classifyConflict(newRel, candidateRels, kg)`.
  - **Cheap path (no LLM):** a hand-authored cardinality table over `RelationType` decides type. One-to-one predicates (e.g. `manages`) with same source and different target → **mutual**. Entity-type containment check (`located_at` city vs country, `part_of`) → **granularity** → `keep-both`. A role/state predicate with overlapping valid intervals → **temporal** → `scope`.
  - **LLM resolver** fires only on ambiguous one-to-one **mutual** conflicts, mirroring MemGraphRAG's sparse conflict-triggered `A_res`. On low-confidence LLM output the action falls back to the non-destructive `scope`, never `close`.
- **`src/memory/belief-history.ts`** (~150 LOC): read-side bitemporal API. `beliefAsOf(entityId, relationType, validAt, asOfTxTime)` and `beliefHistory(entityId, relationType)` returning the ordered interval chain. This is the queryable surface that exceeds Zep's edge invalidation by exposing transaction-time rollback explicitly.

**Detection:** reuse `conflict-resolver.ts` tiered cosine (`UPDATE_THRESHOLD=0.85`, `NOOP_THRESHOLD=0.95`, `MAX_CANDIDATES=5`, lines 28-30) as the chunk-level pre-filter, plus structural head/tail match. Candidate set is bounded by the existing same-`(source,target,type)` lookup (`knowledge-graph.ts:224-231`) plus a top-k cosine neighbor set capped at `MAX_CANDIDATES`. Never an O(N) scan.

**Files:** new `belief-adjudicator-types.ts`, `belief-adjudicator.ts`, `belief-history.ts`. Tests: `belief-adjudicator.test.ts` (each taxonomy type resolves to the correct action with no LLM for temporal/granularity), `belief-history.test.ts` (as-of query returns the correct interval).
**Flag:** `memory.sabm.enabled` (default `false` until benched).

---

### Phase 3 - Wire the adjudicator into the writer (non-destructive at write-time)

**Goal:** Replace the blind same-type evidence-merge in `upsertRelationship` (`knowledge-graph.ts:216-290`) with a call into `belief-adjudicator` **before** merging. Enforce the safety invariant: **write-time never deletes.**

- On **mutual**: provisionally `scope` (set `valid_from`/`valid_until`) and enqueue the loser for dream re-adjudication. Do **not** close yet; destructive close happens only post-labile-window in Phase 5.
- On **temporal**: call the existing `supersedeRelationship` (`knowledge-graph.ts:296`), set valid-interval scopes, and write a `(loser, contradicts, winner)` edge using the **existing** `contradicts`/`refutes` enum values (lines 65, 79) so contradictions are first-class retrievable.
- On **granularity**: keep both (containment).
- Set `superseded_by` on the loser for provenance.

Exclude `contradicts`/`refutes` from the adjudicator input set (same way `structural-gate.ts:60` excludes non-social relations from the oxytocin boost) so contradiction edges cannot trigger adjudication recursion.

**Files:** edits to `knowledge-graph.ts` (`upsertRelationship`, wire `supersedeRelationship`). Test: `knowledge-graph.adjudication.test.ts` (mutual scopes-not-deletes; temporal writes a contradicts edge; granularity keeps both; no recursion on contradicts edges). Add `knowledge-graph.write.bench.test.ts` asserting write p50 stays within budget with adjudication on.
**Flag:** `memory.sabm.writeAdjudication` (default `false`).

---

### Phase 4 - Continuous-write cost discipline (the make-or-break vs MemGraphRAG)

MemGraphRAG adjudicates **once** over a **static corpus**. Bitterbot memory is written **constantly**, so an O(N) scan per write is fatal. This phase is a constraint, not new code, but it governs Phases 3 and 5.

**Online write path budget (per relationship write):**

- One cardinality-table lookup (O(1)).
- One bounded candidate fetch: the existing same-`(source,target,type)` lookup (`knowledge-graph.ts:224-231`) plus a top-k cosine neighbor set capped at `MAX_CANDIDATES=5`. Never the full graph.
- The LLM resolver is sparse: fires only on ambiguous one-to-one mutual conflicts, amortized like MemGraphRAG's conflict-triggered `A_res`.
- If write throughput regresses, defer cosine-neighbor detection to a post-turn batch; the same-`(source,type)`-hit path runs inline (it is the cheap existing lookup).

**Deferred to dreams (the expensive work):** re-reading provenance via `evidenceChunkIds`, corpus-wide recheck with full visibility, and any destructive close. This is exactly MemGraphRAG's one-shot offline adjudication, made recurring.

**Files:** none new; this is the contract enforced by the Phase 3 implementation and the bench test.
**Flag:** `memory.sabm.deferredDetection` (default `false`; when `true`, cosine detection runs post-turn instead of inline).

---

### Phase 5 - Reconsolidation dream mode (destructive resolution, only when calm)

**Goal:** Add a 9th dream mode `reconsolidation` (after `interceptor_harvest` in `dream-types.ts:12-20`) that drains the re-adjudication queue, re-reads provenance chunks, re-runs the adjudicator with the full corpus visible, and performs the **only** destructive operations in the system.

- The existing `flag_contradiction` `ReconsolidationAction` (`reconsolidation.ts:42`) becomes the re-adjudication trigger: when a labile chunk's evidence backs a relationship flagged contradictory, enqueue that relationship. **No new action type needed.**
- A mutual conflict is destructively resolved (close the loser's `valid_until`) **only after** the loser's backing chunk has entered and **exited** its labile window (`reconsolidation.ts:60-78`), matching the biology that memories restabilize in a new form only after the labile reactivation period.
- Even on close, the row is preserved with `superseded_by` + the `contradicts` edge, so nothing is truly lost.
- Plugs into the existing `DreamMode` scheduler and `fshoModeAdjustments` (`dream-engine.ts:23`). Add a `DEFAULT_MODE_CONFIGS` entry and a `modeTiers` entry for `reconsolidation`.

**Files:** edits to `dream-types.ts` (9th mode + config + tier), `dream-engine.ts` (mode handler draining the queue), `reconsolidation.ts` (enqueue on `flag_contradiction`), new `src/memory/reconsolidation-queue.ts` (~120 LOC, capped). Test: `dream-engine.reconsolidation.test.ts` (close happens only post-labile; row preserved with superseded_by + contradicts edge).
**Flag:** `memory.sabm.reconsolidationMode` (default `false`; silent no-op when the dream engine or queue is empty).

---

### Phase 6 - Biology binding (the moat)

**Goal:** Make adjudication aggressiveness a function of affective state and gate destructive timing on calm.

1. **Hormonal gating of resolution aggressiveness.** Write-time adjudication reads `HormonalStateManager.getState()` (the same object `structural-gate.ts` consumes). Reuse the exact `effectiveDelta` shape (`structural-gate.ts:212-218`, `base - 0.4·cortisol + 0.4·dopamine`) as a new `effectiveLlmThreshold(base, h)`:
   - High **cortisol** narrows: raises the LLM-resolution threshold and biases toward `scope`/`keep-both` (conservative, non-destructive), so a stressed agent does not aggressively delete beliefs.
   - High **dopamine** widens: lowers the threshold so a rewarded/exploratory agent more readily resolves and reorganizes.
2. **Reconsolidation-timed destruction.** As in Phase 5, mutual conflicts are provisionally scoped at write-time and collapsed only during the reconsolidation dream mode, exactly when biological consolidation happens.
3. **Dream gating on calm.** `cortisol > 0.7` already defers graph optimization (`graph-optimization-hook.ts`); the same gate defers re-adjudication so belief geometry is reorganized only when calm.

**Files:** edits to `belief-adjudicator.ts` (read hormonal state, `effectiveLlmThreshold`), `dream-engine.ts` (cortisol gate on the reconsolidation mode). Test: `belief-adjudicator.hormonal.test.ts` (same mutual conflict under high cortisol scopes rather than closes; high dopamine lowers the LLM threshold).
**Flag:** `memory.sabm.hormonalGating` (default `false`).

---

## Optional grafts (defer unless a later PR wants them; listed for completeness, not in the critical path)

These strengthen SABM but are **non-goals for this PR** to avoid bloat. They are recorded so the design is forward-compatible:

- **Frequency-weighted ontology gate as synaptic-tagging analogue:** below-tau schema-triples written provisional/low-weight and stabilized only on recurrence during the `cortisol <= 0.7` graph_optimization dream mode. Non-destructive (provisional edges stay retrievable, just down-gated). Belongs to a separate ONLS plan.
- **Write-half bridge builder** (`graph-bridge-builder.ts`) consuming the existing detect-only `GraphGapSignal` rows to add low-weight provisional `related_to` bridges across islands, hormone-gated through `effectiveDelta` (`structural-gate.ts:218`). This is the affect-PPR/bridging frontier move, explicitly out of scope here.
- **Learned cardinality:** replacing the hand-authored cardinality table with one mined from observed object-multiplicity over time during dreams (see Risks).

---

## What NOT to adopt from MemGraphRAG, and why

- **The three-layer SchemaNode/FactNode/PassageNode rebuild.** Bitterbot already has `entities`/`relationships`/`chunks` with `evidenceChunkIds` covering the Fact→Passage link (`knowledge-graph.ts:89`). Rebuilding as a parallel graph duplicates the SAGE store. Skip.
- **The hardcoded 0.9 cosine detection threshold.** It misses paraphrased contradictions (MemGraphRAG's own limitation). Reuse Bitterbot's tiered 0.85/0.95 from `conflict-resolver.ts:28-29` instead.
- **Bridging and Personalized PageRank.** Those belong to a separate affect-PPR frontier move (a future plan), not this PR.
- **The static-corpus, one-shot adjudication assumption.** SABM must adjudicate continuously at write-time under a live-write budget (Phase 4), then defer the heavy recheck to dreams. This is the central adaptation.
- **Prompt-only taxonomy.** Replaced by the typed deterministic classifier (Phase 2).
- **Unimodal/offline-only framing and self-judged benchmarks.** Out of scope; we will bench on the in-repo LongMemEval harness with a biology-layer ablation.

---

## Success metrics

1. **Belief-history correctness.** `beliefAsOf` and `beliefHistory` return the correct interval chain on a fixture with a known contradiction sequence. Primary functional metric.
2. **Non-destructive invariant.** Property test: after any sequence of writes with `writeAdjudication` on, no relationship row is ever deleted and no `valid_until` is closed before the backing chunk's labile window has exited.
3. **Write-path latency.** `knowledge-graph.write.bench.test.ts`: relationship write p50 stays within budget (target ≤ existing p50 + 5 ms) with adjudication on.
4. **Taxonomy precision.** On a labeled fixture of mutual/temporal/granularity conflicts, the deterministic classifier achieves the correct type/action with no LLM for temporal and granularity, and the LLM fires only on the mutual subset.
5. **Hormonal sensitivity.** Same mutual conflict under high cortisol resolves to `scope` (non-destructive); under high dopamine the LLM threshold is measurably lower.
6. **LongMemEval (knowledge-update + temporal-reasoning splits).** Report a real score with a SABM-on vs SABM-off ablation, per the in-repo harness (`benchmarks/longmemeval`).

---

## Risks

| Risk                                                                                                                  | Mitigation                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hand-authored cardinality table mislabels a `RelationType` → wrong mutual-vs-temporal classification                  | Default unknown relations to `many-to-many` (safest, non-destructive keep-both); learn cardinality from observed object-multiplicity during dreams                                                                 |
| Write-path latency regression on a constantly-written store                                                           | Gate behind `AdjudicationConfig.enabled`; run the cheap same-`(src,target,type)`-hit path inline, defer cosine-neighbor detection to a post-turn batch (`deferredDetection`); `*.bench.test.ts` asserts p50 budget |
| Over-eager destructive resolution corrupting belief history (the silent-corruption failure arXiv:2602.19320 warns of) | Write-time never deletes; it only scopes/flags. Close happens only post-labile-window in the dream mode, and preserves row + `superseded_by` + contradicts edge                                                    |
| LLM resolver backbone-sensitivity on the small/local desktop model                                                    | Typed classifier handles temporal and granularity deterministically with no LLM; LLM only adjudicates ambiguous mutual conflicts; low-confidence output falls back to `scope`, not `close`                         |
| `contradicts`/`refutes` edges trigger adjudication recursion                                                          | Exclude the contradicts/refutes `RelationType` set from adjudicator input, same pattern as `structural-gate.ts:60` excluding non-social relations                                                                  |
| Re-adjudication queue unbounded growth under high contradiction rate                                                  | Cap the queue like `graph_gate_training_pairs` (5,000 rows); prioritize by importance + recency + emotional salience                                                                                               |
| Migration on existing users                                                                                           | v16 is additive; `transaction_time` backfilled = `created_at` via idempotent `UPDATE WHERE NULL`; no interval rewrite                                                                                              |

---

## Non-goals

- No PyTorch, no real GNN, no graph DB. Everything is pure TypeScript over SQLite, respecting the Electron deployment constraint.
- No Personalized PageRank, no bridging, no community/sensemaking tier (separate future plans).
- No new `RelationType` or `EntityType` enum values; reuse `contradicts`/`refutes` (`knowledge-graph.ts:65,79`).
- No learned ontology/schema-frequency layer in this PR (listed as optional graft).
- No destructive deletion of any belief, ever; the history must stay fully auditable and rollback-able.

---

## File budget

**New (~810 LOC):**

- `src/memory/belief-adjudicator-types.ts` (~120)
- `src/memory/belief-adjudicator.ts` (~300)
- `src/memory/belief-history.ts` (~150)
- `src/memory/reconsolidation-queue.ts` (~120)
- 6 test files (~120 total skeleton, expanded per phase)

**Modified:**

- `src/memory/manager.ts` (Phase 0: populate `kgRelationships` at ~2499)
- `src/memory/migrations.ts` (v16)
- `src/memory/temporal-filter.ts` (relationship alias branch)
- `src/memory/knowledge-graph.ts` (`upsertRelationship` adjudication, wire `supersedeRelationship`)
- `src/memory/reconsolidation.ts` (`flag_contradiction` → enqueue)
- `src/memory/dream-types.ts` + `src/memory/dream-engine.ts` (9th `reconsolidation` mode)

**Docs:** see the Documentation section below for the full list.

---

## Testing strategy

Tests are a first-class deliverable of every phase, not a follow-up. The suite
must run under the existing `vitest` setup with `node:sqlite` in-memory DBs, and
follow the repo convention (`*.test.ts` colocated, `*.bench.test.ts` for
latency, `*.phaseN.test.ts` where a phase boundary matters). No phase is "done"
until its tests are green and `pnpm tsgo` + `oxlint` are clean.

### Per-phase test matrix

| Phase | Test file                                         | Asserts                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | `manager.kg-relationships.test.ts`                | a fixture turn with two co-occurring entities yields a written relationship; entity-type pairs map to the expected `relationType`; low-confidence pairs default to `related_to` at low weight; populate flag off = no writes                                                                                                   |
| 1     | `migrations.v16.test.ts`                          | `transaction_time` + `superseded_by` columns exist after migrate; backfill sets `transaction_time = COALESCE(created_at, updated_at)`; re-running v16 on an already-backfilled DB is a no-op (idempotency); fresh-install DBs get the columns too                                                                              |
| 1     | `temporal-filter.rel.test.ts`                     | the relationship-aware branch filters on `valid_from`/`valid_until`/`transaction_time`; passing a chunk alias to the relationship variant (or vice versa) is rejected/guarded, not silently mis-filtered                                                                                                                       |
| 2     | `belief-adjudicator.test.ts`                      | labeled fixtures classify mutual/temporal/granularity correctly; temporal + granularity resolve with **zero** LLM calls (assert the injected LLM mock is never called); ambiguous mutual conflicts are flagged for deferred (dream) resolution, not resolved inline; unknown `RelationType` defaults to many-to-many keep-both |
| 2     | `belief-history.test.ts`                          | `beliefAsOf` / `beliefHistory` return the correct interval chain on a known contradiction sequence; superseded beliefs are present with `superseded_by` + a `contradicts`/`refutes` edge and are never deleted                                                                                                                 |
| 2     | `knowledge-graph.stats.test.ts`                   | `getStats` exposes conflicts-by-type, close-vs-scope ratio, LLM-fire-rate, queue depth (extends existing stats without breaking current fields)                                                                                                                                                                                |
| 3     | `knowledge-graph.adjudication.test.ts`            | write-time is non-destructive (no row deleted, no `valid_until` closed before the labile window exits); `supersedeRelationship` is actually invoked; contradicts/refutes edges are excluded from adjudicator input (no recursion)                                                                                              |
| 4     | `knowledge-graph.write.bench.test.ts`             | relationship write **p50 and p99** stay within budget with adjudication on; the deferred-detection batch converges to the same result as inline detection (property test); Phase 0+Phase 3 write-amplification path is exercised (every co-occurring pair, not just same-`(src,tgt,type)`)                                     |
| 5     | `reconsolidation-queue.test.ts` + dream-mode test | queue is bounded (cap like `graph_gate_training_pairs`) and prioritized; the 9th `reconsolidation` mode drains it; destructive close happens only post-labile-window; **pruned/forgotten evidence chunks never strand a relationship** un-closable (the underspecified-join edge case)                                         |
| 6     | `belief-adjudicator.hormonal.test.ts`             | same mutual conflict resolves to `scope` under high cortisol and lowers the LLM threshold under high dopamine; the cortisol gate is read from the real call site (`graph-optimizer.ts` / `manager.ts:3406`), not a stub                                                                                                        |

### Cross-cutting test requirements

- **Latency must measure the tail, not just p50.** Because any LLM adjudication
  is deferred to the dream mode, the write-path bench should confirm the hot
  path is LLM-free; if any LLM call ever lands on the write path, the bench
  asserts p99, not p50 (a p50 budget hides an LLM-triggered tail).
- **Determinism.** The classifier is seeded/pure; given identical inputs it
  yields identical type/action. A property test over random conflict sequences
  asserts the non-destructive invariant holds for all orderings.
- **Migration safety.** v16 idempotency + fresh-install coverage are mandatory
  before the schema bump merges.
- **Ablation harness.** A `benchmarks/longmemeval` SABM-on vs SABM-off run on
  the knowledge-update + temporal-reasoning splits, gated by `sabm.enabled`, so
  the win/regression is attributable.

---

## Documentation

Documentation is part of the deliverable, shipped in the same PRs as the code it
describes (spine docs with the spine PR; dream-mode/biology docs with their
phases). All public docs follow repo conventions: no em-dashes, `oxfmt`-clean,
and registered in `docs/docs.json` navigation, with `pnpm check:docs`
(format + markdownlint + link-audit) green.

### New documentation

- **`docs/memory/sabm-belief-adjudication.md`** (primary, new). The canonical
  reference: the bitemporal belief model (valid-time + transaction-time on
  relationships), the mutual/temporal/granularity taxonomy with worked examples
  for each, the non-destructive close-vs-scope-vs-flag actions, the
  belief-history query API (`beliefAsOf` / `beliefHistory`) with usage snippets,
  the reconsolidation dream mode, the hormonal gating of adjudication
  aggressiveness, and the full env/flag reference. Includes a "how SABM relates
  to MemGraphRAG / Zep / HippoRAG" positioning subsection so the SOTA delta is
  documented, not just claimed.

### Updated documentation

- **`docs/memory/sage-graph-memory.md`** - add a "Belief adjudication" section
  explaining that relationships are now populated, bitemporally versioned, and
  self-adjudicating; link to the new doc.
- **`docs/memory/how-the-memory-works.md`** - cross-link belief adjudication
  into the top-level memory narrative (where contradictions and updates are
  discussed).
- **`docs/memory/architecture-overview.md`** - add the belief-adjudicator,
  belief-history, and reconsolidation-queue modules to the architecture map.
- **`docs/memory/dream-engine.md`** - document the 9th `reconsolidation` dream
  mode (what it drains, when it fires, the cortisol gate).
- **`docs/memory/emotional-system.md`** (or `biological-identity.md`) - note
  that hormonal state now gates belief-revision aggressiveness, since that is
  the cross-system moat.
- **`docs/docs.json`** - navigation entry for the new doc under the Memory
  group.
- **Config/flag reference** - document `sabm.*` flags (master `enabled`,
  `writeAdjudication`, `deferredDetection`, `reconsolidationMode`,
  `hormonalGating`, and `memory.kgRelationships.populate`) and their precedence
  in whichever config doc owns memory flags (`docs/gateway/configuration-reference.md`).

### Code-level documentation

- Module-header doc comments on each new file (`belief-adjudicator.ts`,
  `belief-history.ts`, `reconsolidation-queue.ts`) stating purpose, the
  non-destructive invariant, and the write-path-is-LLM-free contract, matching
  the existing SAGE module-header style.
- A short note in `research/plans/PLAN-18-SAGE-GRAPH-MEMORY.md` pointing forward
  to PLAN-23 as the belief-adjudication follow-up, so the plan lineage is
  traceable.

---

## Sequencing

The **spine PR** (recommended first increment) is Phases 0 through 2 plus their
tests and the new `sabm-belief-adjudication.md` doc with its SAGE/how-it-works
cross-links. Ship and review that before the moat phases.

1. **Day 1:** Phase 0 (populate `kgRelationships`) + Phase 1 (v16 migration, temporal-filter), with `manager.kg-relationships`, `migrations.v16`, and `temporal-filter.rel` tests. Ships standalone value.
2. **Day 2 to 3:** Phase 2 (typed adjudicator + belief-history + `getStats` telemetry) behind `sabm.enabled`, with the adjudicator/belief-history/stats tests. **Spine PR ends here**, including the new doc + updates to `sage-graph-memory.md` and `how-the-memory-works.md`.
3. **Day 4:** Phase 3 (writer wiring, non-destructive) + Phase 4 (write-cost p50/p99 bench + convergence property test).
4. **Day 5:** Phase 5 (reconsolidation dream mode + bounded queue), with the dream-engine + queue + pruned-evidence edge-case tests, and the `dream-engine.md` update.
5. **Day 6:** Phase 6 (hormonal gating), with the hormonal-sensitivity test and the `emotional-system.md` update.
6. **Day 7:** LongMemEval SABM-on/off ablation + remaining documentation (architecture-overview, config/flag reference, docs.json, PLAN-18 forward-pointer). The hormonally-gated, reconsolidation-timed destructiveness over a bitemporal graph is the publishable delta over both MemGraphRAG and Zep/Graphiti.

---

## References

- MemGraphRAG: Wu, Xiang, Tang, Chen, Zhang, Su, KDD'26, arXiv:2606.00610 (DOI 10.1145/3770855.3818074). Note: arXiv:2606.00609 is a different paper and must not be cited.
- Zep/Graphiti temporal-KG agent memory, arXiv:2501.13956
- HippoRAG 2, arXiv:2502.14802
- Anatomy of Agentic Memory (silent-corruption critique), arXiv:2602.19320
- Graph-based Agent Memory survey, arXiv:2602.05665
- PLAN-18 (`research/plans/PLAN-18-SAGE-GRAPH-MEMORY.md`) - graph reader, structural gate, dream optimization substrate
- PLAN-9 (`research/plans/PLAN-9-memory-supremacy.md`) - reconsolidation, bitemporal store
- PLAN-21 (`research/plans/PLAN-21-VALIDATION-GATE-SLOW-UPDATE.md`) - bio-conditioned validation gate pattern

---

Relevant existing files cited (all verified against the working tree): `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/knowledge-graph.ts` (RelationType 57-79, upsertRelationship 216-290, supersedeRelationship 296), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/conflict-resolver.ts` (thresholds 28-30), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/reconsolidation.ts` (flag_contradiction 42, labile 60-78), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/structural-gate.ts` (effectiveDelta 212-218, SOCIAL_RELATIONS 60), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/migrations.ts` (latest is v15 at line 652; chunks transaction_time pattern 271-286), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/temporal-filter.ts` (asOf branch 65-67), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/dream-types.ts` (8 modes 12-20), `/mnt/d/Bitterbot/bitterbot-desktop/src/memory/manager.ts` (empty kgRelationships 2499, ingestExtraction 2527).

---

## Addendum: Review hardening (must-fix before build)

An adversarial fit-check against the live code flagged the items below. The
verdict was **conditional-go on the spine** (Phase 0 + Phase 1 + the
deterministic Phase 2 classifier + belief-history); Phases 5-6 are deferred
until the spine ships real relationship data and a LongMemEval baseline exists.
The "moat / publishable primitive" framing in the summary is aspirational and
premature until that data and ablation delta exist.

### Foundational precondition (highest priority)

The relationship layer is currently **never populated** - the extraction path
returns an empty relationship array (`manager.ts:2499`), and
`supersedeRelationship` (`knowledge-graph.ts:296`) plus the `contradicts` /
`refutes` enum values are effectively dead code. **The entire feature is moot
until Phase 0 actually lands relationship data.** Phase 0 is therefore a hard
prerequisite, and its write-volume interaction with Phase 3 (every co-occurring
pair emitting `related_to` then being adjudicated on write) is a
write-amplification path the Phase 4 bench must cover explicitly.

### Three claims that must be corrected

1. **`conflict-resolver.ts` cannot be reused as a relationship pre-filter.**
   `resolveFactConflict` is embedding-cosine over the **chunks** table;
   relationships have no embedding column and live in a different table. Reuse
   only the `cosineSimilarity` primitive (from `internal.ts`), or drop
   relationship-cosine detection and rely on the `same-(source,target,type)`
   lookup.
2. **Bitemporal column vocabulary mismatch (most serious).** Chunks use
   `valid_time_start` / `valid_time_end` / `transaction_time`; relationships use
   `valid_from` / `valid_until` with no transaction-time axis, and
   `temporal-filter.ts:39-90` hardcodes the chunk column names (only the table
   alias is parameterized). The "relationship-aware temporal filter" is a new
   function with a divergent column set, not an alias tweak. Decide in v16:
   either rename relationship columns to match chunks, or explicitly own the
   two-vocabulary debt (and guard against passing the wrong alias).
3. **Keep the write path deterministic - move ALL LLM resolution into the
   reconsolidation dream mode.** As drafted, Phase 3/6 put a model call on the
   write hot path for ambiguous mutual conflicts, contradicting the plan's own
   "write path cheap" thesis. The p50+5ms bench cannot see the LLM-triggered
   p99 tail. Write-time stays fully deterministic; the dream mode owns any LLM
   adjudication.

### Corrections and underspecified joins

- **Wrong file citation:** the `cortisol > 0.7` gate is in `graph-optimizer.ts`
  / `manager.ts:3406` (and `>0.8` cortisol_spike at `manager.ts:523`), NOT
  `graph-optimization-hook.ts`. The reconsolidation dream mode must replicate
  the gate at its real call site.
- **Dream-mode surface is larger than "a config entry":** a 9th mode needs a
  new `case` + handler in the `runMode` switch (`dream-engine.ts:968`), entries
  in `DEFAULT_MODE_CONFIGS` and `DEFAULT_MODE_TIERS` (`dream-types.ts`), and it
  interacts with `fshoModeAdjustments` and the requiresLlm/compute-tier
  scheduler (`dream-engine.ts:527`).
- **Phase 5 labile-join is underspecified:** a relationship has multiple
  `evidenceChunkIds`; define all-vs-any semantics for which chunk's
  `labile_until` gates the destructive close, and what happens when evidence
  chunks were pruned/forgotten (so a relationship is never stranded
  un-closable).
- **Reader cannot see closed edges:** every reader query hardcodes
  `valid_until IS NULL` (`knowledge-graph.ts:175,189,239,243,320`;
  `graph-reader` readNeighbors). Surfacing belief history through the existing
  retrieval surface needs a budgeted `includeClosed` path; otherwise only the
  new `belief-history.ts` API sees superseded edges.
- **Cardinality table needs validation:** `manages` / `works_on` as one-to-one
  will mis-fire on legitimately many-to-many social relations (co-managers).
  Validate cardinality assumptions against real extracted data before they are
  load-bearing; default unknowns to many-to-many.

### Missing pieces to add before build

- A concrete **post-turn deferred-detection** queue/table/trigger/drain (distinct
  from the dream re-adjudication queue) if `deferredDetection` is kept.
- **Telemetry in `getStats`:** conflicts-by-type, LLM-resolver fire rate,
  close-vs-scope ratio, queue depth, deferred backlog - without these the
  LongMemEval ablation cannot attribute wins/regressions and the p99 tail is
  invisible.
- **Flag home + precedence:** name the config object (`SageConfig` vs a new
  `SabmConfig`), add a master kill-switch, and document precedence
  (does `writeAdjudication` imply `enabled`?). Follow the
  `{ enabled?, ...overrides }` + `DEFAULT_*` convention.
- **Tests:** add a p99/LLM-tail bench, a convergence property test (deferred
  batch == inline detection), a v16 migration idempotency test (re-run on an
  already-backfilled DB), and a Phase 5 edge test (pruned evidence chunks do
  not strand a relationship).

### Ranking (judge panel, of 3 strategies)

- SABM: Self-Adjudicating Bitemporal Memory - 42
- PLAN-22: Surgical MemGraphRAG Graft (Typed Conflict Taxonomy + Frequency Ontology Gate + Similarity Bridging) - 41
- PLAN-22: Ontology-Native Living Schema (ONLS) - 8.2
