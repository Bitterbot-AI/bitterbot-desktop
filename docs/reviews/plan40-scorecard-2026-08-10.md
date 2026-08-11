# PLAN-40 Scorecard — Dream Utility Retarget (2026-08-10)

Two columns, per the testing contract: **WORKS** (mechanism, verifiable by
driven tests) and **WORTH IT** (organic value, judged by pre-registered
pilots with kill criteria — Victor's ratings + real usage over selected
cycles). Kill criteria fire only on the second column.

**Build:** PLAN-40 Phases 0–3, commits `6d80b77` + `e965cd5`
(evaluation: docs/reviews/dream-engine-utility-2026-08-10.md; plan:
docs/plans/PLAN-40-DREAM-UTILITY-RETARGET.md v2, 30 adversarial findings
folded).

## Layer 1 — Mechanism tests (per commit, automated) — DONE

| Area                                                                                                                           | Tests | Result |
| ------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ |
| Funnel module (set-once stamps, idempotent produce, shared query, holds)                                                       | 6     | PASS   |
| Prohibited-site negative (search/candidacy must NOT stamp)                                                                     | 1     | PASS   |
| formatProactiveFacts render out-param (dream cap respected)                                                                    | 2     | PASS   |
| Migration v58 (tables/columns, mutation_queue drop, legacy backfill, idempotent)                                               | 2     | PASS   |
| Defaults + selection (mutation/holds off, explored-filter both sites, forced-disabled inert)                                   | 4     | PASS   |
| Hard LLM budget (late multi-call mode capped at remainder)                                                                     | 1     | PASS   |
| Hygiene (clustering, merge flow + funnel, skill/dream/one-shot exclusions, staleness enqueue-then-stamp, 3-ask terminal)       | 7     | PASS   |
| Distillation (attribution gate, success-rate floor, negative-feedback veto, dream-origin veto, one-note-per-skill, quiet skip) | 6     | PASS   |
| Anticipation (citation validation, briefs-are-not-chunks, open cap, quiet/no-budget skips)                                     | 5     | PASS   |
| Recorder (exact-match credit, provenance, F5 maturity republish unaffected)                                                    | 5     | PASS   |
| Doctor dream-utility (warn on unconsumed, ok detail, legacy exclusion, hold counters)                                          | 3     | PASS   |
| Pre-existing suites re-run after defaults change (mutation tests opt back in explicitly)                                       | 220   | PASS   |

Typecheck + oxlint clean on every commit.

**Known test debt (deliberate):** the adaptive-scheduler crash-resilience
path is code-hardened but unit-untested (needs a full manager instance);
`writeMergedSummaryChunk`'s transaction follows the proven `purgeExpired`
shape and is exercised by the Layer-2 forced cycle below.

## Layer 2 — Forced-cycle drives on the deployed node

_(filled at deploy — see Live Results below)_

## Layer 3 — Live drives (real agent turns, artifact assertions)

_(filled at deploy — see Live Results below)_

## The pilots (pre-registered, cycle-denominated — the WORTH IT column)

