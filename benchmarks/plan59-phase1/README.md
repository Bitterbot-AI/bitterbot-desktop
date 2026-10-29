# PLAN-59 Phase 1 pilot: gain x need consolidation on forked stores

A development and qualification pilot for the first PLAN-59 mechanism:
selecting bounded, reversible memory operations by estimated future benefit
and comparing that selection against the same operations chosen by recency or
at random, every arm on its own fork of one sealed snapshot of a node's real
memory store. The live store is never written. The pilot fixes the sample
size for a later, separately frozen collection; it is not that collection and
was not externally preregistered.

The result of the run on 2026-10-29 is in `docs/research/plan59-phase1-pilot.md`
and in `results/`: a negative pilot. One of 130 candidate clusters co-surfaced
for the development questions at the lowered bar, below the floor of five, so
the arm run stopped by rule and no contrast was computed.

## What the harness does

1. **Snapshot** (`snapshot.mts`). `--copy-from` opens the live store READ-ONLY
   and takes a `VACUUM INTO` copy into scratch; `--db` copies an existing copy.
   The manifest beside it records SHA-256, chunk count, lifecycle counts,
   created time and commit. Output anywhere under `~/.bitterbot` is refused.
2. **Questions**. `benchmarks/live-recall/make-questions.mts` writes one
   question per sampled chunk (the chunk id is the gold label) under a fixed
   seed. The file paraphrases private memory: it lives under
   `~/.bitterbot/benchmarks/live-recall/` with mode 0600, is never committed,
   and only its hash and counts appear here.
3. **Partition** (`partition.mts`, `partition.ts`). A family is the gold
   chunk's `path` (one session transcript or memory file). Families are ordered
   by `sha256(seed:path)` and cut 50 / 25 / 25 into development,
   qualification and final; every question of a family lands in one split.
   `<questions>.partition.json` holds chunk ids, family hashes, seed and counts
   only. The final split is never read by estimation or selection; the runner
   refuses to score it unless `--final --freeze <sha256>` names a protocol file
   that contains `status: frozen` and hashes to that value. The path is
   implemented and tested and the pilot does not use it.
4. **Operations** (`operations.ts`), applied on forks only:
   - `consolidate_cluster`: connected components over `near_merge_hints`
     pairs at `base_similarity >= 0.85` among live chunks (lifecycle
     `generated` or `activated`, `parent_id` null), capped at six members by
     weighted degree. A cluster qualifies when at least two members sit in
     the fused top 5 of at least three development queries (two when fewer
     than eight clusters qualify; the runner records which bar it used).
     Applying it inserts one new chunk whose text is the members' texts joined
     by a separator (no LLM rewriting), embedded with the normal provider,
     `parent_id` null, importance = max over members, access_count = sum,
     lifecycle `generated`. Members get `parent_id` = the new id, lifecycle
     `consolidated`, `hygiene_done` = 1, importance halved, and their rows are
     removed from `chunks_vec` and `chunks_fts`. Members are never deleted;
     their text and embedding stay in `chunks`, so the operation is reversible.
   - `bound_validity`: for each canonical fact with `superseded_by` and
     `valid_until` set, set `valid_time_end = valid_until` on the chunks in
     its `evidence_chunk_ids` where it is null. No text changes; reversible.
   - Re-embedding does not apply on this store: every indexed chunk carries
     `text-embedding-3-small` and the live provider is that model, so there is
     no model or index change to re-embed after. `describeReembed` reports this
     from the data and the result file records it.
   - Every operation returns a quoted cost (chunks touched, embedding calls,
     estimated ms) and the apply step records the realised one. Dollars,
     seconds and calls are reported separately in the result file.
5. **Estimation** (`estimate.ts`), development partition only:
   - need(k) per family = sum over chunks of `access_count` decayed from
     `last_accessed_at` with a 30-day half-life, plus the number of development
     queries with a chunk of k in the fused top 5, plus 1 per development query
     whose gold is in k and whose fused rank is above 10 or missing. Phase 0
     `retrieval_hits` are added, decayed the same way, when the table exists
     and has rows; on this snapshot it is empty, so the access prior carries.
     The plan's first-order session-transition term is deferred: it needs
     stable topic ids and real session boundaries from the Phase 0 telemetry,
     which has not yet run in a deployed build.
   - gain(op | k) = mean change in parent-mapped reciprocal rank over the
     development queries affected by the operation (gold in a touched family,
     or a touched chunk in the baseline top 10) whose gold is in k, measured by
     forking the snapshot, applying only that operation, and re-running those
     queries. Capped at the 40 highest-need candidates.
   - `priority(op) = sum_k need(k) * gain(op | k) / cost(op)` with
     `cost = 1 + chunks touched + 2 * embedding calls` (weights fixed in
     `COST_WEIGHTS`, reported in the result file).
