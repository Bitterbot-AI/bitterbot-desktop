# PLAN-27: Graph-Anchored Proactive Recall

Make the involuntary recall path resolve **entity/identity queries through the
knowledge graph** instead of a flat vector probe, so questions like "who is
Donna" / "who is my wife" surface the current, SABM-valid relationship
_structurally_ — confident, and immune to the embedding-similarity cliff.

**Status:** LANDED (2026-06-23). On by default; gated by the existing
`BITTERBOT_KG_RELATIONSHIPS` flag (set to `0` to disable population + backfill).
**Builds on:** PLAN-7 (proactive recall), PLAN-18 (SAGE graph reader), PLAN-23 (SABM bitemporal beliefs)
**Migration:** none (reuses `entities` / `relationships`; new family `RelationType`s are additive)

## What shipped

- Family `RelationType`s (`spouse_of` / `parent_of` / `child_of` / `sibling_of`),
  gender-neutral; human label derived at format time (`FAMILY_RELATION_LABEL`).
- `extractIdentityRelationship()` in `kg-relationship-extract.ts` — first-person
  identity patterns ("User's wife is named Donna", "Donna is my wife") → typed
  edge linked to the resolved user entity.
- Go-forward population: the session-extraction KG pass now runs the identity
  extractor on every fact (not just `semanticType === "relationship"`), so
  world_fact kinship facts produce edges.
- One-time `manager.backfillIdentityRelationships()` over historical kinship
  crystals, triggered lazily on the first user turn (guarded, idempotent).
- `proactive-recall-graph.ts` graph stage, wired as stage 0 of `proactiveRecall`
  via `manager.recallForUserTurn` (passes `kg` + resolved `userName`).

### Hardening learned during implementation

Verifying the extractor against the **live** crystal store caught two
false-positive classes that the unit tests alone missed (a good argument for
real-data verification):

1. **Third-party owners.** The owner set originally included `his`/`her`/`their`
   — but "her wife is …" is about someone else and must never forge a _user_
   edge. Owner is now first-person only (`my` / `(the )?user's`).
2. **Loose name capture.** The keyword regex's `i` flag also loosened the
   proper-name group, letting "… is what" yield a `what` person. The captured
   name is now re-asserted against a case-sensitive proper-noun pattern.

Both are regression-tested. On the live store the extractor now yields exactly
one edge (`Donna spouse_of Victor`) where it previously produced three.

Phases 4 (bitemporal `beliefAsOf` for "used to" phrasing) and 5 (oxytocin social
boost) are designed below but deferred; the core entity-query win ships without
them.

---

## 1. Why

Proactive recall (`src/memory/proactive-recall.ts`) — the always-on, pre-generation
surfacing that lets the agent answer already knowing what it has stored — is the
**simplest** layer in the retrieval stack. It runs one vector probe over
`directive` / `world_fact` / `mental_model` crystals and gates on cosine
similarity. The deliberate path (`memory_search`) has the whole SAGE graph + SABM
bitemporal machinery; the involuntary path has none of it.

That mismatch bites hardest on **entity and relationship queries**, which are
short and structural, not lexical. Measured against the live embedding model
(`text-embedding-3-small`), the natural query embeds _far_ from the stored fact:

| query                | stored fact                   | cosine    |
| -------------------- | ----------------------------- | --------- |
| "who is my wife"     | "User's wife is named Donna." | **0.497** |
| "who is Donn" (typo) | "User's wife is named Donna." | 0.469     |
| "who is Donna"       | "User's wife is named Donna." | 0.646     |

We lowered `minScore` to 0.45 (PLAN tuning, commit `7c81e7d`) to claw back the
relational case, but that is a band-aid: a similarity threshold can never make
"who is my wife" reliably resolve to "Donna", because the relation lives in the
_graph_, not in the text overlap. The knowledge graph already models exactly
this — `Donna —spouse_of→ Victor` — and SABM already guarantees the edge is the
_currently-believed_ one. The involuntary path just never asks.

**Thesis:** for entity-shaped turns, resolve the entity in the graph and read its
current relationships directly. Structural match, no similarity gate, SABM-clean.

---

## 2. Design

A new **graph-anchored stage** inside proactive recall, ahead of the vector
probe. Cheap (no LLM, no embedding for the resolution step), additive, and it
degrades to today's behavior when the graph has nothing.

### Phase 0 — Relationship coverage (dependency, do first)

The facts exist as **crystals** ("User's wife is named Donna") but the typed
**edge** may not: SABM's deterministic extractor (`kg-relationship-extract.ts`)
currently covers a limited relation set (`located_at`, `belongs_to`, plus the
social subset `knows`/`manages`/`prefers`/`works_on`). Family/spousal relations
(`spouse_of`, `parent_of`, `child_of`, `sibling_of`) are likely **absent**, so a
naive graph lookup would find the entity but no edge.

- Extend the keyword table with family/identity relation patterns ("my wife",
  "my husband", "my mom/dad", "my son/daughter", "my partner").
- Backfill once over existing `world_fact`/`relationship` crystals so the graph
  reflects history, not just new sessions.
- **Acceptance:** after backfill, `Donna` resolves and `traverseEntity` returns a
  `spouse_of`/`married_to` edge to the user entity.

### Phase 1 — Entity-query detection (no LLM)

In `recallForUserTurn` (or a helper), detect entity-shaped turns cheaply:

- Interrogative-entity patterns: `who is X`, `what is X`, `who's X`, `tell me about X`.
- Possessive-relation patterns: `my (wife|husband|mom|...)`, `X's (wife|boss|...)`.
- Reuse the existing **heuristic decomposer** in `query-planner.ts` (capitalized
  noun runs + alias variants) to pull candidate entity surface forms — it already
  exists for SAGE and never makes an LLM call.