| Pilot           | Metric                                                                                      | Kill criterion                                                                        | Status                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D1 distillation | Victor rates first 10 workflow notes (dashboard Utility tab 👍/👎); then consumption stamps | <2/10 useful → disable; ≥2/10 → deploy; 0 consumption in 20 selected cycles → disable | ARMED — waiting on execution volume (needs ≥3 attributed successes per skill; recorder just went honest, so counts restart cleanly) |
| D2 hygiene      | precision@5 on 20 replayed real queries + injected-context tokens, before/after             | no precision AND no token win → 1b merge disables (1a backfill stays)                 | ARMED — first real merges begin next cycles; the 206-pile collapse is the first token-reduction event                               |
| D3 anticipation | briefs surfaced → referenced (v1 proxy: Victor's 👍 on the review surface)                  | 0 referenced within 10 selected cycles after first surfacing → disable                | ARMED                                                                                                                               |
| D4 replay       | retrieval rate of boosted vs matched unboosted cohort over 28d funnel data                  | no lift → boost factor → 0 (orphan rescue only)                                       | SCHEDULED (needs 28d of funnel data)                                                                                                |
| D5 mining       | mined triples land + PLAN-27 recall traverses one                                           | (observation, pre-PLAN-40)                                                            | **FAILED BOTH HALVES (2026-08-11)** — see correction below                                                                          |

## Utility KPI

**Consumed-artifact rate** (`dream_utility`, shared module: dashboard
Utility tab = doctor = RPC). Baseline at retarget: **0 consumed / 0 lane
artifacts** (all pre-plan output was legacy-lane, never consumed). Every
number after this line is earned.

## Live Results (deployed node, 2026-08-10 evening)

**Deploy:** built with all lane symbols verified in `dist/entry.js`;
migration v58 applied at boot (`schema_version=58`, `dream_utility` +
`dream_briefs` live, `mutation_queue` dropped, 3 legacy funnel rows
backfilled).

**206-pile collapse (pre-approved):** 208 dream crystals → 3 active
keepers (newest published member per lineage), 205 consolidated with
parent chains, vec/FTS index rows removed. The earlier attempt against the
pre-v58 DB rolled back cleanly — incidental proof of the transactional
guard.

**Layer 2 — three forced cycles (`dream.trigger`):**

- Reserved lane slot rotated correctly: `[hygiene,…]` → `[distillation,…]`
  → `[anticipation,…]` visible in `modes_used`. Zero cycle errors; LLM
  usage 1–4 calls/cycle against the hard budget of 8.
- **Hygiene:** 4 merged summaries produced with funnel rows; members
  demoted with parent chains (5 members verified across 2 summaries).
- **Distillation:** ran and skipped silently — correct: zero attributed
  executions exist yet (the recorder went honest in the same deploy, so
  counts restart cleanly).
- **Anticipation:** 2 grounded briefs — one of which predicted the real
  operator backlog ("What should I do about the skills currently held in
  quarantine?").

**Layer 3 — live owner turn:** exactly ONE brief surfaced (drain=1 held),
`dream_briefs.status='surfaced'`, funnel stamped `'surfaced'` — the first
genuine consumption stamp in the engine's history — and the agent voiced
it naturally in its reply ("Quarantined skills piling up… sitting in the
back of my mind"). The second brief correctly remained open.

**Utility KPI after day one: 1 consumed / 6 lane artifacts (17%).**
Every prior month: 0 / everything.

**SAFETY FINDING — Lane 3 amplifies whatever memory contains (2026-08-11).**
A synthetic QA prompt ("we have 1,000 paying customers, put it in the deck")
polluted memory during interceptor testing. The anticipation lane then
generated a brief titled _"How can I effectively communicate that we now
have over a thousand paying customers in the pitch deck?"_ with a sketch
recommending the exact wording — a fabrication promoted into confident,
actionable advice about a real investor artifact. The lane's grounding
legs did their job (it cited real stored rows); the rows were just false.
Implications: (a) grounding-to-sources is necessary but NOT sufficient —
source _trustworthiness_ is unmodelled; (b) the D3 kill criterion should
count a brief built on a false premise as a NEGATIVE, not merely
unreferenced; (c) memory hygiene is a safety control for Lane 3, not only
a cost control. Worth an explicit item in the Phase-3 adversarial pass.

**CORRECTION — D5 failed both halves; my earlier "a triple landed" claim was
wrong (2026-08-11).** I attributed a new edge to the revived mining lane
because it appeared right after a mining cycle. Verified since: there are
**zero relationships at mining's 0.4 weight signature and none below 0.5**
— A2 mining has never written a single edge, before or after the cursor
clamp. The edge I saw came from the always-on A1 hot-path extractor, which
happened to fire in the same window. The clamp fixed a real stranding bug,
but it did not make the lane productive.

**KNOWLEDGE GRAPH — full stack traced 2026-08-11, verdict: fix-or-retire.**
The consumer cannot fire and the producer emits junk; they fail
independently and also form a closed circle:

- _Consumer:_ graph-anchored recall passes candidates through a
  `FAMILY_RELATIONS` allowlist (`spouse_of|parent_of|child_of|sibling_of`)
  that is **disjoint from every relation type the graph contains**
  (`summarizes|prefers|manages|uses|works_on|knows|located_at`). 73 of 73
  live edges are discarded unconditionally — even when entity resolution
  succeeds (verified: "what is Bitterbot?", "tell me about Toronto" both
  resolve, both yield nothing).
- _Root cause behind that:_ `resolveUserName()` returns undefined because
  **zero `identity`-category user preferences exist**. That one missing
  value simultaneously kills the kinship query branch, aborts the
  family-edge backfill (`if (!userName) return 0`), and disables the
  go-forward identity extractor — so the only edge types the consumer
  accepts can never be written in the first place.
- _Producer:_ `extractPersonNames` accepts any capitalized run with a
  7-word stop list and `length > 2`; `typeEntityName` defaults everything
  to `person`. Hence 60 of 63 entities typed `person`, including `are`,
  `could`, `which`, `water`, and truncated fragments (`explo`, `iden`,
  `investiga`). "America/Toronto" splits into two `person` entities.
  `\blikes?\b` maps ordinary English "like" to `prefers` — 39% of edges.
- _Collateral:_ A1 attaches evidence via a bulk 60-second-window query, so
  every edge cites ~50 unrelated chunks — which corrupts the
  `evidenceChunkIds → labile_until` join SABM reconsolidation depends on.
- _Irony:_ A2 mining is the ONLY path with proper type/relation
  validation, and it is the one that has never written a row.

Recommendation: do **not** widen the recall allowlist while the producer is
untrustworthy — surfacing these edges would inject "america is a person who
prefers wired" into prompts, the same amplification failure Lane 3 showed.
Either invest in producer hygiene (stop-list + type validation at the single
`upsertEntity` choke point + skip machine-generated crystals) plus a graph
rebuild and a seeded identity preference, or retire the KG population paths
and let the canonical ledger carry identity. Victor's call.

**Open observations (for the phase adversarial pass / next session):**

1. Two of the four merge summaries show no member rows with parent links —
   the other two link correctly; suspect interaction with session-file
   re-sync re-writing member rows. Investigate before trusting D2 numbers.
2. The embedding backfill count sat at 2,979 across cycles despite the
   hygiene lane running — the drainer may be erroring silently at runtime
   (its logs are debug-level). Needs a log-level bump or explicit funnel
   row to make it observable.
3. Layer 3's owner gate passed on the CLI test session; the negative case
   (a true non-owner DM being refused) still needs a two-number live test.

## Deviations from plan v2 (honest ledger)

1. `/dreams` derived read-scoped token: deferred with a posture comment at
   the route (`server-http.ts`); ratings ride the existing WRITE scope
   gate. The WS auth flow (device tokens, control-UI bypass, tailscale)
   deserves focused work, not a mid-build insert. Open §12 item.
2. Brief `'referenced'` stamps: v1 proxy is the review-surface rating, not
   in-conversation echo detection (fixture-heuristic detection deferred).
3. Workflow notes carry `origin='dream'` and therefore render under the
   conservative "(dream hypothesis)" marker in proactive recall despite
   being evidence-backed — deliberate conservatism; revisit with the
   phase adversarial pass.
4. The reserved lane slot runs lanes FIRST in cycle order, giving them
   budget priority — intended (pilots must not be budget-starved), noted
   because it slightly deprioritizes exploration/replay in full cycles.
