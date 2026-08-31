# Skill-evolution task corpus (PLAN-42)

The corpus is the node's local benchmark for generated skills: a candidate
skill set is compared against the incumbent on these tasks with paired
scoring, and only a statistically clean improvement (bootstrap
`ci95Low > 0`) promotes. Scores are only comparable within one corpus
version (the SHA-1 of the file, recorded with every verdict).

## Format

One JSON object per line in `task-corpus.jsonl`:

```json
{
  "id": "unique-id",
  "prompt": "task for the agent",
  "checker": { "kind": "contains|regex|exact", "value": "..." },
  "timeoutMs": 120000,
  "tags": ["exec"]
}
```

Checkers are deterministic on purpose — a task belongs in the corpus
precisely because its outcome is checkable without a judge.

## Installing on a node

```bash
cp benchmarks/skill-evolution/seed-corpus.jsonl ~/.bitterbot/skill-wiki/task-corpus.jsonl
```

Then set `skills.evolution.validationMode` to `"tasks"` once the corpus has
been reviewed. Until then the gate runs in `"records"` mode (LLM-judged
counterfactuals over held-out traces), which needs no corpus.

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
