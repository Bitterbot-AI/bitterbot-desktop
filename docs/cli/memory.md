---
summary: "CLI reference for `bitterbot memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `bitterbot memory`

Manage semantic memory indexing and search.
Memory tools are built into the agent.

Related:

- Memory concept: [Memory](/concepts/memory)
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
