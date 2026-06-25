# SAGE-Style Self-Evolving Graph Memory (PLAN-18)

PLAN-18 wires a SAGE-style retrieval loop into Bitterbot's existing knowledge-graph + dream substrate. The result is a memory reader that:

- decomposes queries into multi-anchor probes (structured query planning),
- propagates activation across the entity graph with learned per-edge gates (structural gating in message passing),
- learns its gate parameters offline in the dream engine from collected QA evidence (self-evolving alternation),
- routes retrieval failures back into the writer through the curiosity engine (writer-reader coupling),
- and modulates retrieval breadth from the hormonal state (Bitterbot-specific extension over baseline SAGE).

**Migration:** v13 in `src/memory/migrations.ts`
**Reference paper:** SAGE: A Self-Evolving Agentic Graph-Memory Engine (arXiv:2605.12061)
**Plan doc:** `research/plans/PLAN-18-SAGE-GRAPH-MEMORY.md`

---

## 1. Structured Query Planning (Phase 1)

**File:** `src/memory/query-planner.ts`

`planQuery(rawQuery, opts)` decomposes a raw query into a `QueryPlan`:

```ts
type QueryPlan = {
  rawQuery: string;
  explicitEntities: string[]; // salient named things
  aliases: string[]; // surface-form variants
  conceptualRelations: string[]; // abstract relation labels
  hardConstraints: string[]; // dates, paths, quoted strings
  answerType: "factual" | "list" | "explanation" | "comparison" | "yesno" | "procedure" | "unknown";
  pseudoQueries: string[]; // multiple paraphrased anchor probes
  source: "llm" | "heuristic" | "cache";
  planningTimeMs: number;
};
```

- **Primary path:** a fast LLM call (caller injects `llmCall`, typically Haiku 4.5) with a strict JSON schema and `temperature: 0`.
- **Fallback path:** a pure heuristic decomposer that never fails — extracts capitalized noun runs (plus single tokens for verb-prefixed runs like "Wrote Bitterbot" → `["Wrote Bitterbot", "Wrote", "Bitterbot"]`), infers `answerType` from interrogatives, and matches ISO dates, quarters (`2026-Q1`), file paths, and quoted strings.
- **Cache:** LRU keyed by query hash + `maxPseudoQueries`, 5-min TTL (matches the Anthropic prompt-cache window).

The plan widens the retrieval surface so a single vector probe doesn't dominate. SAGE Section 4.1 calls this "multi-cue activation."

---

## 2. Graph-Aware Reader (Phase 2)

**File:** `src/memory/graph-reader.ts`

`graphRead(db, kg, plan, opts)` performs L-step message passing over the existing `entities`/`relationships` tables, in pure TypeScript over SQLite — no PyTorch, no tensors.

Seed activations come from `QueryPlan.explicitEntities + aliases + hardConstraints` resolved via `KnowledgeGraphManager.findEntityByNameType()` (and case-insensitive fuzzy search as fallback).

Update rule at each hop:

```
a_v^(l+1) = (1 - decay) · a_v^(l)
          + propagate · Σ_u  g_{u→v} · w_{u→v} · a_u^(l) / sqrt(deg(v))
```

- `g_{u→v}` defaults to `1.0` when no gate function is supplied (Phase 2 uniform-gate baseline).
- `w_{u→v}` reads `relationships.weight`.
- `sqrt(deg(v))` is the standard GCN normalization preventing hub-entity explosion.

Activations are L1-normalized per hop. The final `chunks` distribution comes from `relationships.evidence_chunk_ids` weighted by the activation that flowed across each edge.

Key parameters (config-tunable):

| Option        | Default | Notes                         |
| ------------- | ------- | ----------------------------- |
| `hops`        | 2       | SAGE-aligned; bounded to ≤4   |
| `maxFrontier` | 200     | Caps propagation cost per hop |
| `decay`       | 0.5     | Carry-over of self-activation |
| `topK`        | 50      | Returned chunk/entity cap     |
| `cacheTtlMs`  | 30 000  | Per-query memoization         |

Cost on a typical user graph (~10k entities, ~50k edges): ~10–30 ms p50 for L=2.

---

## 3. Structural Gating + Offline Self-Evolution (Phase 3)

This is the SAGE core. The dream engine becomes the optimizer.

### Topology features

**File:** `src/memory/graph-topology.ts`

For every active edge, compute an 8-feature vector (SAGE Section 4.2):

```
z_{uv} = [
  deg(u),                              squashed
  deg(v),                              squashed
  |deg(u) - deg(v)|,                   squashed
  jaccard(N(u), N(v)),                 ∈ [0, 1]
  |common neighbors|,                  squashed
  mentionCount(u),                     squashed
  mentionCount(v),                     squashed
  recency = exp(-ln2 · ageDays/30),    half-life 30 d
]
```

Stored compactly as `8 × Float32 = 32 bytes` in the new `relationships.gate_features` BLOB column. `recomputeFeaturesForRelationships()` recomputes incrementally; `getOrComputeEdgeFeatures()` provides a lazy fallback.

### The gate

**File:** `src/memory/structural-gate.ts`

