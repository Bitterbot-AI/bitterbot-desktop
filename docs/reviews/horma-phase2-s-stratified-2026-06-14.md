# HORMA Phase 2: Stratified `_s` Contrastive Run (2026-06-14)

The accuracy half of the PLAN-24 Phase 2 proof gate, run on the regime that actually tests it: the long `_s` haystacks (around 100k tokens of conversation per question), where stuffing everything into the prompt suffers lost-in-the-middle and compact constructed memory should win.

This is the follow-up to the earlier oracle probe (`horma-phase2-contrastive-2026-06-13.md`), which proved token efficiency but could not show an accuracy win because oracle haystacks are short enough that full context always has a clean copy of the answer.

- **H** = the full raw transcript stuffed into the prompt (no memory construction).
- **H'** = the real biological memory pipeline (ingest, construct, retrieve, answer).

## Setup

- Dataset: `longmemeval_s.json`, **train split** (the held-out test split is never touched).
- N = 18, **stratified 3 per question type** across all six types.
- H context budget: 200k chars (about 50k tokens, matching HORMA's LongMemEval budget). Answer model: `anthropic/claude-opus-4-7`. Judge: GPT-4o. Entity extraction (SAGE): ON.
- Reproduce:

  ```bash
  export $(grep -v '^#' .env | xargs)   # OPENAI_API_KEY + ANTHROPIC_API_KEY
  node --import tsx benchmarks/longmemeval/runner-contrastive.ts \
    --split train --stratify 3 --char-budget 200000 --verbose
  ```

## Results

| Condition                        | Accuracy      |
| -------------------------------- | ------------- |
| H (full raw transcript, 50k tok) | 27.8% (5/18)  |
| H' (memory pipeline, ~2.5k tok)  | 72.2% (13/18) |

Buckets: D_exo (H right, H' wrong) = 1 · D_end (H wrong, H' right) = 9 · both right = 4 · both wrong = 4

**Token efficiency: H' context averaged 2,561 tokens vs H's 50,000 = 5.1% of baseline (about 20x).**

## By question type

| Type                      | N   | H acc | H' acc | D_exo | D_end |
| ------------------------- | --- | ----- | ------ | ----- | ----- |
| single-session-user       | 3   | 33.3% | 100.0% | 0     | 2     |
| single-session-assistant  | 3   | 0.0%  | 100.0% | 0     | 3     |
| knowledge-update          | 3   | 66.7% | 100.0% | 0     | 1     |
| multi-session             | 3   | 33.3% | 66.7%  | 0     | 1     |
| single-session-preference | 3   | 0.0%  | 66.7%  | 0     | 2     |
| temporal-reasoning        | 3   | 33.3% | 0.0%   | 1     | 0     |

## Reading the data

The headline is unambiguous on this sample: on long haystacks the memory pipeline answers correctly far more often than full context (72% vs 28%, a 44-point gap) while spending about 5% of the tokens. This is the lost-in-the-middle regime the oracle probe could not reach, and it is exactly where the construction-plus-retrieval thesis is supposed to pay off.

The contrastive ledger is the part that matters most. Nine questions were D_end (full context drowned, the memory pipeline got it) against a single D_exo (full context found a fact the pipeline missed). That near-one-sided split means the pipeline is not trading accuracy for its token savings here. It is strictly better on net, and the one loss it took is a single diagnosable case, not a pattern.

Per type, the pipeline wins or ties everything except one bucket. It is perfect (3/3) on single-session-user, single-session-assistant, and knowledge-update, including a clean win on knowledge-update where it surfaced the latest version of a fact that changed over time, which is the case bitemporal memory is built for.

### Honest caveats

- **This is a train-split probe, not a publication number.** It is a strong internal signal that justifies the real evaluation, not the evaluation itself. Publishable numbers go on the held-out test split (372 items), with the standard baselines (Mem0, embedding retrieval, A-MEM) for comparison the way the source paper ran them.
- **H is a 50k-token budgeted baseline, not unlimited context.** That matches HORMA's protocol, so it is defensible, but it must be stated plainly. A model fed the entire 100k-plus-token transcript in a very long context window might close some of the gap, so the claim is "comparable-or-better accuracy at about 5% of the tokens versus a 50k-budget full-context baseline," not "beats unlimited context."
- **N is small** (3 per type, 18 total). The per-type numbers are indicative, not precise, and the wide confidence intervals at this N are real.
- **The one genuine weak spot is temporal-reasoning, where the pipeline went 0/3.** Full context also struggled there (1/3), and the field at large is weak on temporal (the source paper sat around a third), but 0/3 is the pipeline's worst type and the lone D_exo loss lives here. That is the honest failure mode, and it is precisely the signal the Phase 3 architect loop is built to consume: a temporal retrieval miss becomes a construction-feedback record that drives a rule like "preserve exact dates and pre-compute relative ordering."

## Gate decision

**PASS on this sample.** The accuracy-win half of the Phase 2 gate, left inconclusive by the oracle probe, is met here: the memory pipeline is clearly more accurate than budgeted full context on the long-haystack regime, not merely cheaper. Combined with the token-efficiency result, this is the full HORMA thesis reproduced on Bitterbot's own pipeline.

What this does not yet license is a published headline. The next milestone for that is a run on the **held-out test split with the standard baselines**, plus targeted work on the temporal-reasoning weak spot (which the architect loop should now have a feedback record to start on). That is a measurement exercise, not new research, and it is the right next step before anything goes in a preprint.