6. **Arms** (`arms.ts`, `run-pilot.mts`). K = 20 or the number of qualifying
   candidates if fewer, the same K for every arm. Each arm is a fresh
   `VACUUM INTO` fork of the sealed snapshot; no arm inherits another's edits.
   `unchanged` (nothing), `recency` (the K candidates whose chunks were most
   recently accessed), `random` (K under a recorded seed), `prioritised`
   (top K by priority), `shuffled_batch` (the prioritised set in a seeded
   random order, charged the prioritised arm's selection cost).
7. **Scoring** (`scoring.ts`, `harness.ts`). Every arm is scored on the
   qualification partition with the `benchmarks/live-recall/run.mts` method:
   the normal `MemoryIndexManager` on the fork, hybrid RRF, `maxResults` 50,
   every background engine off, recency boost off, hormonal state off, evidence
   telemetry off, wall clock frozen at the snapshot time. Query embeddings are
   memoised in-process by text, so each question is embedded once and every
   arm sees the same vector. Per query: fused rank, parent-mapped rank,
   per-channel ranks, latency, plus per-arm storage delta. Primary contrast:
   MRR prioritised minus recency, paired by family, with a percentile
   bootstrap 95 percent interval over families (2,000 seeded resamples).
   Secondaries: against random and unchanged, R@5, coverage (gold in top 10),
   a wrong-answer proxy (top-1 on a different path than gold), latency,
   storage. The family is the inferential unit.
8. **Output**. `results/<timestamp>.json` holds ids, hashes, ranks and numbers
   only, plus a short `.md` summary. Forks are deleted unless `--keep`.

## What search does with lifecycle, parent_id and valid_time_end on main

The demotion design above depends on this, so it is stated here. On the
commit under test (`ecc86c07`):

- Neither the vector channel (`searchVector`, KNN over `chunks_vec` joined to
  `chunks`) nor the keyword channel (`searchKeyword` over `chunks_fts`) filters
  on `lifecycle`, `lifecycle_state`, `parent_id` or `valid_time_end`. A chunk
  is retrievable exactly when it has a row in those index tables.
- `archived` merge losers and `expired` chunks leave the index only when the
  consolidation purge deletes their `chunks_vec` and `chunks_fts` rows after a
  grace period (`lifecycle_state = 'forgotten' OR lifecycle = 'expired'`).
- `consolidated` is the lifecycle the PLAN-40 Lane 2 merge writer gave demoted
  members (with `hygiene_done` = 1, `parent_id` set and index rows removed);
  the indexer's re-index carry-over preserves exactly that state so a
  re-index does not resurrect them. The 22 `consolidated` chunks on the
  snapshot are those members. The consolidation step on main marks its merge
  winner `consolidated` and its loser `archived`.
- `valid_time_end` is read by `temporal-filter.ts` (used by the knowledge
  graph) and by the curiosity researcher, not by the search channels or the
  post-fusion boosts. `bound_validity` therefore cannot change a fused rank on
  this commit; it is carried as a correctness operation with zero measured
  gain, and the pilot says so rather than dropping it.

Consequently the pilot's demotion removes the members' index rows, which is
the only way a demotion is visible to search on this commit, and keeps every
other column reversible.

## What can and cannot transfer from development to qualification

Operations are family-local (every `near_merge_hints` pair on this store is
same-path). A cluster in a development family can change a qualification
query's outcome only through interference: its members occupying result slots
for queries in other families. A cluster in a qualification family changes
those queries directly (members hidden, parent competing), and its gain was
estimated only on development queries. Both effects are what the design
measures; the pilot reports them without pretending the first is large.

## Run

```bash
S=<scratch>/plan59-phase1
node --no-warnings --import tsx benchmarks/plan59-phase1/snapshot.mts \
  --copy-from ~/.bitterbot/memory/main.sqlite --out $S/snapshot.sqlite
node --no-warnings --import tsx benchmarks/live-recall/make-questions.mts \
  --snapshot $S/snapshot.sqlite --out ~/.bitterbot/benchmarks/live-recall/plan59-questions.jsonl \
  --n 450 --seed 59
node --no-warnings --import tsx benchmarks/plan59-phase1/partition.mts \
  --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions.jsonl --seed 59
node --no-warnings --import tsx benchmarks/plan59-phase1/run-pilot.mts \
  --snapshot $S/snapshot.sqlite \
  --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions.jsonl --seed 59
```

Costs: one small-model call per question to generate (about $0.30 for 450),
one embedding call per distinct question and per consolidated parent (cents).
A full run with arms forks the snapshot about 45 times; with
`PRAGMA synchronous = OFF` on the copying connection each fork of a 370 MB
store takes between one and ten seconds on the pilot box. The runner records
every fork, search and embedding call.

Tests: `pnpm exec vitest run benchmarks/plan59-phase1` (synthetic in-memory
stores, no private data). The `.mts` entry points are typechecked with a
scratch tsconfig because oxlint ignores `.mts` and the root tsconfig does not
include `benchmarks/`.

## What the pilot does and does not claim

It is a development and qualification pilot on one node's store, not
externally preregistered. It fixes the question sample, the candidate rules,
the cost weights and the analysis for a later collection on a fresh snapshot
and fresh questions. Its numbers say whether the harness measures what it
should and how large the contrasts are on this store; they are not evidence
that gain x need selection helps in general, and the final partition was not
scored. Rank metrics do not imply better task completion. Any claim beyond
"on this snapshot, under this protocol" needs the separate collection.
