# Published evidence: cross-agent evidence cards

Raw data and generated reports for the three studies described in
[`../README.md`](../README.md) under "Cross-agent evidence cards".

| Folder                      | Study                                                                   | Episodes | Models                                                               |
| --------------------------- | ----------------------------------------------------------------------- | -------: | -------------------------------------------------------------------- |
| `cross-agent-20261115/`     | First study (`xa-exp`, `xa-eval`) and follow-up (`xa-live`, `xa-eval2`) |    3,744 | recipient and donors `anthropic/claude-haiku-4-5`                    |
| `cross-agent-rep-20261116/` | Registered replication (`xa-exp`, `xa-live`, `xa-rep`)                  |    2,160 | recipient `anthropic/claude-haiku-4-5`, donors `openai/gpt-5.4-mini` |

Each folder holds:

- `records.jsonl.gz`: one line per episode (phase, arm, task, cell, seed,
  skills-index order, variants read, pass, tokens, model, error).
- `report-*.md` and `summary-*.json`: what the runner wrote when the phase
  finished. Absolute paths were shortened to `~`; nothing else was edited.
- `protocol-*.json`: the protocol and its hash, written before the first
  evaluation run of the phase.
- `bundles/*.json`: the signed card bundles the recipient imported
  (`d1..d3` one-off donors, `l1..l3` live cohort). They carry public keys
  and signatures only.

`../published.test.ts` recomputes every gate step from the raw records and
checks it against the summaries, and verifies each bundle's signature. Run:

```bash
pnpm exec vitest run benchmarks/skill-prior/published.test.ts
```

To regenerate a report with the runner, unpack the records into an output
directory and run the phase again; finished episodes are skipped, so no
model is called:

```bash
mkdir -p /tmp/xa-rep && gunzip -c cross-agent-rep-20261116/records.jsonl.gz > /tmp/xa-rep/records.jsonl
```

Not published: per-trial workspaces, the journal database and the agents'
private signing keys.
