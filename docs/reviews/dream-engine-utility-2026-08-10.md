# Dream Engine Utility Evaluation — 2026-08-10

**Question asked:** is anything valuable happening in dream mode; can it be made
high-utility; if not, retire it.

**Method:** full code trace of all 12 modes (2 parallel tracing agents over
`dream-engine.ts` + `dream-modes/`), live-DB ground truth on every mode's actual
artifact (266 cycles of history), consumption analysis (does anything ever READ
a dream product), and a literature sweep of what offline "sleep-time" compute
has _measurably_ delivered elsewhere (Letta, Anthropic Dreaming, Voyager, AWM,
Generative Agents, plus the negative-results literature).

---

## 1. Executive verdict

**The engine's infrastructure is good and worth keeping. Its cognitive output
over one month rounds to zero consumed value.** 266 cycles, ~624 cloud LLM
calls, zero errors — and the sum of everything produced that was ever read by
any downstream consumer is: **nothing**. Not one artifact. The DQS "dream
quality score" telemetry reporting 0.9 every cycle is measuring its own
plumbing, not utility.

The fix is not tuning — it is **retargeting the LLM lanes at the three
functions the field has actually proven** (verified-success distillation,
memory hygiene, anticipatory precompute) while keeping the engine's genuinely
good bones: the scheduler, the budget accounting, the PLAN-34 promotion gate
pattern (grounding + verification + caps), and the no-LLM replay lane.

## 2. What the intent was

