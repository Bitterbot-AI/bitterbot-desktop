# Skill-evolution task corpus (PLAN-42)

The corpus is the node's local benchmark for generated skills: a candidate
skill set is compared against the incumbent on these tasks with paired
rollouts, and only a statistically clean improvement (exact sign test,
`p < 0.05`, on the capability suite) promotes. Scores are only comparable
within one corpus version (recorded with every verdict: the canonical
generator version + seed, plus the SHA-1 of the grown file).

## The canonical base corpus (generator-seeded, 2026-09-02)

`canonical-corpus.jsonl` is the seed-0 EXEMPLAR of the canonical corpus:
the human-reviewable form of twelve task TEMPLATES embedded in the release
(`src/memory/skill-evolution/canonical-corpus.ts`). Each template is
`template(seed) -> (instance, ground truth)`, so every validation run draws
a fresh seed and memorizing any instance (including this file) buys
nothing; a marketplace seller cannot hard-code the answers into a skill.
The exemplar is byte-locked to the generator output and SHA-256 pinned by
`canonical-corpus.test.ts`; verdicts record the seed they were scored on.

Canonical tasks are the REGRESSION suite: near-ceiling generics whose only
job is "no new failures". They never count toward promotion. The promotion
signal lives in the node's grown CAPABILITY suite (`task-corpus.jsonl`),
sourced from the node's own failure traces.

Updating the templates is a release act: edit `canonical-corpus.ts`, bump
`CANONICAL_GENERATOR_VERSION`, regenerate this file
(`canonicalExemplarJsonl()`), and set the pin (the test states the
expected value). Never edit an instance in this file by hand.

## The gate (why the numbers look the way they do)

Promotion is decided by an exact one-sided sign test over discordant
per-task deltas on the capability suite (`p < 0.05`), with K trials per
task per arm (`skills.evolution.trialsPerTask`, default 3) and fractional
pass rates. Five clean capability wins with no losses is the minimum
promotable evidence. A candidate that newly fails a regression task
(pass-rate drop of 0.5 or more) is rejected outright. A corpus with no
capability tasks HOLDS proposals rather than rejecting them: it can detect
breakage but not improvement, which is the state of a fresh node.

## Format

One JSON object per line in `task-corpus.jsonl`:

```json
{
  "id": "unique-id",
  "prompt": "task for the agent ... Reply with exactly one line of the form \"FINAL: <answer>\".",
  "checker": { "kind": "final", "value": "exact expected answer" },
  "suite": "capability",
  "timeoutMs": 120000,
  "tags": ["mined"]
}
```

Prefer the `final` checker for every new task: the prompt demands a
`FINAL: <answer>` line and the captured value is compared exactly
(length-capped), which closes the false-pass modes of bare `contains`
checks (verbose output that happens to include the gold string, or an
answer that enumerates every candidate). `contains`, `regex`, and `exact`
remain supported for older tasks. `suite` is `"capability"` by default for
grown tasks; tag a task `"regression"` only when it is a no-new-failures
guard rather than an improvement signal.

Checkers are deterministic on purpose — a task belongs in the corpus
precisely because its outcome is checkable without a judge.

## Enabling tasks mode on a node

Nothing needs installing: the canonical regression suite is embedded in
the release. Set `skills.evolution.validationMode` to `"tasks"` once the
exemplar has been reviewed. Until then the gate runs in `"records"` mode
(LLM-judged counterfactuals over held-out traces). In tasks mode with no
capability tasks yet, proposals are HELD (not rejected) until the
capability suite grows; see the next section.

## Growing the capability suite

The daily evolution pass drafts capability tasks from the window's FAILING
traces into `~/.bitterbot/skill-wiki/task-corpus-pending.jsonl` (hardened
`final` checkers, injection-scanned, deduped, capped at 50). Nothing enters
the live corpus automatically. Review a pending line AS CODE: its prompt
will execute with shell and file access, thousands of times per proposal,
so read it the way you would read a script from a stranger (drafts that
touch the network are refused up front, but you are the last gate). Fix
the expected answer if needed, then move it into `task-corpus.jsonl`. Tasks distilled
from real failures are difficulty-calibrated by construction, which is
exactly where the sign test can detect improvement. Retire capability
tasks that drift above roughly 90% incumbent pass rate; they no longer
carry signal.

## Curation guidance

- **Watch the ceiling effect.** The seed tasks are regression protection: a
  skill that breaks basics gets caught, but a corpus most models pass 100%
  cannot detect improvement. The valuable additions are tasks distilled
  from this node's own RECURRING FAILURES (the wiki's pattern pages list
  them) where the incumbent sometimes fails — that's where a candidate can
  measurably win.
- Keep it ≤ 30 tasks (the loader caps there); prefer breadth of failure
  modes over volume.
- Never edit a task in place once verdicts reference its corpus version —
  add new tasks or start a new file revision instead.

## Real-trace calibration (PLAN-45 Phase 1.5)

The synthetic fixture above checks rule consistency on live run SHAPES. The
real-trace calibration checks the rules against blind labels on this node's
actual runs. Set: `bitterbot skills calibrate export --count 100 --seed plan45-p1`
on 2026-09-06 (858 terminal tool-bearing runs scanned, 400 reconstructed, 380
eligible; heuristic distribution pass 341 / unknown 32 / fail 5 / env-fail 2;
sample stratified round-robin across the heuristic's own classes, so the rare
classes are over-represented relative to the population). Rater A = Claude
labeling the blind logs (no key, no outcome/Signals/evidence lines); rater B
(Victor) pending, so inter-rater agreement and consensus scores are not yet
reported.

| Class    | Precision | Recall | F1   | tp  | fp  | fn  |
| -------- | --------- | ------ | ---- | --- | --- | --- |
| pass     | 0.77      | 0.64   | 0.70 | 47  | 14  | 27  |
| fail     | 0.20      | 0.20   | 0.20 | 1   | 4   | 4   |
| env-fail | 1.00      | 0.11   | 0.20 | 2   | 0   | 16  |
| unknown  | 0.06      | 0.67   | 0.11 | 2   | 30  | 1   |

Accuracy 0.52 on the stratified sample (n=100). Confusion, truth (rater A)
to heuristic: pass -> pass 47 / unknown 24 / fail 3; env-fail -> pass 10 /
unknown 5 / env-fail 2 / fail 1; fail -> pass 3 / fail 1 / unknown 1;
unknown -> unknown 2 / pass 1.

What this says about the rules, in order of damage:

1. **Environment failures read as passes.** 10 of 18 rater-A env-fails
   were labeled `pass`: the agent hit a 402 / SDK bug / timeout, handled
   it gracefully and ended cleanly, and the "recovered from an environment
   error" rule scored that a weak pass although the deliverable never
   arrived. Recovery is not delivery.
2. **`unknown` is over-assigned.** 24 clean runs with no journaled task
   (pre-user-stream) or no `complete()` call were labeled `unknown`; a
   reader judged them evidently completed. Those runs are also the ones the
   sampler drops, so the loop is discarding usable passes.
3. `fail` is near chance in both directions at n=5+5; too few to act on.

The rule changes belong to the next labeler revision and must clear the
synthetic fixture (`labeler.fixture.test.ts`) and improve these numbers on a
FRESH export (different seed) before they land. Files:
`~/.bitterbot/skill-wiki/calibration/2026-09-06T03-53-55-899Z/`
(`blind.jsonl`, `key.jsonl`, `labels-claude.jsonl`).