Skip the stage for non-entity turns (most messages) so there is zero overhead on
the common path.

### Phase 2 — Graph resolution (the core)

For each candidate surface form:

1. `kg.findEntityByNameType(name, type)` (with the existing case-insensitive
   fuzzy fallback) → entity, or resolve a possessive ("my wife") to the _relation_
   and read the user entity's edges of that type.
2. `kg.traverseEntity(entityId, /* currentOnly */ true)` → **SABM-valid edges
   only** (`valid_until IS NULL`). Superseded beliefs never surface.
3. Format each edge as a terse fact: `Donna — your wife` (from
   `relationship.type` + `connectedEntity.name` + direction), confidence from
   `relationship.weight` × corroboration (mention_count / belief reinforcements).

These facts **bypass the cosine `minScore` gate** — they are structural matches,
not similarity matches — and are ranked **ahead of** the vector-probe crystals.

### Phase 3 — Merge into proactive recall

- Graph facts fill the first slots of the `maxFacts` budget; the existing vector
  probe + zeigarnik + entity-snapshot stages fill the rest (deduped by entity).
- `formatProactiveFacts` confidence prefix: a corroborated graph edge is
  high-confidence by construction, so identity facts stop rendering as
  `(uncertain)` — directly fixing the "timid Donna" symptom.

### Phase 4 — Bitemporal awareness (optional)

When the turn carries past-tense / "used to" / "before" phrasing, route to
`kg.beliefAsOf(entityId, ts)` instead of the current edge, so "what was Donna's
job before" reads the historical belief rather than the present one. This is the
involuntary path inheriting SABM's point-in-time query for free.

### Phase 5 — Hormonal consistency (optional)

Keep parity with the SAGE reader: `oxytocin` lightly boosts social-relation edges
(`SOCIAL_RELATIONS` already defined in `structural-gate.ts`), so a warm session
surfaces relational facts a touch more readily — same modulation philosophy as
the deliberate path.

---

## 3. Integration points

| Concern                     | File                                        | Hook                                                   |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Where the stage runs        | `src/memory/proactive-recall.ts`            | new graph stage before §2 vector probe                 |
| Entry that has the KG       | `src/memory/manager.ts` `recallForUserTurn` | pass `this.knowledgeGraph` into `proactiveRecall(...)` |
| Entity resolve              | `src/memory/knowledge-graph.ts`             | `findEntityByNameType`, `findEntityById`               |
| Edge read (SABM-valid)      | `src/memory/knowledge-graph.ts`             | `traverseEntity(id, true)`                             |
| Point-in-time (Phase 4)     | `src/memory/knowledge-graph.ts`             | `beliefAsOf(id, ts)`                                   |
| Entity surface extraction   | `src/memory/query-planner.ts`               | heuristic decomposer (no LLM)                          |
| Relation coverage (Phase 0) | `src/memory/kg-relationship-extract.ts`     | extend keyword table + backfill                        |

`proactiveRecall(...)` gains an optional `kg?: KnowledgeGraphManager` param;
when absent (status/compaction calls) the function behaves exactly as today.

---

## 4. Why it respects the deployment

- **No new embedding/LLM on the hot path.** Resolution is SQLite lookups; the
  message is already embedded once for the vector probe.
- **No schema change.** Reuses `entities` / `relationships` and the SABM temporal
  columns. Phase 0 is a backfill, not a migration.
- **Additive + flag-gated.** Off by default; with the flag off, proactive recall
  is byte-for-byte today's behavior. Degrades to vector-only when the graph is
  empty.
- **SABM-correct by construction.** `currentOnly = true` means we can only ever
  surface the _currently-believed_ edge — graph-anchored recall cannot resurrect
  a superseded fact.

---

## 5. Tests

- `proactive-recall.graph.test.ts`: seed `Donna —spouse_of→ Victor`; assert "who
  is my wife" / "who is Donna" surface "Donna — your wife" **with no cosine gate**
  and **not** `(uncertain)`; assert a `valid_until`-closed edge does **not**
  surface; assert non-entity turns skip the stage (no graph call).
- `kg-relationship-extract.test.ts`: family/identity patterns produce the right
  typed edges (Phase 0).
- Regression: existing `proactive-recall.semantic.test.ts` unchanged (vector path
  intact when `kg` is absent).

---

## 6. Risks & open questions

- **Graph coverage is the gating risk.** If Phase 0 backfill misses a relation,
  the stage finds nothing and silently falls back to vector — acceptable, but the
  win only lands where edges exist. Measure edge coverage before/after.
- **Entity disambiguation.** Multiple "Donna" entities → rank by `mention_count` /
  recency; cap to the top edge to avoid prompt bloat.
- **Possessive resolution** ("my wife") needs the _user_ entity reliably present;
  confirm the self-entity exists and is linked.
- **Over-firing detection.** Keep the entity-query patterns conservative; when in
  doubt, skip the graph stage rather than inject a wrong structural fact (a
  confidently-wrong relation is worse than a miss).

---

## See also

- `docs/memory/sage-graph-memory.md` — the graph reader this borrows resolution from.
- `docs/memory/sabm-belief-adjudication.md` — the bitemporal guarantee that keeps edges current.
- `src/memory/proactive-recall.ts` — the path being upgraded.
- Commit `f5ed536` (proactive recall wiring) + `7c81e7d` (cosine gate tuning) — the work this supersedes for entity queries.
