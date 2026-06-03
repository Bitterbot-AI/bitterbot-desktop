# SABM: Self-Adjudicating Bitemporal Memory (PLAN-23)

PLAN-23 turns Bitterbot's relationship graph into a queryable, auditable belief
history. It grafts MemGraphRAG's typed conflict taxonomy onto the existing
bitemporal knowledge graph, resolves contradictions non-destructively, and
re-adjudicates them during hormonally-gated reconsolidation dreams.

**Migration:** v16 in `src/memory/migrations.ts`
**On by default.** Disable relationship population with `BITTERBOT_KG_RELATIONSHIPS=0`.

## Why

Before PLAN-23 the relationship layer was effectively dead: the session
extractor always passed an empty relationship array, so `upsertRelationship`,
`supersedeRelationship`, and the `contradicts` / `refutes` relation kinds were
never exercised. SABM populates the layer and adds the missing belief-fidelity
machinery: it notices when two facts conflict, keeps both until it can decide,
and decides during rest rather than on the hot path.

## The three guarantees

1. **The write path is deterministic and non-destructive.** Relationship
   extraction uses a keyword table over fact text (no LLM, no embeddings). When
   a new edge of a mutually-exclusive relation type (currently `located_at`,
   `belongs_to`) conflicts with an existing active edge, the writer only records
   a `flag_contradiction` audit row. Both edges stay active (`valid_until IS
NULL`). Nothing is ever closed or deleted on write.
2. **Destructive revision happens only during a calm dream.** The 9th dream mode
   `relationship_reconsolidation` drains flagged contradictions. For each, it
   closes the losing edge via `supersedeRelationship` (sets `valid_until`) only
   after two gates pass (below). This is the single place an LLM adjudicates and
   the single place a belief is closed.
3. **Closed beliefs are retained and queryable.** A superseded edge is never
   deleted: it keeps its row, gets `valid_until` set, and every transition is
   recorded in `relationship_belief_history`. "What did I believe about X as of
   time T" is a first-class query.

## The two gates on destructive close

- **Labile-window gate.** Every evidence chunk backing a flagged edge must have
  exited its reconsolidation labile window (`labile_until IS NULL OR <= now`).
  If any backing chunk is still labile, the close is deferred to a later cycle
  (conservative ALL-closed rule). Pruned or forgotten evidence chunks (no row)
  count as non-labile, so an edge is never stranded un-adjudicatable.
- **Hormonal gate.** The winner must clear a confidence floor modulated by
  `effectiveDelta` over cortisol/dopamine: high cortisol raises the bar (be
  conservative under stress), high dopamine lowers it (be willing to revise).
  Social relations (`knows`, `manages`, `prefers`, `works_on`) carry an extra
  penalty so they need a stronger signal before being closed. No surveyed memory
  system ties belief revision to affective state; this is the SABM moat.

## Belief-history query API

`KnowledgeGraphManager` gains two read methods that surface closed beliefs
(unlike `traverseEntity`, which hardcodes the active-only `valid_until IS NULL`
filter):

```ts
// Active + closed edges for an entity, newest first.
kg.beliefHistory(entityId);

// Only edges whose valid interval contained ts (point-in-time belief).
kg.beliefAsOf(entityId, ts);
```

Both route through `buildRelationshipTemporalWhereClause({ includeClosed: true })`
in `temporal-filter.ts`, the single bridge for the relationship temporal
vocabulary (`valid_from` / `valid_until`), which is deliberately distinct from
the chunks vocabulary (`valid_time_start` / `valid_time_end` / `transaction_time`).

## Telemetry

`getStats()` exposes SABM counters alongside the existing entity/relationship
counts (all defensive on a pre-v16 DB):

- `closedRelationships`, `flaggedContradictions`, `beliefRevisions` (supersede
  count), `reinforcements` (strengthen count).

These make the LongMemEval SABM-on/off ablation interpretable.

## Configuration

| Env var                      | Default | Effect                                                                          |
| ---------------------------- | ------- | ------------------------------------------------------------------------------- |
| `BITTERBOT_KG_RELATIONSHIPS` | on      | Deterministic relationship extraction on the write path. Set to `0` to disable. |

The reconsolidation dream mode is enabled by default in `DEFAULT_MODE_CONFIGS`;
opt out with the standard per-mode dream config
(`modes.relationship_reconsolidation.enabled = false`).

## How SABM relates to prior art

- **MemGraphRAG** (Wu, Xiang et al., KDD 2026) contributes the mutual / temporal
  / granularity taxonomy, but its resolution is prompt-only over a static corpus
  and it has no bitemporal model to write a "valid until" into. SABM ports the
  taxonomy onto a real bitemporal graph and runs it continuously.
- **Zep / Graphiti** has bitemporal edges and invalidation, but resolves by
  recency / LLM with no typed taxonomy and no biological consolidation.
- SABM's distinguishing primitive: typed conflict resolution executed
  continuously over a bitemporal graph, with hormonally-gated,
  reconsolidation-timed destructiveness.

## Where the code lives

| File                                                     | Purpose                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/memory/kg-relationship-extract.ts`                  | Pure deterministic relationship extraction (Phase 0)                 |
| `src/memory/migrations.ts` (v16)                         | `relationship_belief_history` table + `last_reinforced_at`           |
| `src/memory/temporal-filter.ts`                          | `buildRelationshipTemporalWhereClause` (includeClosed path)          |
| `src/memory/knowledge-graph.ts`                          | Write-time flag/strengthen audit, belief-history read API, telemetry |
| `src/memory/dream-modes/relationship-reconsolidation.ts` | The reconsolidation dream mode (only destructive close)              |

See `docs/plans/PLAN-23-SABM-SELF-ADJUDICATING-BITEMPORAL-MEMORY.md` for the
full design and the review-hardening addendum.
