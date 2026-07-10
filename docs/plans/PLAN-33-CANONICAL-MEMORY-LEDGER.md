# PLAN-33: Canonical Memory Ledger (seamless cold-start continuity)

**Status:** PHASES 0-3 LANDED (2026-07-10). Phase 0: gate hardening (cooldown
scoping, keyword fallback, vector reserve, hormonal decoupling). Phase 1: the
ledger (migration v33, CanonicalFactsStore, unconditional injection in all
three runners, memory_pin tool, identity seeding, retrievalHealth canonical
lane). Phase 2: automatic hot-path pinning — the session extractor emits
validated canonicalKey/canonicalValue fields and the ingest loop reconciles
them (source `extraction`, capped below explicit pins). Phase 3: the
`canonical_promotion` dream mode (cursor-idempotent, cortisol-gated,
reject-biased; pins at 0.6 with source `promotion`), source trust tiers
(background inference can strengthen but never supersede a deliberate pin),
and score-derived decay (`decayTick`, interval-independent) in the
maintenance cycle. All on by default behind `memory.canonicalLedger.enabled`.
Deviations from the draft: no regex keyword-shape routing (fuzzy auto-derived
keys are the user_preferences failure mode all over again — the extractor's
judged keys + dream promotion cover it with better ledger hygiene); the
confidence ramp is implemented as trust tiers + low entry confidence rather
than a source-conditional 0.8 cap. Phase 4 (dashboard pane, CANONICAL.md
mirror view, memory_search ledger-first) remains. Design notes below are the
original draft. Built from a verified code trace of the
2026-07-10 repo-identity recall failure (three parallel code-mapping passes
over `src/memory` + `src/agents`) plus a survey of how Letta, Mem0,
Zep/Graphiti, ChatGPT memory, LangMem, and the 2025-26 research crop
(MemoryBank, A-Mem, Hindsight, generative-agents reflection) solve the same
problem.
**Depends on:** session extractor (`src/memory/session-extractor.ts`),
user model (`src/memory/user-model.ts`), SABM bitemporal verbs
(`src/memory/knowledge-graph.ts`, PLAN-23), proactive recall
(`src/memory/proactive-recall.ts`, PLAN-27), dream engine + RLM working
memory rewriter (`src/memory/manager.ts:3538`), retrieval observability
(PLAN-28), bootstrap context assembly
(`src/agents/pi-embedded-helpers/bootstrap.ts`, `src/agents/endocrine-state.ts`).

## 0. Thesis

Bitterbot's continuity illusion is currently carried by the warm context
window, not by the memory rails. Every durable fact the user references
daily lives in one of two places: dream-synthesized prose that an LLM
rewrites (and is licensed to paraphrase and evict) every cycle, or crystal
chunks whose only route into a fresh session is a 0.45-cosine similarity
match against the user's first message. There is **no storage lane in the
system that guarantees a specific fact reaches a fresh session's context.**
The only unconditional structured injection is top-3 `identity`-category
preferences (name/role/location).

Every system in the field that actually solves cold starts has converged on
the same shape: a **small, size-capped canonical tier that is injected
unconditionally by identity (never fetched by similarity), maintained by
write-time reconciliation, and fed by background promotion from the episodic
store.** Letta core memory blocks, ChatGPT Model Set Context + Dreaming,
LangMem profiles, Zep user summaries, Claude Code's MEMORY.md index,
MemoryBank's user portrait. The two systems without this tier (Mem0, A-Mem)
exhibit exactly our failure mode.

The biological framing is exact, and it is the framing this product already
owns: this is **systems consolidation**. Episodic memory (hippocampal,
context-cued, similarity-retrieved) is not where a daily-load-bearing fact
should live after its Nth reactivation. Repeated reactivation is supposed to
transfer it to semantic memory (neocortical, schema-integrated, available
without a retrieval cue). Bitterbot has the episodic half and the
consolidation _machinery_ (dreams, spacing, reconsolidation, tagging) but
every strengthening mechanism is gated on _retrieval_, not on _re-mention_,
and there is no semantic destination tier. PLAN-33 builds the neocortex.

## 1. Verified failure analysis

The incident: on a cold start the agent misidentified the project repo, a
fact the user confirms almost daily. The agent's own postmortem ("the fact
was never pinned; prior correctness was warm-context recency") is confirmed
by the code, with more precision:

### 1.1 Write side: the fact structurally cannot crystallize

| #   | Drop point                           | Where                                                                     | Mechanism                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Mis-lane at extraction               | `manager.ts:3223-3229`                                                    | Only `epistemicLayer === "directive"` facts reach `user_preferences` (the one exact-match, dedup-and-strengthen store, which even has a `project` category at `user-model.ts:335`). "Repo is X" classifies as `world_fact` and bypasses it.                                                                                              |
| W2  | Duplication instead of strengthening | `manager.ts:3165`                                                         | Crystal dedup is by exact text hash. The extractor paraphrases the same fact differently each session, so daily mentions spawn new low-importance chunks instead of reinforcing one.                                                                                                                                                     |
| W3  | No graph representation possible     | `kg-relationship-extract.ts:223-242`, `relationship-mining.ts` allow-list | A1 requires a typed verb + 2 dictionary-typed entities; "the repo **is** Bitterbot-AI/bitterbot-desktop" yields one NER hit and an untyped copula, so every extractor returns null. Neither A1 nor A2 has any `is_a`/`named` relation; the KG cannot represent "entity X has name/slug Y" at all.                                        |
| W4  | Prose eviction                       | `working-memory-prompt.ts:153-160`, guard at `644-758`                    | The MEMORY.md rewriter is instructed to evict fading topics into `-> search:` pointers. Retention guards exist only for The Bond section; world_facts in Active Context / Crystal Pointers have zero retention protection. This is the observed paraphrase-around-the-fact symptom.                                                      |
| W5  | Repetition is misrouted              | `request-frequency-analyzer.ts:285-350`                                   | The one mechanism that notices user repetition converts a >=3x-repeated phrase into a _curiosity target_, never into a promoted/strengthened answer. All actual strengthening (access_count, spacing, reconsolidation, synaptic capture) fires only on `memory_search` retrieval, which never happens if the agent answers from context. |

Net: a never-searched world_fact sits at access_count 0, importance ~0.18,
decays on a ~6-day curve (`importance.ts:24-28`), and is eventually
soft-forgotten and purged by consolidation (`consolidation.ts:159, 548`).

### 1.2 Read side: thirteen silent gates on a cold first turn

The full trace is in the PLAN-33 research notes; the load-bearing ones:

| #   | Gate                                                                                                                                                           | Where                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| R1  | Hormonal state null drops the _entire_ proactive block                                                                                                         | `endocrine-state.ts:53-55`                                    |
| R2  | Query-embedding timeout on a cold process skips the whole vector branch (the 2026-06-22 wired-but-dead class)                                                  | `manager.ts:623-629`, `proactive-recall.ts:173`               |
| R3  | Cosine >= 0.45 required between first message and stored fact                                                                                                  | `proactive-recall.ts:205-208`                                 |
| R4  | Only `epistemic_layer IN (directive, world_fact, mental_model)` is queried; seeded MEMORY.md crystals have NULL layer and are unreachable                      | `proactive-recall.ts:184`, `seed-crystal-migration.ts:92-125` |
| R5  | `maxFacts=5` shared across stages; graph + identity can crowd out vector hits                                                                                  | `proactive-recall.ts:174-203`                                 |
| R6  | Cooldown map lives on the process-singleton manager: a "new" conversation in a warm process inherits suppression from the last 5 turns of the previous session | `manager.ts:795`, `proactive-recall.ts:154, 212`              |
| R7  | Graph stage surfaces family edges only                                                                                                                         | `proactive-recall-graph.ts:21-26`                             |
| R8  | The `recall-before-claim` interceptor is reactive (fires after the draft, on regex-matched assertion shapes only); it cannot pre-load first-generation context | `recall-before-claim.ts:54-69`                                |

R6 deserves emphasis: it is a second, independent explanation for
"works every day, failed on the fresh conversation." If the fact surfaced in
the prior session's final turns, the new conversation actively suppresses it.

### 1.3 The structural conclusion

Storage is retrieval-gated end to end; guaranteed presence exists only for
prose (MEMORY.md bootstrap, truncation-prone, LLM-rewritten) and top-3
identity preferences. Importance is orthogonal to similarity: canonical
facts are short, low-entropy strings that embed poorly against narrative
chunks, and at cold start the first message shares no embedding mass with
them anyway. No parameter tuning of thresholds fixes this class; the fix is
an architectural tier, not a floor adjustment.

