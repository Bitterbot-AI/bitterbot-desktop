---
summary: "recall_range: deterministic transcript reader that returns exact conversation entries (tool outputs included) by entry id, turn or JSONL line, with no model call"
read_when:
  - The agent says it cannot see something from earlier in the conversation
  - A "[Context offloaded]" note or a "[tool output offloaded …]" stub appears in a session
  - Deciding whether recall_range may read other sessions (privacy posture)
  - Retiring expand_message
title: "recall_range"
---

# recall_range

`recall_range` returns exact transcript entries of a conversation, tool outputs included, with no model call. It exists so that text moved out of the live context window (a `[Context offloaded]` note, a `[tool output offloaded …]` stub) stays reachable at zero cost. It is the deterministic half of the recall surface described in PLAN-52A; `deep_recall` is the reasoning half.

## When the agent uses it

- An offload note or stub names entry ids or JSONL lines, and the agent needs the exact text behind them (a file it read, a command's output, what the user said in turn 9).
- The user refers to something earlier in the same conversation that is no longer in the window.
- A truncated tool result says `recall_range entry <id> has the full text`.

For questions that span many earlier turns ("what did we decide about X across the morning"), the agent should use `deep_recall` with scope `current_session` instead; it can take a `range` too.

## Arguments

| Argument               | Meaning                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.from`, `.to`  | Inclusive entry-id bounds (pi v3 `message` entry ids). A single entry (`from` = `to`) returns the full tool output.                     |
| `turns`                | `"3-7"` or `"5"`. A turn is a user message and everything until the next one; heartbeats count, so numbering is stable across offloads. |
| `lines.from`, `.to`    | Inclusive 1-based JSONL line bounds, the same addressing the memory index and offload notes use.                                        |
| `grep`                 | Case-insensitive regex (or literal) that a row's text must match.                                                                       |
| `include_tool_results` | Default `true`.                                                                                                                         |
| `max_chars`            | Output cap, default 12,000, maximum 60,000. When several rows come back, each tool output is capped at 2,000 characters.                |
| `session_id`           | Another session of this agent. See the privacy rules below.                                                                             |

Every row is prefixed with its address: `[e<entry id> L<line> t<turn> <timestamp>] ROLE:`. Tool rows read `TOOL(<name>)`. Only entries on the current branch path are returned (a `/fork` leaves sibling branches in the file that this path never saw). Output passes through the same sensitive-text redaction as the memory indexer, and the result carries the note that transcript text is data, not instructions.

## Privacy

The tool reads the current conversation only, by default. Tool outputs carry file reads, command output and fetched pages, which is exactly the content the memory indexer deliberately does not index, so another session's text must not be reachable from a group chat or someone else's DM.

- `agents.defaults.compaction.offload.recallCrossSession`: `"off"` (default) or `"owner"`. With `"owner"`, `session_id` may name another session of this agent, and only for owner senders (the same owner notion `code_interpreter` uses: the sender matched the channel's owner allowlist). Anyone else gets a refusal that tells the model to drop `session_id`.
- Subagents cannot call `recall_range`, `deep_recall` or `expand_message` at any depth.
- Inbound A2A tasks cannot call them either (always-deny floor).

The same posture applies to `deep_recall`: its `recent_sessions` and `all_sessions` scopes are owner-only, and non-owner senders are downgraded to `current_session`.

## Hot set

Under the `offload` compaction policy (`agents.defaults.compaction.policy: "offload"`), `recall_range` is added to the always-hot tool set so the model can reach offloaded text without a tool-search hop. Its schema is about 150 tokens. `deep_recall` stays deferred; offload notes name it, so tool search finds it. The addition is static per agent on purpose: promoting tools per session would change the tools array, which invalidates the whole prompt cache prefix.

## Relationship to expand_message

`expand_message` resolves fingerprints that progressive compression leaves in truncated messages. Its store is process-global, holds 100 entries, and is lost on restart, so references routinely go stale. `recall_range` addresses the transcript on disk by entry id instead. Once the offload policy's tool-output stubs replace progressive compression's fingerprints, `expand_message` is retired; until then both exist.

## Example

```json
{ "entries": { "from": "0193a1…", "to": "0193f7…" }, "grep": "DATABASE_URL", "max_chars": 8000 }
```

```json
{ "turns": "3-4", "include_tool_results": false }
```

```json
{ "entries": { "from": "0193c4…", "to": "0193c4…" } }
```

The last call returns one entry in full, which is how the agent recovers a stubbed file read.