A tiny MLP: `8 → 16 → 1`, ~145 parameters total. Forward pass is pure TS, evaluated in <1 ms per edge.

The SAGE gating formula is implemented exactly:

```
g_{uv} = 1 + δ · tanh(MLP_g(z_{uv}))
```

…with the gate value clamped into `[0, 2.5]` so a misbehaved MLP never inverts edge weights. The parameter pack serializes to a small JSON file (`~/.bitterbot/graph_gate.json`).

### The optimizer

**File:** `src/memory/graph-optimizer.ts`

Gradient-free CMA-ES-lite (population × generations Gaussian random search around the current best, with elite-centroid recentering and a 0.9× σ shrink on improvement, 0.8× on stagnation). The optimizer never touches LLM weights — it tunes the gate MLP.

Reward, matching SAGE Eq. 4:

```
r = (α · recall + β · precision + γ · deducibility) / (α + β + γ)
```

- `recall`: ground-truth chunk appears in top-K (1/0)
- `precision`: `1 / (1 + rank of ground-truth chunk)`
- `deducibility`: fraction of top-K retrieved chunks whose anchor entities share a 1-hop neighborhood with the ground-truth chunk's anchor entities (proxy for "answer-derivable from this evidence set")

### Training-pair collection

The `graph_gate_training_pairs` table holds `(query, ground_truth_chunk_id)` tuples sourced from real session traces. `insertTrainingPair()` is invoked by the experience-signal-collector when an agent turn cites a specific chunk; the table is capped at 5 000 rows.

### Dream-engine integration

**File:** `src/memory/graph-optimization-hook.ts`

`maybeRunGraphOptimization()` is the integration surface. It silently no-ops when:

- the feature flag is off,
- fewer than `minTrainingPairs` (default 50) pairs are collected,
- the cooldown window (default 6 h) has not elapsed,
- the current `hormonalState.cortisol > 0.7` (don't update memory geometry during high-arousal sessions).

When it runs, it loads the current gate, performs an 80/20 train/validate split, runs one CMA-ES cycle on the training pairs, validates on held-out, **rejects regressions** (the validation-set delta must be ≥0), and persists either the new gate or the baseline so the on-disk gate file always matches the materialized `relationships.gate_value` column.

Typical cycle: ~90 evaluations × ~15 ms each ≈ 1.5–3 s wall-clock.

---

## 4. Writer-Reader Coupling (Phase 4)

**File:** `src/memory/graph-bridge-target.ts`

A new `graph_bridge` `ExplorationTargetType` (added to `src/memory/curiosity-types.ts`).

When the graph reader misses a chunk that vector or FTS surfaced and the agent actually cited it, `detectGraphGaps()` emits a `GraphGapSignal`. `emitGraphBridgeSignal()` writes a `graph_bridge` curiosity target with structured metadata:

```ts
type GraphBridgeTargetMetadata = {
  source: "graph_bridge";
  query: string;
  missedChunkId: string;
  nearestActivatedEntityIds: string[];
  truthEntityIds: string[];
  nudge: string; // free-form prompt for the next extractor pass
};
```

`readActiveBridgeTargets()` returns the most-recent high-priority targets so the session extractor can fold them into its prompt — nudging the _writer_ (the LLM extractor) to capture richer triples around the entities the reader was missing. Duplicate signals (same query + missed chunk) reinforce priority instead of creating duplicates.

This is SAGE's writer-reader feedback loop, adapted: instead of RL-updating LLM weights, we update the extraction prompt.

---

## 5. Hormonal Modulation (Phase 5)

The publishable novelty over baseline SAGE.

The effective δ used in `g = 1 + δ · tanh(MLP)` is dynamic:

```
δ_eff = δ_base
      − 0.4 · cortisol      // stress narrows focus to high-confidence paths
      + 0.4 · dopamine      // reward widens exploration to bridge edges
```

…clamped into `[0, 1]`.

`oxytocin` boosts a per-edge multiplier of `1 + 0.3 · oxytocin` when the relation type is one of `knows | manages | prefers | works_on` — the social-relation subset (`SOCIAL_RELATIONS` in `structural-gate.ts`).

`cortisol > 0.7` skips the gate-optimization cycle entirely: don't try to learn memory geometry during high-arousal sessions; consolidate during calm.

---

## 6. The façade

**File:** `src/memory/sage-memory.ts`

Public entry point for everything above:

```ts
const { plan, graph, hormonalSnapshot } = await sageRetrieve(db, kg, "What is Alice working on?", {
  queryPlanning: { enabled: true, llmCall },
  graphReader: { enabled: true, hops: 2, maxFrontier: 200, topK: 50 },
  structuralGating: { enabled: true, gateFilePath }, // Phase 3 — optional
  hormonalModulation: {
    // Phase 5 — optional
    enabled: true,
    getState: () => hormonalStateManager.getState(),
  },
});
```

Each phase is independently gated. Partial rollouts are safe: with everything but `queryPlanning` disabled, the function still returns a sensible plan.

The gate file is loaded once and memoized by mtime, so subsequent retrievals don't repeatedly parse JSON.

---

## 7. Schema (migration v13)

```sql
ALTER TABLE relationships ADD COLUMN gate_value    REAL DEFAULT 1.0;
ALTER TABLE relationships ADD COLUMN gate_features BLOB;

CREATE TABLE graph_gate_training_pairs (
  id                    TEXT PRIMARY KEY,
  query                 TEXT NOT NULL,
  ground_truth_chunk_id TEXT NOT NULL,
  collected_at          INTEGER NOT NULL,
  source                TEXT NOT NULL DEFAULT 'access_log'
);
CREATE INDEX idx_graph_gate_training_pairs_collected
  ON graph_gate_training_pairs(collected_at);

ALTER TABLE dream_cycles ADD COLUMN graph_reward_delta REAL;
```

The migration is additive only; every new column has a safe default and `addColumnIfMissing()` makes the migration idempotent.

---

## 8. Configuration surface

| Key                                        | Phase | Default                   | Effect                                   |
| ------------------------------------------ | ----- | ------------------------- | ---------------------------------------- |
| `memory.graphReader.queryPlanning`         | 1     | `true`                    | Structured query planning                |
| `memory.graphReader.enabled`               | 2     | `true` once Phase 2 ships | Graph-reader RRF channel                 |
| `memory.graphReader.hops`                  | 2     | `2`                       | Message-passing depth                    |
| `memory.graphReader.maxFrontier`           | 2     | `200`                     | Cap on frontier per hop                  |
| `memory.graphReader.structuralGating`      | 3     | `false`                   | Load gate file, apply learned δ-tanh-MLP |
| `memory.graphReader.curiosityCoupling`     | 4     | `false`                   | Emit `graph_bridge` signals              |
| `memory.graphReader.hormonalModulation`    | 5     | `false`                   | Cortisol/dopamine/oxytocin modulate δ    |
| `dream.graphOptimization.cooldownMs`       | 3     | `6h`                      | Minimum gap between optimizer runs       |
| `dream.graphOptimization.minTrainingPairs` | 3     | `50`                      | Floor before optimization starts         |

---

## 9. Tests

Each module ships with a dedicated vitest file:

- `query-planner.test.ts` — 12 tests covering heuristic extraction, answer-type classification, LLM parsing (including fenced-JSON), fallback paths, caching.
- `graph-topology.test.ts` — 6 tests covering feature normalization, pack/unpack round-trip, lazy compute, batch persistence.
- `structural-gate.test.ts` — 12 tests covering forward-pass determinism, output bounds, serialization, hormonal modulation (cortisol narrows, dopamine widens, oxytocin boosts social relations only).
- `graph-reader.test.ts` — 8 tests covering seed resolution, 1-hop and 2-hop propagation, top-K, caching, gate-function injection, hormonal forwarding, activation finiteness.
- `graph-optimizer.test.ts` — 5 tests covering training-pair store, gate evaluation, optimizer-cycle monotonicity, high-cortisol skip gate.
- `graph-bridge-target.test.ts` — 7 tests covering gap detection, signal persistence, deduplication, prioritized reads.
- `graph-optimization-hook.test.ts` — 5 tests covering feature-flag gating, training-floor gating, cooldown, regression rejection, gate-value materialization.
- `sage-memory.test.ts` — 4 integration tests covering disabled-reader degraded mode, end-to-end retrieval, hormonal forwarding, gate-file loading.

All 59 SAGE tests pass; no adjacent regressions in `knowledge-crystal-system.test.ts`, `curiosity-engine.task-spawn.test.ts`, or `hybrid.test.ts`.

---

## 10. Why this respects Bitterbot's deployment

- **No PyTorch.** The "GNN" is iterated SQL propagation with ~145 scalar parameters. Forward pass is <1 ms per edge in pure TS.
- **No backprop.** Gradient-free optimization (CMA-ES-lite) over the tiny parameter pack; tractable in a single dream-cycle slice.
- **No new background process.** All work piggybacks on the existing dream engine's scheduled cycles.
- **No destructive migration.** v13 adds columns + one table; defaults are safe; rollback is a column drop.
- **Each phase is independently flag-gated.** Phase 1 alone delivers measurable multi-hop recall gains with zero schema churn; later phases compound.

---

## See also

- `research/plans/PLAN-18-SAGE-GRAPH-MEMORY.md` — the plan doc with diagnosis, sequencing, and risk table.
- `docs/memory/plan9-memory-supremacy.md` — the knowledge-graph substrate this builds on.
- `docs/memory/dream-engine.md` — the offline-cycle host for Phase 3.
- `docs/memory/curiosity-and-search.md` — the writer-feedback channel for Phase 4.
- `docs/memory/emotional-system.md` — the hormonal state surface for Phase 5.
- `docs/memory/sabm-belief-adjudication.md` — PLAN-23 builds on this graph to populate relationships, version them bitemporally, and self-adjudicate contradictions.
- `docs/plans/PLAN-28-GRAPH-POPULATION-AND-RETRIEVAL-OBSERVABILITY.md` — PLAN-28 fills the relationship substrate this reader traverses (deterministic hot-path + backfill + offline LLM mining) and instruments per-layer retrieval contribution so a dead graph channel can't hide.