## 2. What the field converged on

1. **Two-tier split.** Small, size-capped canonical tier injected
   unconditionally at t=0, addressed by identity/key, never by query
   similarity; large retrieval tier for the long tail. (Letta blocks,
   ChatGPT Model Set Context, LangMem profiles, Zep user summary,
   Claude Code MEMORY.md index.)
2. **Write-time LLM-arbitrated reconciliation.** New candidate facts resolve
   against near-neighbors at ingestion via a closed op set
   (ADD/UPDATE/DELETE/NOOP in Mem0; edge insert/update/invalidate in Zep).
   Write-time hygiene is what keeps the canonical tier small enough to
   inject unconditionally.
3. **Background consolidation promotes episodic to canonical.** Letta
   sleep-time agents, ChatGPT "Dreaming", LangMem background managers,
   generative-agents reflection. Promotion needs cross-session statistics a
   single conversation does not have. Bitterbot already has the dream
   engine; it just has no promotion destination.
4. **Supersession with temporal validity, not deletion.** Zep bitemporal
   `valid_at/invalid_at`; contradiction closes a validity window and keeps
   provenance. Bitterbot already built exactly this for the KG (SABM,
   PLAN-23); the ledger reuses it.
5. **Repetition must strengthen.** MemoryBank is the cleanest statement:
   per-memory strength incremented on every re-confirmation, Ebbinghaus
   decay otherwise. Bitterbot has the Ebbinghaus half; re-confirmation is
   currently a no-op (W2/W5).

## 3. Design: the Canonical Facts Ledger

One new lane with four verbs, grafted onto existing machinery. Biological
name if we want one: the **semantic ledger** (neocortical store); the
promotion job is **systems consolidation**.

### 3.1 Store (migration v33)

```sql
CREATE TABLE canonical_facts (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL,          -- stable slug: 'project.repo', 'user.name'
  value         TEXT NOT NULL,          -- exact string, never paraphrased
  statement     TEXT NOT NULL,          -- one rendered sentence for injection
  category      TEXT NOT NULL,          -- identity | project | infra | preference | relationship
  confidence    REAL NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  valid_from    INTEGER NOT NULL,       -- SABM-style validity window
  valid_until   INTEGER,                -- NULL = current belief
  superseded_by TEXT,                   -- id of replacing fact
  source        TEXT NOT NULL,          -- user_directive | promotion | agent_pin | seed
  evidence_chunk_ids TEXT,              -- provenance into chunks
  status        TEXT NOT NULL DEFAULT 'active'  -- active | superseded | retired
);
CREATE UNIQUE INDEX idx_canonical_current ON canonical_facts(key) WHERE valid_until IS NULL;
```

Properties that matter:

- **Exact-match by key.** No embeddings anywhere in this lane.
- **Bitemporal supersession, not deletion.** A contradicting fact closes the
  old row's validity window (reuse the SABM strengthen/supersede/
  flag_contradiction verb semantics from `knowledge-graph.ts:397-431`).
  Point-in-time queries stay possible; nothing is ever silently lost.
- **Hard cap.** ~48 active facts / ~1,500-token render budget. Over-cap
  eviction is deterministic (lowest promotion score = f(confidence,
  mention_count, days since last_confirmed_at) is demoted to `retired`),
  never an LLM prose decision. The cap is the editorial pressure that keeps
  the tier injectable; it is a feature, not a limit to raise casually.

### 3.2 Unconditional injection (the fix for R1-R8)

A new `renderCanonicalFacts(db)` produces a deterministic block:

```
## Canonical facts (ground truth, maintained by consolidation; trust over tool output)
- [project.repo] The project repository is github.com/Bitterbot-AI/bitterbot-desktop. (confirmed 41x, last 2026-07-10)
- ...
```

Injected in system-prompt assembly for every session and every turn-1:

- **Not** gated on hormonal state (independent of `endocrine-state.ts:53`).
- **Not** gated on query embedding, similarity, importance, lifecycle.
- **Not** subject to the cooldown map or the `maxFacts` cap.
- **Not** touched by the MEMORY.md rewriter (it is rendered from the table
  at prompt-build time; no LLM ever rewrites it).