The design (PLAN-7 → PLAN-34 lineage) is a biological-consolidation metaphor
executed with unusual care: replay strengthens important memories, compression
abstracts clusters, mutation/extrapolation/simulation generate novel
hypotheses, exploration feeds curiosity, research closes knowledge gaps, and
four newer modes do self-maintenance (canonical promotion, KG mining/
reconsolidation, interceptor harvest, harness evolution). PLAN-34 already
diagnosed the central disease ("every dead piece is a producer with no
consumer") and imposed return-edge discipline, budgets, provenance gates, and
fail-closed egress safety. **The intent is legitimate and the safety
engineering is real.** What failed is fuel, selection, and product-market fit
between what the LLM lanes produce and what the agent ever consumes.

## 3. Ground truth (live node, 266 cycles)

| Mode                         | Ran (cycles) | Intended artifact                         | Actually produced                                               | Ever consumed?                              |
| ---------------------------- | ------------ | ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| replay                       | 202          | importance boosts, orphan rescue          | ALIVE — boosts applied                                          | indirectly (retrieval ranking) — unmeasured |
| exploration                  | 243          | strategy insights + curiosity targets     | 17 targets (0 resolved); insights pruned away                   | no                                          |
| mutation                     | 93           | skill-variant insights → refiner crystals | 206 crystals — **all paraphrases of ONE skill**                 | **0 reads, 0 executions ever**              |
| extrapolation                | 22           | promoted insight chunks (gated)           | 3 chunks total (one cycle, Jul 18)                              | **access_count = 0**                        |
| simulation                   | 28           | promoted insight chunks (gated)           | 0 survived the gate                                             | —                                           |
| compression                  | 63           | cluster summaries + archival              | insights all pruned; 7 chunks archived                          | no                                          |
| canonical_promotion          | 26           | canonical fact pins                       | **0 pins ever** (bias-to-reject prompt)                         | —                                           |
| relationship_mining          | 21           | KG triples                                | **0 — cursor stranded at rowid 48686 vs max 28096**             | —                                           |
| relationship_reconsolidation | 25           | contradiction resolution                  | 0 (zero `flag_contradiction` rows ever; 12 relationships total) | —                                           |
| interceptor_harvest          | 22           | staged interceptor candidates             | 0 (all `outcome_tag` NULL → no cluster possible)                | —                                           |
| harness_evolve               | 28           | evolved prompt-fragment policy            | **never passed line 112** (needs ≥5 held-out executions; has 0) | —                                           |
| research                     | 0            | skill rewrites                            | disabled by PLAN-34 Phase 0 (correct)                           | —                                           |

Supporting facts:

- The **promotion gate works but starves twice**: extrapolation+simulation get
  ~19% of cycle slots (exploration+mutation auto-trigger into 2 of 3 slots
  nearly every cycle), and the grounding-similarity leg kills 62 of 77
  candidates (`dream_telemetry` phase='promotion': `reject_insufficientGrounding=62`,
  `reject_noFirstPartySource=12`, promoted=3). The verifier is NOT the bottleneck.
- The **mutation lane is a paraphrase treadmill**: 206 crystals, 1 distinct
  skill category, 3 lineages — a month of cloud calls remixing one
  DuckDuckGo/Home-Assistant skill's prose description, each scored ~0.9
  importance, none executable, none ever retrieved.
- `dream_insights` has exactly one reader (the on-demand agent `dream` tool)
  and its 200-row prune means only mutation rows survive anyway.
- The **adaptive cycle interval is itself wired-but-dead** (manager reads only
  user config, never the merged default → fixed 120min in production).
- The 183 `research_egress_log` rows are NOT dream auto-research (which is
  fail-closed: no local model configured) — they're the Skill-Seekers trending
  sweep, whose GitHub-derived skills land in the 268-item unreviewed
  quarantine backlog. Another produce-into-a-void chain.

## 4. What the field has proven (evidence sweep, 2026-08-10)

Strongest demonstrated utility for offline agent compute:

1. **Skill/workflow distillation from _verified-successful_ trajectories.**
   Voyager (skill library = the difference between progress and plateau), AWM
   (+51% relative on WebArena), Anthropic's "Dreaming" for Managed Agents
   (transcript→pattern extraction; ~6x task-completion at Harvey, vendor-
   reported). The non-negotiable ingredient everywhere: **a success signal
   gates what gets distilled.**
2. **Memory consolidation/hygiene** — dedup, staleness replacement, merging
   incremental writes into clean blocks (Letta sleep-time agents, LangMem
   background manager, Mem0 ~15x token reduction). Proven wins are cost/
   latency/context-quality; must be **bounded** (arXiv 2605.12978: continuous
   LLM rewriting makes memory measurably worse) and **selective** (arXiv
   2505.16067: indiscriminate experience-adding degrades agents via
   error propagation).
3. **Precomputing inferences over predictable context** (Letta paper, arXiv
   2504.13171: ~5x test-time compute reduction, +13–18% accuracy, ~2.5x cost
   amortization) — works when future queries are anticipatable (a personal
   agent's ongoing projects qualify).
4. **Question-driven reflection synthesis** over episodes (Generative Agents
   ablation; A-MEM multi-hop gains) — moderate evidence, needs grounding gates.

**No measured wins anywhere** for open-ended creative insight generation
without a grounding signal — the exact shape of the current mutation/
extrapolation/simulation/exploration output. The negative-results literature
predicts what we observe: ungrounded free-text insights are the weakest
artifact class and a memory-pollution vector.

The 2026 industry read: background memory processing is now mainstream
(Letta, LangMem, Anthropic Dreaming, Mem0/Zep) — **the category is validated;
the creative-dreaming variant of it is not.**

## 5. Per-mode verdicts

**KEEP (already useful, cheap):**

- `replay` — no-LLM, feeds retrieval ranking via importance shaping. Keep.
  Add consumption measurement (do replay-boosted chunks get retrieved more?).

**RETARGET (the core of the redesign, §6):**

- `mutation` — kill the paraphrase treadmill. Its budget moves to
  verified-success distillation (lane 1).
- `compression` — retarget from template-insights (dead on arrival) to real
  memory hygiene (lane 2). Its archival side-effect is the seed of the right
  idea.
- `extrapolation`/`simulation` + the promotion gate — keep the GATE (it's a
  good implementation of grounded reflection); fix selection starvation and
  recalibrate the 0.4 grounding floor; scope prompts to anticipatory briefs
  (lane 3) instead of open-ended musing.

**FIX NOW (mechanical, done in this commit):**

- `relationship_mining` — cursor stranded past pruned rowids; clamp revives
  it. Feeds PLAN-27 graph-anchored recall, a real consumer.

**HOLD (well-built, waiting on upstream fuel that is now arriving):**

- `harness_evolve` — genuinely well-engineered (held-out partition, paired
  bootstrap, CI gate, auto-rollback) but needs ~25+ completed skill
  executions; the skills economy only started recording real executions this
  week (post-F2/F12 fixes). Re-evaluate at volume.
- `interceptor_harvest` — blocked on `outcome_tag` being written (the
  outcome-backfill tagger has never fired; interventions only started
  existing 2026-08-10). Verify the tagger, then hold until records accrue.
- `relationship_reconsolidation` — cannot fire below ~contradiction-capable
  graph density (12 relationships today). Hold; revisit after mining revival.
- `canonical_promotion` — wiring is fine; prompt is calibrated to reject
  everything (0 pins in 26 cycles). Recalibrate as part of lane 2, or fold
  its function into the extraction path and retire the mode.

**RETIRE:**

- `research` mode — already disabled by PLAN-34 Phase 0; make it permanent
  (delete rather than carry dead weight) once lane 1 exists, since lane 1 is
  the principled replacement for "rewrite skills from execution data".
- The `dream_outcomes` DQS metric family — flat 0.9 regardless of yield;
  replace with the §7 utility KPI.

## 6. The redesign: three evidence-backed lanes

The engine keeps its scheduler, budget, telemetry, and gate machinery. The
LLM budget points at three lanes with hard fuel gates:

**Lane 1 — Verified-success distillation (replaces mutation/research).**
Input: completed `skill_executions` with `success=1` (and reward ≥ floor) +
first-party session transcripts of successful task completions. Output:
executable/procedural skill improvements and "what worked" workflow notes,
written through the existing staging gate (PLAN-15/21 machinery exists).
Hard gate: no success signal → no distillation (the Voyager/AWM lesson).
The F5/F12 fixes just turned execution recording on for real, so this lane's
fuel is finally accumulating.

**Lane 2 — Memory hygiene (replaces compression + canonical_promotion).**
Bounded, one-shot-per-item operations with mechanical triggers: near-duplicate
crystal merge (needs the embedding backfill — the known ~7.3k gap is this
lane's blocker and now has a reason to be fixed), canonical-fact staleness
review (`last_confirmed_at` old → verify-or-retire proposal), orphaned/
contradictory row cleanup. Never iterative rewriting of the same item
(the corrosion result). This is the Letta/Anthropic-Dreaming shape.

**Lane 3 — Anticipatory briefs (retargets extrapolation/simulation).**
Scope: the user's demonstrably-active contexts (open tasks, canonical facts
touched recently, recent session topics). Product: short precomputed briefs
("state of X, likely next question, answer sketch") surfaced through the
PLAN-34 deterministic surfacing queue (already built!) and marked as
hunches. Keep the full promotion gate. This is the Letta predictable-query
result applied to a personal agent.

**Cross-cutting: the utility KPI (§7) becomes the engine's only score.**

## 7. Test-drive plan — how utility gets confirmed or the thing gets retired

The single honest metric: **consumed-artifact rate** — of the artifacts a lane
produced N days ago, how many were subsequently read/executed/surfaced in a
real agent turn? (`access_count`, `skill_executions`, surfacing-queue drains,
retrieval traces). Today's lifetime number is 0.

Concrete drives (each cheap, each with a kill criterion):

- **D1 (lane 1 pilot):** after ~25 real executions accrue, force one
  distillation cycle on a DB copy; a human (Victor) rates 10 outputs
  useful/not; then deploy and measure whether distilled skills get _executed_
  within 14 days. Kill: <2 useful of 10, or zero executions in 14 days.
- **D2 (lane 2 pilot):** run dedup/staleness on a DB copy; measure retrieval
  precision on 20 replayed real queries (from retrieval_trace history) before
  vs after, plus token count of injected context. Kill: no precision/token
  win.
- **D3 (lane 3 pilot):** generate 5 briefs from current active context; count
  how many get surfaced AND referenced in the next week's sessions. Kill:
  0 references.
- **D4 (replay value check):** correlation between replay-boosted chunks and
  subsequent retrieval hits vs a matched non-boosted cohort. If no lift,
  replay's boost magnitude is noise — simplify to orphan rescue only.
- **D5 (revived mining):** after cursor clamp, verify triples land AND
  graph-anchored recall (PLAN-27 path) actually traverses a mined edge in a
  real turn (retrievalHealth counters).

Instrumentation to make all of this visible permanently: a
`dream-utility` section in the artifact-liveness doctor — produced vs
consumed per lane, replacing DQS.

## 8. What was done in this commit

- `relationship_mining` cursor clamp (revives the one single-fix dead mode;
  the forgetting engine had pruned past it, stranding it forever).
- This report.

## 9. Recommendation to Victor

Approve the three-lane retarget as a plan (it deserves its own PLAN doc +
adversarial pass per standing workflow). It is NOT a bigger build than what
exists — it deletes more LLM-burning code than it adds and reuses the
engine's best machinery (gate, budgets, staging, surfacing queue). If the
three pilots fail their kill criteria, the honest residual is: replay +
hygiene cron + the doctor, and the "dream" brand retires with its dignity
intact — the infrastructure it leaves behind (gates, budgets, staging,
egress safety) is genuinely good engineering.
