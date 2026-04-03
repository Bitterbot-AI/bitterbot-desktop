---
summary: "Context: what the model sees, how it is built, and how to inspect it"
read_when:
  - You want to understand what "context" means in Bitterbot
  - You are debugging why the model "knows" something (or forgot it)
  - You want to reduce context overhead (/context, /status, /compact)
title: "Context"
---

# Context

"Context" is **everything Bitterbot sends to the model for a run**. It is bounded by the model's **context window** (token limit).

Beginner mental model:

- **System prompt** (Bitterbot-built): rules, tools, skills list, time/runtime, endocrine state, and injected workspace files.
- **Conversation history**: your messages + the assistant's messages for this session.
- **Tool calls/results + attachments**: command output, file reads, images/audio, etc.

Context is _not the same thing_ as "memory": memory can be stored on disk and reloaded later; context is what's inside the model's current window.

## Quick start (inspect context)

- `/status` → quick "how full is my window?" view + session settings.
- `/context list` → what's injected + rough sizes (per file + totals).
- `/context detail` → deeper breakdown: per-file, per-tool schema sizes, per-skill entry sizes, and system prompt size.
- `/usage tokens` → append per-reply usage footer to normal replies.
- `/compact` → summarize older history into a compact entry to free window space.

See also: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction).

## Example output

Values vary by model, provider, tool policy, and what's in your workspace.

### `/context list`

```
Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- GENOME.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- PROTOCOLS.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- MEMORY.md: OK | raw 2,841 chars (~710 tok) | injected 2,841 chars (~710 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, ...
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
Context breakdown (detailed)
...
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
... (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
... (+N more tools)
```

## What counts toward the context window

Everything the model receives counts, including:

- System prompt (all sections).
- Conversation history.
- Tool calls + tool results.
- Attachments/transcripts (images/audio/files).
- Compaction summaries and pruning artifacts.
- Provider "wrappers" or hidden headers (not visible, still counted).

## How Bitterbot builds the system prompt

The system prompt is **Bitterbot-owned** and rebuilt each run. It includes these sections, in order:

1. **Endocrine State** — Current emotional state (dopamine/cortisol/oxytocin levels), tone modulation briefing, phenotype summary, session handover brief, and developmental note for young agents. Injected early so the model sees its emotional state before any instructions.
2. **Tool list** + short descriptions.
3. **Skills list** (metadata only; see below).
4. **Workspace location**.
5. **Time** (UTC + converted user time if configured).
6. **Runtime metadata** (host/OS/model/thinking).
7. **Injected workspace bootstrap files** under **Project Context**.

Full breakdown: [System Prompt](/concepts/system-prompt).

### Endocrine State section

The `## Endocrine State` section is built from live hormonal state and includes:

- **Hormone levels** — Dopamine, cortisol, oxytocin with labels: `(DOMINANT)`, `(active)`, or `(baseline)`.
- **Tone modulation** — Natural-language instruction like "be enthusiastic and celebrate wins" or "be focused and concise, minimize tangents."
- **Phenotype summary** — First sentence of the Phenotype section from MEMORY.md (the agent's self-concept).
- **Session handover brief** — A compact summary from the previous session, providing cross-session continuity (e.g., "Last session: discussed GCCRF alpha annealing, user prefers terse responses"). Gated by the Session Continuity Gate — only injected if cosine similarity with current context exceeds 0.25. Includes an entity snapshot (files, functions, config keys) for anaphora resolution.
- **Developmental note** — For immature agents (maturity < 15%), guidance to be curious and exploratory.

The model is instructed to **embody** the emotional state naturally without mentioning it. This produces organic personality variation. See [Emotional System](../memory/emotional-system.md) for details.

## Injected workspace files (Project Context)

By default, Bitterbot injects a fixed set of workspace files (if present):

- `GENOME.md` — immutable identity blueprint
- `MEMORY.md` — living working memory (rewritten by Dream Engine)
- `PROTOCOLS.md` — operating procedures
- `TOOLS.md` — environment-specific notes
- `HEARTBEAT.md` — periodic check instructions

Large files are truncated per-file using `agents.defaults.bootstrapMaxChars` (default `20000` chars). Bitterbot also enforces a total bootstrap injection cap across files with `agents.defaults.bootstrapTotalMaxChars` (default `24000` chars). `/context` shows **raw vs injected** sizes and whether truncation happened.

## Skills: what's injected vs loaded on-demand

The system prompt includes a compact **skills list** (name + description + location). This list has real overhead.

Skill instructions are _not_ included by default. The model is expected to `read` the skill's `SKILL.md` **only when needed**.

## Tools: there are two costs

Tools affect context in two ways:

1. **Tool list text** in the system prompt (what you see as "Tooling").
2. **Tool schemas** (JSON). These are sent to the model so it can call tools. They count toward context even though you don't see them as plain text.

Notable tools that affect context behavior:

- **`deep_recall`** — Spawns a sandboxed sub-LLM that writes and executes search code against the full memory database and session history. Allows the agent to reason over arbitrarily long context without loading it all into the main window. See [Deep Recall](../memory/deep-recall.md).
- **`expand_message`** — Retrieves the original full content of messages that were truncated by progressive compression. Uses SHA-256 fingerprints to reference stored originals.
- **`create_emotional_anchor` / `recall_emotional_anchor`** — Bookmark and retrieve significant emotional moments. Recalled anchors blend their hormonal state into the current endocrine state.
- **`working_memory_note`** — Write urgent notes to MEMORY.md scratch buffer between dream cycles. Accepts an optional `type` parameter (`experience`, `directive`, `world_fact`, `mental_model`) for epistemic layer classification.

`/context detail` breaks down the biggest tool schemas so you can see what dominates.

## Context efficiency: compression and caching

Bitterbot uses two systems to keep context usage efficient:

### Progressive compression

Before expensive LLM-based compaction, a **deterministic pre-compression pass** runs:

1. **Truncate old tool results** — Large tool outputs older than the last few are shortened to a configurable token threshold (default: 4096 tokens). Truncated content is stored in-memory and recoverable via `expand_message`.
2. **Truncate old messages** — User/assistant messages beyond the recent window are shortened (default: 2048 tokens).
3. **Middle-out removal** — If message count exceeds the hard cap (default: 320), messages from the middle of the conversation are removed, preserving the beginning (context) and end (recent exchange).

This means short conversations see no compression, medium conversations get cheap truncation only, and long conversations get truncation first then LLM summarization on the reduced set.

### Tool result caching

An in-memory LRU cache (default: 500 entries, 5-minute TTL) stores tool execution results. Repeated identical tool calls (same tool name + same arguments) return cached results instead of re-executing. Eligible tools: `read`, `web_search`, `web_fetch`, `image`, `memory_search`.

This reduces token usage by avoiding redundant tool output in the context window.

## Commands, directives, and "inline shortcuts"

Slash commands are handled by the Gateway. There are a few different behaviors:

- **Standalone commands**: a message that is only `/...` runs as a command.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` are stripped before the model sees the message.
  - Directive-only messages persist session settings.
  - Inline directives in a normal message act as per-message hints.
- **Inline shortcuts** (allowlisted senders only): certain `/...` tokens inside a normal message can run immediately (example: "hey /status"), and are stripped before the model sees the remaining text.

Details: [Slash commands](/tools/slash-commands).

## Sessions, compaction, and pruning (what persists)

What persists across messages depends on the mechanism:

- **Normal history** persists in the session transcript until compacted/pruned by policy.
- **Compaction** persists a summary into the transcript and keeps recent messages intact. Progressive compression runs as a pre-pass before LLM summarization.
- **Pruning** removes old tool results from the _in-memory_ prompt for a run, but does not rewrite the transcript.

Docs: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

## What `/context` actually reports

`/context` prefers the latest **run-built** system prompt report when available:

- `System prompt (run)` = captured from the last embedded (tool-capable) run and persisted in the session store.
- `System prompt (estimate)` = computed on the fly when no run report exists (or when running via a CLI backend that doesn't generate the report).

Either way, it reports sizes and top contributors; it does **not** dump the full system prompt or tool schemas.