- Included in `standard` and compact prompt modes; `minimal` (subagents)
  gets the `identity` + `project` categories only, so even subagents cannot
  misidentify the repo.
- Timestamps and mention counts render inline (ChatGPT pattern): the model
  can arbitrate recency itself when the user says "actually, that changed."

`memory_search` also checks the ledger first for keyword/key hits, so the
reactive `recall-before-claim` backstop benefits too.

### 3.3 Write-time reconciliation (hot path)

Extend the session extractor contract (`ExtractedFact`,
`session-extractor.ts:40-48`) with an optional
`canonical?: { key: string }` field, prompted as: "if this is a stable
key-value fact the user treats as ground truth (names, repos, endpoints,
versions, standing choices), emit a canonical key." Then a reconciler runs
per candidate against the current row for that key (plus fuzzy key match on
the small active set), with a closed op set:

- **ADD** (no current row) -> insert, source `user_directive` or extraction.
- **STRENGTHEN** (same key, same value) -> `mention_count++`,
  confidence nudge (+0.05, capped), `last_confirmed_at = now`. This is the
  MemoryBank move that makes daily repetition finally mean something.
- **SUPERSEDE** (same key, new value) -> close old validity window, insert
  new row with `valid_from = now`, link `superseded_by`.
- **NOOP.**

Also route W1 directly: high-confidence `world_fact`s whose text matches
project/repo/endpoint/identity shapes go through the same reconciler even
without the extractor flag (belt and suspenders for the exact incident).

### 3.4 Background promotion (systems consolidation, dream job)

A new dream-cycle job (alongside `relationship_mining`) that supplies the
cross-session statistics the hot path cannot see:

1. **Cluster promotion:** scan recent `world_fact`/`directive` chunks for
   near-duplicate clusters across >=3 distinct sessions (reuse the SNN
   0.82-0.92 band from `consolidation.ts:170-213`). A fact the user keeps
   restating in different words is exactly a promotion candidate; today it
   is pure waste (W2).
2. **Query-frequency promotion:** consume `request-frequency-analyzer`
   repeats and promote the _answer_ the agent gave (when consistent across
   sessions), not just a curiosity target (fixes W5). Curiosity targets stay
   for genuinely unanswered repeats.
3. **Decay/demotion:** active facts not confirmed in 90 days with
   `mention_count < 3` decay confidence per cycle; below 0.3 -> `retired`
   (still queryable, no longer injected). Ebbinghaus applies here too; the
   ledger must not become an append-only attic.

Promotions from dreams enter at `source='promotion'`, confidence 0.6, and
must be STRENGTHENed by a live mention before crossing 0.8. This keeps
dream-synthesized error from acquiring ground-truth authority, consistent
with the PLAN-21 slow-update posture.

### 3.5 Agent and user surface

- **`memory_pin` tool** (or `canonical` ops on the existing memory tool):
  `pin(key, value, category)`, `supersede(key, value)`, `list()`. "Remember
  this" from the user becomes a deterministic pin (source `user_directive`,
  confidence 0.95) instead of hoping extraction notices. This is Letta
  self-editing core memory, scoped to the ledger.
- **Audit surface:** the ledger renders read-only into the dream dashboard
  (next to `retrievalHealth`), and optionally mirrors to a
  `memory/CANONICAL.md` file for transparency. The file is a _view_, never a
  source; the table is authoritative (avoids the MEMORY.md rewrite hazard
  by construction).

### 3.6 MEMORY.md rewriter interaction

The rewriter prompt (`working-memory-prompt.ts:107-253`) gains one line of
context: the active canonical keys, with the instruction "these are
guaranteed present elsewhere; do not restate or evict-pointer them." MEMORY.md
stays the narrative/phenotype surface; exact facts stop competing for its
token budget. No retention guard needed for facts that no longer live there.

## 4. Phase 0: gate hardening (independent of the ledger, ship first)

Each of these is a small, high-value fix to the existing lane and stands on
its own even if PLAN-33 proper were rejected:

1. **Scope the recall cooldown per conversation** (fixes R6, the strongest
   proximate suspect for warm-works/cold-fails). Key the cooldown map by
   session/conversation id, or reset it when a new conversation starts.
2. **Decouple proactive recall from hormonal-state null** (R1): recall
   proceeds with default modulation when `hormonalState()` is null instead
   of dropping the whole block.
