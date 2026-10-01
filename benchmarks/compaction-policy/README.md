# Compaction policy evaluation (PLAN-52A Phase E)

Offline replay that compares the `summary` compaction policy against the `offload` policy on real Bitterbot sessions. Nothing here talks to the live agent: transcripts are copied into an isolated state directory, model calls go through the Anthropic SDK with their own usage ledger, and the recall tools read the copied files only.

## Run

```bash
node --import tsx benchmarks/compaction-policy/runner.ts corpus
node --import tsx benchmarks/compaction-policy/runner.ts cuts
node --import tsx benchmarks/compaction-policy/runner.ts probes
node --import tsx benchmarks/compaction-policy/runner.ts run --model claude-haiku-4-5 --budget 120
node --import tsx benchmarks/compaction-policy/runner.ts run --model claude-opus-4-8 --arms 1,4 --only-recall-needing --budget 160
node --import tsx benchmarks/compaction-policy/runner.ts report
```

Every phase is resumable: cuts, probes and results are JSONL files under the eval root (`~/.bitterbot/eval/compaction` by default) and already-done rows are skipped. `spend.json` tracks cost; the run phase stops when it passes `--budget`.

## What happens

1. **corpus** copies the sets from `~/.bitterbot/agents/main/sessions` into `<root>/state/agents/eval/sessions`: A = the three sessions that exceeded 100k prompt tokens, B = the largest dialogue sessions by real user turns, C = stitched runs of consecutive sessions, D = the August 2026 planted-fact sessions.
2. **cuts** replays each session turn by turn, fires the offload policy's turn-end trigger exactly where the runtime would, and writes one truncated transcript per cut (records up to that moment plus the compaction and prune entries) so arm 4's tools see what the agent would have seen.
3. **probes** asks Haiku 4.5 for 8 to 10 probes per cut from the elided range, then keeps only probes whose gold answer is verbatim in the elided text and absent from the kept region. Each probe is tagged `answerableFromDialogue` or `needsToolOutput`.
4. **run** builds the four arms on the same kept region (1 pi-style summary, 2 ledger, 3 ledger plus Haiku summary, 4 ledger plus `recall_range` and `deep_recall`), appends the probe, scores the answer (exact match first, Sonnet 5 judge otherwise) and records cost, latency, cache reads and tool use.
5. **report** writes `<root>/report.md`: per-arm metrics, paired bootstrap deltas against arm 1, spend by feature, probe mix. Copy it to `docs/reviews/compaction-policy-eval-<date>.md`.

Pass criteria are in PLAN-52A Section 5.6. Known fidelity gaps of this harness: no `memory_search` in any arm, no bootstrap files in the system prompt (they would leak answers), set B's reduced history budget.
