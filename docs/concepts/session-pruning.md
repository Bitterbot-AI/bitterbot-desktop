---
title: "Session Pruning"
summary: "Session pruning (agents.defaults.contextPruning) is inert; old tool outputs are handled by compaction"
read_when:
  - You found agents.defaults.contextPruning in a config and want to know what it does
  - You want to reduce LLM context growth from tool outputs
---

# Session Pruning

`agents.defaults.contextPruning` (the `cache-ttl` tool-result trimming of the
old embedded engine) has **no effect** in the owned runtime. Nothing trims tool
results from the in-memory context on a cache TTL any more.

- The key is still accepted so existing configs parse. It warns once at load
  and will be removed next release.
- `bitterbot doctor` lists it under deprecated config keys, and
  `bitterbot doctor --fix` removes it.
- See [LIMITATIONS.md](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/LIMITATIONS.md)
  ("Execution and isolation") for the full list of inert keys.

## What handles tool-output growth now

Compaction does. With `agents.defaults.compaction.offload.toolOutputStubs`
(default `true`), once a turn passes the mid-turn trigger the oldest tool
outputs in the window are replaced by a stub naming the tool call id. The
session transcript on disk keeps the full text, and
[recall_range](/tools/recall-range) returns it on demand. See
[Compaction](/concepts/compaction) and the `agents.defaults.compaction` section
of the [configuration reference](/gateway/configuration-reference).
