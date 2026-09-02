# Skill-evolution task corpus (PLAN-42)

The corpus is the node's local benchmark for generated skills: a candidate
skill set is compared against the incumbent on these tasks with paired
scoring, and only a statistically clean improvement (bootstrap
`ci95Low > 0`) promotes. Scores are only comparable within one corpus
version (the SHA-1 of the file, recorded with every verdict).

## The canonical base corpus (PLAN-43 Phase 0 / PLAN-42 §5.7)

`canonical-corpus.jsonl` is the immutable baseline every node ships with.
It is embedded in the release
(`src/memory/skill-evolution/canonical-corpus.ts`, pinned by SHA-256 and
held byte-identical to this file by `canonical-corpus.test.ts`), so a
brand-new node with no history can still validate skills, and marketplace
ranking can score against a corpus a seller does not control. In tasks
mode the gate runs on the canonical tasks PLUS the node's grown
`task-corpus.jsonl`; grown tasks augment the baseline and can never shadow
a canonical task id. Verdict versions from a canonical run carry the
`canonical-` prefix.

Updating it is a release act: edit the file, mirror the lines in
`canonical-corpus.ts`, update the pins (the test states the expected
values), and treat the new version as a fresh benchmark. A detached
minisign signature attaches at release time once the signing keys from
`deploy/relay-fleet/SIGNING.md` exist (same posture as the orchestrator
binary: hash gate active now, signature slot ready).

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
counterfactuals over held-out traces), which needs no corpus. Installing a
grown corpus is optional in tasks mode (the embedded canonical baseline is
always available), but a grown corpus is what lets the benchmark harden
around this node's real failure modes.

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
