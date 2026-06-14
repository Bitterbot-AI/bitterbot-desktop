# PLAN-24: HORMA Memory Scaffolding — Close the Organize→Diagnose→Evolve Loop

**Goal:** Build HORMA's contrastive organize→diagnose→evolve memory loop on Bitterbot's existing biological substrate, with provenance anchoring, deterministic construction-vs-retrieval blame attribution, and a self-evolving construction prompt under the SICA validation gate HORMA lacks — gated behind a hard LongMemEval proof. Differentiation comes from binding every stage to hormonal/GCCRF state, a moat no surveyed system has.

**Status:** Draft. Approved for phased implementation 2026-06-12.

**Source review:** `docs/reviews/horma-memory-mapping-2026-06-12.md` (HORMA = arXiv 2606.11680, Duke + Snowflake, 2026-06-10; 23-agent mapping, 14 adversarially verified proposals).

---

## Context

HORMA ("Organize then Retrieve") shows that for long-horizon agents, **memory construction quality dominates retrieval quality** (their cross-backbone ablation: a weak memory-manager cannot be rescued by a strong retriever), and that the way to improve construction is a contrastive failure→rule→prompt loop where every stored note carries a **provenance pointer** back to the raw trajectory. The result: equal-or-better accuracy at 3–22% of baseline tokens, and a +9 to +22 point lift from skill evolution alone.

Bitterbot already has the substrate HORMA's own limitations call for — a bitemporal SAGE graph, the dream engine as an off-critical-path memory manager, the SICA staging/sandbox validation gate (which HORMA lacks), and hormonal/GCCRF modulation. But it is missing three things HORMA proves are load-bearing:

1. **Provenance.** LLM-extracted facts insert with `start_line=0, end_line=0` (`manager.ts:2399-2400`); dream insights are pure paraphrases. The PLAN-16 event journal — the real raw-trajectory store — has **zero references from anywhere in `src/memory`**. A wrong paraphrase is permanently load-bearing with no path back to ground truth, including during reconsolidation's labile-window rewrites.
2. **Blame attribution.** Bitterbot detects _that_ recall failed (judge, outcome-backfill, graph-bridge) but never whether **construction** or **retrieval** is at fault — HORMA's central D_exo/D_end diagnostic.
3. **An evolving construction prompt.** `buildExtractionPrompt` (`session-extractor.ts:74`) is static; nothing closes a failure→rule loop on memory construction (the existing textual-gradient machinery only targets skill mutations).

**Outcome:** a memory system that organizes with provenance, diagnoses its own construction vs retrieval failures, and rewrites its construction rules under validation — plus a HORMA-comparable benchmark table for the arXiv preprint flagged as top leverage in the competitive analysis (`docs/reviews/competitive-analysis-2026-06-10.md`).

## Phasing & sequencing

```
P0  Evidence pointers (provenance foundation)          [sound, high]   ─┐
P0.5 Populate SAGE relationship layer (PLAN-23 Ph.0)   [high]          ─┤ foundation
P1  Coverage discriminator (deterministic blame router)[needs-rev, high]┘
            │ produces construction_feedback stream
            ▼
P2  LongMemEval contrastive bootstrap + proof   ◄── HARD GO/NO-GO GATE  [sound, high]
            │ (also yields offline construction_feedback + preprint numbers)
            ▼
P3  Versioned memory-architect skill (textual gradient descent) [needs-rev, high]
            ▼
P4  Hormonally indexed rule activation (the moat)               [sound, small]

Track B (parallel, unblocked by P0.5):
P5  Graph abstraction nodes + coarse-to-fine traversal         [sound, large]
```

Each phase is independently shippable behind a flag. **P2 is a decision gate:** if structured construction shows no win on temporal/multi-session question types, stop before building P3/P4.

Migration numbering (current schema = v16): **v17** = P0 `evidence_refs`; **v18** = P5 summary entities. P0.5 and P1 are code-only (no migration). PLAN-23's own transaction-time axis is _not_ folded in here — only its Phase 0 population step is pulled forward.

---

## Phase 0 — Evidence pointers (provenance foundation)

**Goal:** every extracted fact and dream insight is anchored to its raw source; the agent can expand a compact memory back to verbatim ground truth on demand.

**Files:**