3. **Keyword fallback in the vector stage** (R2): when the query embedding
   is null/timed out on a cold process, run the FTS channel against the same
   layer/lifecycle/importance filters instead of skipping stage 2 entirely.
4. **Per-stage quotas** (R5): guarantee the vector stage >=2 of the 5 slots.
5. **Observability:** add a `canonical` layer counter to
   `RetrievalObservability` and `retrievalHealth()` so the dead-wire
   detector (PLAN-28 B3) covers the new lane from day one; add injection
   size + fact count to the `memory.recall` span attrs.

## 5. Phases

Per the standing rule, every phase lands fully wired, on by default, with
tests and doc updates (`how-the-memory-works.md`) in the same commit.

- **Phase 0 - Gate hardening.** Items in §4. Tests: cooldown-scoping
  regression (new conversation surfaces a fact recalled 2 turns ago in the
  prior session), hormonal-null recall test, embedding-null FTS fallback
  test.
- **Phase 1 - Ledger + injection + pin tool.** Migration v33, reconciler
  verbs as pure functions, `renderCanonicalFacts`, prompt wiring,
  `memory_pin`. Seed migration: current `identity` preferences with
  confidence >= 0.6, plus a curated handful (repo, gateway endpoints) via
  `source='seed'`. Kill switch: `memory.canonicalLedger.enabled`
  (default true).
- **Phase 2 - Hot-path reconciliation.** Extractor `canonical` field +
  keyword-shape routing + reconciler call in the extraction batch
  (`manager.ts:3162-3233`). Tests: ADD/STRENGTHEN/SUPERSEDE/NOOP paths,
  paraphrase-strengthens-not-duplicates (the W2 regression).
- **Phase 3 - Systems consolidation.** Dream promotion job (cluster +
  query-frequency), decay/demotion, PLAN-21-style confidence ramp. Tests:
  3-session paraphrase cluster promotes; dream-only fact stays below 0.8
  until live confirmation; stale fact retires.
- **Phase 4 - Surfaces.** Dashboard pane, `CANONICAL.md` mirror view,
  `memory_search` ledger-first hits, minimal-mode category subset.

**Acceptance test for the whole plan (the incident, mechanized):** an
integration test that cold-starts a fresh process and a fresh conversation
whose first message has no embedding overlap with the stored fact
("what happened with traffic yesterday?"), and asserts the rendered system
prompt contains the exact repo string, deterministically, across 20 runs.
That test failing is exactly the bug this plan exists to kill.

## 6. Non-goals and risks

- **Not a replacement for the crystal store, KG, or MEMORY.md.** The ledger
  is a ~1.5k-token semantic tier above them; episodic richness, graph
  traversal, and narrative identity stay where they are.
- **Not a general KG fix.** W3 (no `is_a`/`named` relation, person-biased
  NER) is real but orthogonal; the ledger covers the canonical-fact case
  without waiting on KG relation-vocabulary work. A follow-up can add a
  `named`/`is_a` relation and a `project` NER path if graph-side coverage
  is wanted.
- **Risk: ledger pollution.** Mitigated by the closed op set, the hard cap,
  the dream-promotion confidence ramp, supersession-not-overwrite, and the
  audit surface. The cap forces the same editorial pressure that makes
  Letta blocks and the Claude Code index work.
- **Risk: stale ground truth outranking reality.** Statements render with
  last-confirmed timestamps, and SUPERSEDE is a first-class verb; the
  failure mode degrades to "agent cites a dated fact with its date," which
  is visible and correctable, unlike silent absence.
- **Token cost:** ~1.5k tokens per prompt. That is the price every surveyed
  system pays for cold-start continuity; ChatGPT pays far more. Cheap
  relative to one wrong answer per day.

## 7. Why this preserves the product identity

The pitch has always been biological memory. This plan does not bolt a
config file onto an organism; it completes the consolidation story the
architecture already tells. Hippocampal episodic traces (crystals) that get
reactivated across sleep cycles (dreams) and repeated waking exposure
(mentions) transfer to a neocortical semantic store (ledger) that no longer
needs a contextual cue to be available. Retrieval-gated strengthening stays
for episodic memory, where it is correct; mention-gated strengthening is
added for semantic memory, where its absence was the bug. The continuity
illusion stops being an illusion precisely where the user needs it to be
real.
