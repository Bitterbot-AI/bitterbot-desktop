---
summary: "Context window + compaction: how Bitterbot keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Context Window & Compaction

Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, Bitterbot **compacts** older history to stay within limits.

## What compaction is

Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:

- The compaction summary
- Recent messages after the compaction point

Compaction **persists** in the session’s JSONL history.

## Configuration

Use the `agents.defaults.compaction` setting in your `bitterbot.json` to configure compaction behavior (mode, target tokens, etc.).

## Auto-compaction (default on)

When a session nears or exceeds the model’s context window, Bitterbot triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:

- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, Bitterbot can run a **silent memory flush** turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Mid-turn budget guard

A long single-turn tool loop (e.g. 50 tool calls each adding 100KB+ of
output) can grow context unboundedly between LLM calls within one
agent run. The mid-turn guard fires after every tool result:

1. Cheap char check — skip if total session message chars < 80,000.
2. Token estimate — skip if estimated tokens < 80% of the model's context window.
3. Otherwise, run **progressive compression** (deterministic, no LLM call) targeting 65% of the context window, and replace session messages in place via `session.agent.replaceMessages`.

This is the same operation pi-coding-agent uses for its own auto-compaction,
so it's safe to invoke from inside an active run. Heavy LLM-based summary
compaction stays in the existing flow and runs between turns.

The guard emits a `compaction` agent event with `phase=mid-turn-budget`
when it fires, including before/after token and message counts.

## Compaction circuit breaker

If full LLM-based compaction fails repeatedly for the same session
(malformed transcript, persistent provider 5xx, summary failure), the
breaker opens after **3 consecutive failures** and short-circuits
subsequent attempts with a 10-minute cooldown. Cooldown doubles on each
re-open up to 1 hour.

States:

- **closed** — compaction runs normally.
- **open** — compaction is short-circuited; the caller falls back to oldest-tool-result truncation. The user is told via system event.
- **half-open** — after the cooldown elapses, exactly one trial compaction is allowed. Success returns to closed; failure returns to open with the doubled cooldown.

"We deliberately chose not to compact" outcomes (`below_threshold`,
`no_compactable_entries`, `already_compacted_recently`, `guard_blocked`)
do not count toward the threshold and reset the failure counter.

Live state is observable via the `agent.runtime.health` RPC and surfaced
in `bitterbot doctor`.

## Manual compaction

Use `/compact` (optionally with instructions) to force a compaction pass:

```
/compact Focus on decisions and open questions
```

## Context window source

Context window is model-specific. Bitterbot uses the model definition from the configured provider catalog to determine limits.

## Progressive compression (pre-compaction)

Before expensive LLM-based compaction, Bitterbot runs a **deterministic pre-compression pass** that reduces token count cheaply:

1. **Truncate old tool results** — Large tool outputs older than the most recent few are shortened (default threshold: 4096 tokens). Truncated content is stored in-memory and recoverable via the `expand_message` tool.
2. **Truncate old messages** — User/assistant messages beyond the recent window are shortened (default: 2048 tokens).
3. **Middle-out removal** — If message count exceeds the hard cap (default: 320), messages from the middle are removed, preserving beginning (context) and end (recent exchange).

This means:

- **Short conversations** — no compression at all
- **Medium conversations** — cheap truncation only, no LLM calls
- **Long conversations** — truncation first, then LLM summarization on the reduced set

Configure via `agents.defaults.compression` (enabled by default).

## Compaction vs pruning vs progressive compression

| Mechanism                   | What it does                                              | Persists?                                                  | When it runs                                             |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| **Progressive compression** | Deterministic truncation of old tool results and messages | No (in-memory, originals recoverable via `expand_message`) | Before compaction                                        |
| **Compaction**              | LLM summarization of older conversation                   | Yes (JSONL)                                                | On auto-trigger or `/compact`                            |
| **Session pruning**         | Trims old tool results                                    | No (in-memory, per request)                                | Before each LLM call (when TTL-based pruning is enabled) |

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated by progressive compression; session pruning can further reduce tool-result buildup.
- If the agent needs content from a truncated message, it can use `expand_message` to retrieve the original.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