- `src/memory/migrations.ts` — migration **v17**: `ensureColumn(db, "chunks", "evidence_refs", "TEXT")` (JSON array; null-tolerant).
- `src/memory/session-extractor.ts` — feed a **line-numbered** transcript into `buildExtractionPrompt` (line 74); add a per-fact citation requirement to the output schema (HORMA's `(D1:3)` trick); extend `ExtractedFact` (line 24) with `evidence: EvidenceRef[]`. Define `EvidenceRef = {kind:'session', path, line} | {kind:'journal', runId, seq}`.
- `src/memory/manager.ts` — at the fact insert (`runSessionExtraction`, ~line 2389) persist `evidence_refs` instead of the current `0,0` line columns; mirror at the handover-brief insert (~line 2468) and dream-insight inserts (origin='dream').
- `src/infra/event-journal.ts` — add `getByRunSeq(runId, runSeq)` exact lookup (the existing `query({runId, sinceSeq})` is the near-equivalent; thin wrapper). Resolver must tolerate missing rows (`deleteTask` purges on task cleanup; journal is a separate DB, disableable via `BITTERBOT_EVENT_JOURNAL=0`).
- `src/agents/tools/memory-tool.ts` — **new `memory_expand` tool** (sibling of `memory_search`/`memory_get` at lines 39/94). Resolves an `evidence_ref`: session refs via `remapChunkLines` (`internal.ts:259-268`); journal refs via `getByRunSeq` + gunzip. Path-traversal guarded. Do **not** loosen `manager.readFile`'s `.md`-only gate (`manager.ts:1251`); `memory_expand` is the dedicated raw-access surface.
- `src/memory/reconsolidation.ts` — faithfulness check: before committing a labile-window rewrite (window from `RECONSOLIDATION_DEFAULTS.labileWindowMs`), re-verify the mutated text against the chunk's `evidence_refs`; reject drift. This is HORMA's anti-confabulation guarantee applied to bitterbot's reconsolidation.
- `src/memory/knowledge-graph.ts` — extend `recordBelief`/edge `evidence_chunk_ids` so graph edges also resolve to raw refs (free once facts carry them).

**Verifier corrections honored:** session extraction runs on **flattened transcript files** (no `run_id`/`seq`) → line-numbering yields session refs directly; journal refs require correlating via `event_log.session_key`. The event journal has **no user-message stream** (only lifecycle/assistant/thinking/tool/…), so user-turn citations resolve to session refs, not journal refs. `MemorySearchResult` (`types.ts:12-21`) exposes no chunk id — `memory_expand` keys on `path+source+line-range` or crystal id.

**Tests:** extraction emits citations; `evidence_refs` round-trips through v17; `memory_expand` resolves both ref kinds and degrades on missing/purged refs; reconsolidation rejects an evidence-contradicting mutation.

**Flag:** `memory.provenance.enabled` (default true).

---

## Phase 0.5 — Populate the SAGE relationship layer (PLAN-23 Phase 0, pulled forward)

**Goal:** the relationship table is actually written to. Today `manager.ts:2499` initializes `kgRelationships = []` and passes it empty to `ingestExtraction` (`manager.ts:2527`) — the entire graph relationship layer is never populated, which both blocks P5 (community detection needs edges) and starves P1's endogenous-failure signal.

**Files:**

- `src/memory/manager.ts` — fill `kgRelationships` before the `ingestExtraction` call (~2499/2527): pair co-occurring extracted entities with a heuristic `relationType` (default `related_to`; refined by entity-type pairs, e.g. person+project → `works_on`). Conservative — emit only high-confidence pairs, everything else low-weight `related_to`.
- Reuse `knowledge-graph.ts` `upsertRelationship` (existing).

**Scope note:** this is _only_ PLAN-23 Phase 0. The typed conflict taxonomy, transaction-time axis, and belief-history API remain PLAN-23's own effort. Carry edges' `evidence_chunk_ids` from P0 so populated edges are provenance-resolvable from birth.

**Test:** `manager.kg-relationships.test.ts` — a fixture turn with two co-occurring entities yields a written relationship.

**Flag:** `memory.kgRelationships.populate` (default true).

---

## Phase 1 — Coverage discriminator (deterministic blame router)

**Goal:** at recall-failure time, deterministically (no LLM) decide whether a fact was never constructed (exogenous) or constructed-but-not-retrieved (endogenous), and route each to the right learner. This **defines the `construction_feedback` stream** that P2/P3 consume, and makes the (deferred) LLM probe cheap by only firing on cases this can't resolve.

**Files:**

- New `src/memory/coverage-diagnostics.ts`, wired at the post-search path (`manager.ts:788-805`, next to `recordSageSignals`) plus a recall-failure hook.
- Failure trigger: extend `src/agents/skills/outcome-backfill.ts` (currently PLAN-20 intervention-record scoped) to catch memory corrections, or add a parallel hook at its `chat.send` site.
- Deterministic scan: ephemeral in-memory FTS5 over recent session JSONL + journal payloads, or a plain term-presence scan. **Not** `manager-search.ts:244-305` (`searchKeyword` only hits the indexed chunks FTS, which is exactly what we're testing against).
- Three-way routing: (a) terms in raw transcripts but absent from `chunks` → `construction_feedback` record (memory_audit_log event type — schema `memory-schema.ts:104-111` already has free-form event+metadata, no migration); (b) present in chunks but not surfaced → insert `(query, ground_truth_chunk_id)` into `graph_gate_training_pairs` (`graph-optimizer.ts` `insertTrainingPair`) **only on a high-confidence unique match, replicating the live search's per-model/source filters** to avoid label noise; (c) found nowhere → curiosity target via `EpistemicDirectiveEngine.harvestGraphBridgeTargets`.

**Verifier corrections honored:** the success-only training-pair collector is `manager.ts recordSageSignals` (10% sample, top-_returned_ chunk), **not** `experience-signal-collector.ts` (that's P2P telemetry). The exogenous class arises specifically from what `buildSessionEntry` drops before indexing (tool results, non-text blocks, redaction, sync lag) — name these loss channels. If `construction_feedback` consumers (P3) aren't built yet, records still accumulate harmlessly.

**Tests:** a fact present in raw JSONL but dropped by `buildSessionEntry` is classified exogenous; a present-but-unranked chunk is classified endogenous and yields one clean training pair; an absent term yields a curiosity target.

**Flag:** `memory.coverageDiagnostics.enabled` (default true).

---

## Phase 2 — LongMemEval contrastive bootstrap + proof ◄ GO/NO-GO GATE

**Goal:** prove the construction thesis where ground truth exists, produce the offline `construction_feedback` corpus that seeds P3 (avoiding cold-start), and generate the HORMA-comparable Table-2 row for the preprint.

**Files:**

- `benchmarks/longmemeval/runner-biological.ts` / `runner.ts` — add an **H condition** (full chronological transcript in context) alongside the existing H' (real ingest→extract→retrieve pipeline). Partition results into D_exo (H right, H' wrong) and D_end (H' right, H wrong).
- Reuse `evaluate.ts` (gold-answer judge) and `bootstrapPairedCI` (`experiment-sandbox.ts:679-708`) for significance.
- Reuse `loadDatasetSplit` 20/10/70 (`adapter.ts:268-282`): **train** = refinement corpus, **selection** = validation gate, **test** = never touched (keeps published numbers contamination-free).
- Run the HORMA-style LLM feedback step (ported D.4/D.5 prompts) over D_exo/D_end → write `construction_feedback` records (same shape P1 emits) for P3.
- Report per-question L-J score **and tokens/question** — directly comparable to HORMA Table 2 (their 55.9 @ ~308 tokens).

**Verifier corrections honored:** local datasets hold **500** instances (not 367). The adapter's combined-document mode is an _ingestion_ path; the H condition needs a small new runner branch reading `sessions.md` straight into the prompt. Score new-prompt extractions carefully — don't condition the label set only on facts the _old_ prompt extracted (structural bias toward the incumbent).

**Gate criterion:** material win on temporal-reasoning / multi-session question types at lower tokens. If not met → stop; ship P0/P0.5/P1 and revisit.

**Flag / deliverable:** a `results/horma-comparison-*.json` + a short results note for the preprint.

**Status — GATE PASSED 2026-06-14** (`benchmarks/longmemeval/runner-contrastive.ts`, `contrastive-partition.ts`).

- First probe (N=12 oracle/train, temporal-only; note `docs/reviews/horma-phase2-contrastive-2026-06-13.md`): token efficiency 30.9% of baseline replicated, but accuracy near-parity on the short oracle haystacks left the accuracy-win half **inconclusive**.
- **Stratified `_s` run (N=18 train, 3 per type, all 6 types; H budget 50k tokens; note `docs/reviews/horma-phase2-s-stratified-2026-06-14.md`): H' 72.2% vs H 27.8% (a 44-point win) at 5.1% of the tokens (~20x).** Ledger D_end 9 / D_exo 1 — near-zero net construction losses. H' wins or ties every type except temporal-reasoning (0/3, the honest weak spot and the lone D_exo, now a Phase 3 feedback signal). On the long-haystack lost-in-the-middle regime the full HORMA thesis reproduces.
- **Gate: PASS on this sample.** Not yet a publication number (train split, 50k-budget H, small per-type N) — next milestone is a held-out test-split run with baselines (Mem0, embedding retrieval) + work on the temporal weak spot.

---

## Phase 3 — Versioned memory-architect skill (textual gradient descent)

**Goal:** make `buildExtractionPrompt` evolve from accumulated construction failures, under the SICA validation gate HORMA lacks (HORMA Eq. 5: `P_m^(k+1) = LLM(SkillAug, P_m^(k), {Feedback})`).

**Files:**

- `src/memory/session-extractor.ts` — `buildExtractionPrompt` gains a `## Learned Construction Rules` section loaded at extraction time. Treat the current static template as `P_m^(0)`.
- New `skills/memory-architect/SKILL.md` — the evolving rule library, versioned through the SICA filesystem pipeline (`skill-storage.ts` skills-staging/skills-archive, `skill-gate.ts:103-218`, `skill-promote.ts`).
- `src/memory/dream-slow-update.ts` — every K dream cycles, aggregate `construction_feedback` (P1 online + P2 offline), run one TextGrad step → candidate rule set → `skills-staging/memory-architect/`.
- Validate via `experiment-sandbox.ts`: re-extract held-out archived **session files** (`listSessionFilesForAgent` + `buildSessionEntry`) old vs new prompt; score recall of probe-confirmed/cited facts; promote only when `bootstrapPairedCI` `ci95Low > 0`.

**Verifier corrections honored (critical):** bitterbot has **two** skill pipelines — the SICA **filesystem** archive and the dream-mutation **DB** (`skill_text_history`). `runLongitudinalRegression` (`dream-slow-update.ts:495-545`) reads the DB table, _not_ `skills-archive/`; it does take injectable `archiveVersions` + `scorePair`, so feed it filesystem versions + a re-extraction scorer (**new wiring, not free**). There is **no auto-rollback** — `rollbackToVersion` (`skill-promote.ts:232`) is manual; a bad rule that passes the gate needs the manual path. Held-out sessions live as **files**, not in the event journal. The skill-gate regression gate is a no-op for memory-architect (never executed as a skill) — only schema + injection gates apply.

**Tests:** a synthetic D_exo cluster ("entity identity paraphrased away") yields a rule that, re-applied, raises held-out recall and passes the CI gate; a rule that regresses held-out recall is rejected and archived.

**Flag:** `memory.architectEvolution.enabled` (default true; the validation gate is the safety mechanism).

**Status — landed 2026-06-13.** Implemented as a DB rule store (`construction_rules`, migration v18) rather than a SICA `SKILL.md` (the verifier flagged the SICA regression gate is a no-op for a never-executed-as-skill rule; a table is cleaner and carries the Phase 4 birth-hormone columns). `src/memory/memory-architect.ts`: harvest `construction_feedback` → LLM propose (textual gradient) → `validateCandidates` (re-extract held-out sessions old-vs-new, paired-bootstrap on faithful-cited-fact delta, promote only if not significantly worse) → inject `activeRuleTexts` into `buildExtractionPrompt`. Wired into the dream cycle (`maybeRunArchitectCycle`, 6h cooldown, ≥5 feedback gate) before extraction; rule injection active by default. 16 new tests (memory-architect + v18). The win-proof on gold labels (Phase 2's `bootstrapPairedCI`) remains the offline path; the online gate is a no-regression guardrail.

---

## Phase 4 — Hormonally indexed rule activation (the moat)

**Goal:** activate construction rules by organism state instead of always paying their full token cost — the differentiation HORMA structurally cannot express (their skill prompt grows monotonically and fires unconditionally).

**Files:**

- `src/memory/session-extractor.ts` — replace the 3 static `buildHormonalGuidance` lines (`session-extractor.ts:56-68`) with centroid-distance rule selection: inject the top-k rules whose birth-centroid is nearest the current hormonal/GCCRF snapshot, plus unconditional rules. The existing `delta_eff = base − 0.4·cortisol + 0.4·dopamine` law (`structural-gate.ts:212-220`) sets _how many_ fire (stressed → fewer/focused; aroused → wider).
- Rule birth-context tagging: reuse `bindBiologicalContext` k-means (`dream-slow-update.ts:266-325`) — the centroid of the failure cluster that bred each rule is computed at P3 rule-creation time.
- Snapshots from `hormonal.ts` (`snapshot`) and the GCCRF diagnostics aggregate used by interceptors (`state-snapshots.ts buildGCCRFSnapshot`).
- Rule metadata (centroid fields) stored in `skills/memory-architect/SKILL.md` frontmatter — small parser extension to `frontmatter.ts` (the PLAN-20 interceptor stats-array pattern is the precedent, not generic support).

**Verifier corrections honored:** `bindBiologicalContext` centroids are **hormone-only 3-D** today; a GCCRF centroid is a trivial mean over the per-member snapshots already on `OutcomeTrajectory` (`dream-slow-update.ts:200`) but is not computed yet. GCCRF `iAlpha` is per-chunk — needs a session-level aggregate like the interceptors use.

**Concrete dynamics:** high cortisol → verbatim-preservation + error-chain rules; high dopamine → cross-referencing + retrieval-path-redundancy rules; high GCCRF novelty → negative-evidence + provenance rules (confabulation risk peaks in unfamiliar domains).

**Tests:** identical session extracted under high-cortisol vs high-dopamine snapshots activates different rule sets; rule count tracks `delta_eff`.

**Flag:** folds into `memory.architectEvolution.enabled`.

**Status — landed 2026-06-13.** `selectRulesForState` (`memory-architect.ts`): rules carry the hormonal centroid they were promoted under (the `birth_*` columns), and the manager injects the state-nearest rules with the count modulated by the inline cortisol-narrows/dopamine-widens width (mirrors `effectiveDelta`). Unconditional rules (no birth context) always included. Wired into `runSessionExtraction` (replaces the unconditional `activeRuleTexts`). 3 tests (no-state cap, cortisol<dopamine count, distance ranking). GCCRF centroid deferred (hormone-only 3-D for now, as the verifier noted).

---

## Phase 5 — Graph abstraction nodes + coarse-to-fine traversal (parallel track)

**Goal:** give the SAGE graph the hierarchy HORMA's O(log N) navigation requires; replace the flat 200-entity frontier cap with coarse-to-fine descent. Unblocked by P0.5.

**Files:**

- `src/memory/migrations.ts` — migration **v18**: `entities` gains `entity_type='summary'` support + `parent_entity_id`; relation type `summarizes`.
- New `src/memory/dream-modes/graph-abstraction.ts` — the **10th** dream mode. When FSHO order parameter R > 0.7 (`dream-oscillator.ts:114-167`, coherent/compression regime), run cheap label-propagation community detection over `relationships`; for each community ≥ k entities, LLM-synthesize one summary entity whose `summarizes` edges carry the **union of member `evidence_refs`** (provenance from P0). Register in `DreamMode` union (`dream-types.ts:12-21` — currently 9 modes), `DEFAULT_MODE_CONFIGS`, `DEFAULT_MODE_TIERS`, `selectModes` (`dream-engine.ts:683-717`), and the `runMode` dispatch (~986); fix the stale "7 modes" doc comment.
- `src/memory/graph-reader.ts` (`graphRead`, 288-462) — coarse-to-fine: when `resolveSeedEntities` finds no exact match, seed at summary level, propagate one hop among summaries, descend into top-m communities. Needs a concrete summary-selection mechanism (embed summary abstracts, or fuzzy-match via `kg.searchEntities`) since entities carry no embeddings.
- `src/memory/graph-topology.ts` (`computeEdgeFeatures`, 171-189) — optional 9th gate feature (hierarchy-level delta); the CMA-ES-lite optimizer (`graph-optimizer.ts`) re-learns when descent pays.

**Verifier corrections honored:** `entities` are **not** bitemporal (only relationships v13 + chunks are) → re-abstraction supersedes via `valid_until` on the `summarizes` **edges**, not summary rows. Adding the 9th gate feature changes `INPUT_DIM` and **discards the learned gate genome** (`deserializeGate` re-inits) + invalidates cached `gate_features` BLOBs — a retraining cost; make the feature opt-in so the existing genome survives if deferred. `graph-optimizer` is "CMA-ES-lite (Gaussian random search)", not full CMA-ES.

**Tests:** a synthetic populated graph produces summary entities for communities ≥ k; a query with no exact entity match seeds at summary level and returns members via descent; re-abstraction supersedes prior summary edges without destroying history.

**Flag:** `memory.graphAbstraction.enabled` (default true).

**Status — landed 2026-06-13.** Migration v19 (`entities.parent_entity_id`); `EntityType += 'summary'`, `RelationType += 'summarizes'`. `src/memory/graph-abstraction.ts`: synchronous label-propagation community detection + LLM summary synthesis + `summarizes` edges + parent pointers (idempotent — already-parented communities skipped). Wired as a dream-cycle hook (`maybeRunGraphAbstraction`, 6h cooldown, ≥6-relationship gate) rather than a formal 10th DreamMode (simpler/safer; same effect). Reader coarse-to-fine: `resolveSummarySeeds` in `graph-reader.ts` fires only when the flat seed resolver is empty (additive — cannot regress the normal path), descending from summary name/abstract matches into members. 11 tests (community detection, summary parse, build + idempotency + min-size, reader fallback, v19). The 9th gate feature and edge-level re-abstraction supersedence are deferred (the current builder skips already-summarized communities rather than versioning them).

---

## Deferred (out of this plan; noted for follow-up)

- **memory_navigate** virtual-FS retrieval [large] — position against the existing `deep_recall` RLM (it already does iterative per-step recall over flat text); only build if P2 proves the navigation thesis.
- **Budget-aware early-stop recall** [medium] — needs a new per-session token-pressure registry + citation detection (parse `decorateCitations` `Source: path#L` strings).
- **Incremental in-session T_F extraction** [medium] — needs a user-message stream added to the journal first; current win is latency, not capability (extraction already runs mid-session at dream cadence via `runSessionExtraction`).
- **Contrastive recall probe dream mode** [large] — the LLM version of P1; run only on cases P1 can't resolve deterministically.

## Verification (end-to-end)

1. **Unit/integration:** `pnpm test` for each phase's new test file (match existing density: PLAN-16 shipped 87, PLAN-17 127, PLAN-18 59 tests).
2. **Provenance round-trip (P0):** run a session through extraction, call `memory_expand` on a returned fact, confirm it resolves to the verbatim source line/event.
3. **Blame routing (P1):** seed a fact that `buildSessionEntry` drops, query for it, assert a `construction_feedback` exogenous record; seed a present-but-unranked fact, assert a clean `graph_gate_training_pairs` row.
4. **Proof gate (P2):** `pnpm tsx benchmarks/longmemeval/runner-biological.ts` with the H/H' branch on the **selection** split; inspect the L-J + tokens/question table vs HORMA Table 2.
5. **Evolution (P3/P4):** run N dream cycles over the P2 feedback corpus; confirm a rule lands in `skills-archive/memory-architect/` only after passing the CI gate; confirm extraction under different hormonal snapshots activates different rule sets.
6. **Hierarchy (P5):** on a P0.5-populated graph, trigger a high-R dream cycle; confirm summary entities appear and `graphRead` descends coarse-to-fine.
7. **Gateway smoke:** full `pnpm build` + `pnpm start gateway` (production config, per repo convention) — confirm no migration/boot regressions.

## Notes

- `construction_feedback` (a `memory_audit_log` event type) is the spine connecting P1 → P2 → P3; design its JSON shape once (HORMA D.6 schema: `comparison_type`, `winning_method`, `skills[].memory_prompt_improvement`, `root_cause_summary`) and reuse across all three.
- Related plans: PLAN-18 (SAGE graph), PLAN-23 (SABM — P0.5 pulled from its Phase 0), PLAN-21 (validation gate / slow update), PLAN-16/17 (event journal as raw-trajectory store), PLAN-20 (interceptor state snapshots).
