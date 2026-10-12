---
summary: "CLI reference for `bitterbot memory` (status/index/search, forget/edit/export/import)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
  - You want to forget, correct, export or import memories from the terminal
title: "memory"
---

# `bitterbot memory`

Manage semantic memory indexing and search, and the owner's controls over what the agent remembers.
Memory tools are built into the agent.

Related:

- Memory concept: [Memory](/concepts/memory)
- Owner controls: [Your memory controls](/memory/controls)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
bitterbot memory status
bitterbot memory status --deep
bitterbot memory status --deep --index
bitterbot memory status --deep --index --verbose
bitterbot memory index
bitterbot memory index --verbose
bitterbot memory search "release checklist"
bitterbot memory status --agent main
bitterbot memory index --agent main --verbose
bitterbot memory backfill-embeddings --agent main
bitterbot memory forget fact_0f3c... --preview
bitterbot memory forget fact_0f3c... --yes
bitterbot memory edit fact_0f3c... "The deploy endpoint is api2.acme.com." --yes
bitterbot memory export
bitterbot memory export --out ~/memory.json
bitterbot memory export --out - > memory.json
bitterbot memory import ~/memory.json --dry-run
bitterbot memory import ~/memory.json
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- `memory backfill-embeddings` embeds and indexes crystals stored with placeholder embeddings (extracted facts, scratch notes, handover briefs) so they become searchable through both vector and keyword channels. The gateway also runs this automatically (bounded) at the end of each sync cycle; the command exists to clear a large backlog on demand. Use `--limit <n>` to cap chunks embedded per batch.

## Owner controls

These go through the same code as the Memory page and the `memory.*` gateway RPCs. They open the agent's memory database directly, so they work whether or not the gateway is running.

- `memory forget <id>`: shows what forgetting the memory would also change (facts retired, your facts kept and listed, graph links closed, dream insights flagged) and stops. `--yes` applies exactly that plan; if anything changed since the preview, it refuses and changes nothing. `--preview` only shows the plan. Memories indexed from files are refused ("change the file instead"); memories indexed from a conversation can be forgotten.
- `memory edit <id> <text>`: the same for replacing a memory's text. The new text becomes a new memory; the old one is forgotten with its cascade, except what still holds in the new text. `--yes` to apply.
- `memory export [--out <file>] [--format v2]`: writes the export (version 2, readable by version 1 readers) to `~/.bitterbot/exports/memory-<time>.json` (0600), to `<file>`, or to stdout with `--out -`, and prints the path of the raw database. Credential-shaped text is redacted. Only `v2` is written.
- `memory import <file> [--dry-run] [--keep-owner-tier] [--yes]`: restores an export (version 1 or 2) as the owner. `--dry-run` prints the counts (including `Owner-tier grants`) and writes nothing. Files over 64 MB are refused. Imported facts land at the extraction tier, including facts that were yours in the export, so a hand-edited or third-party export cannot carry owner authority by accident; those are listed after the import, and you confirm one by pinning it (`bitterbot gateway call memory.pinFact`). `--keep-owner-tier` keeps them at your tier: it prints "This will give N facts owner authority (they will override the agent and win every conflict)" and asks y/N; `--yes` skips the question, and without a terminal and without `--yes` it refuses. The full rules are in [Export and import](/memory/controls#export-and-import).

All four take `--agent <id>` and `--json`.
