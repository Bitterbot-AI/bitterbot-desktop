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

A long single-turn tool loop (for example 50 tool calls each adding 100KB+ of
output) can grow the context between model calls within one agent run. The
guard runs before every model call of a run, on the context that call is about
to send:

1. Re-apply the tool-output stubs already recorded for this session.
2. Cheap char check: skip if the message text is under 80,000 chars.
3. Token estimate (messages plus the system prompt): skip if under 80% of the model's context window.
4. Stub the oldest tool outputs toward 50% of the window (see [Tool-output stubs](#tool-output-stubs-mid-turn-lossless)) and record them in the transcript.
5. If the context is still over the trigger, run **progressive compression** (deterministic truncation, no LLM call) toward 65% of the window, for this call only.

The transcript on disk is never modified; only the context sent to the model
is. Heavy LLM-based summary compaction stays in the existing flow and runs
between turns.

The guard emits a `compaction` agent event with `phase=in-run-budget` when it
acts, with before/after token estimates, the number of new stubs, and whether
truncation ran.

Before 2026-10 the guard ran after each tool result and edited the session's
message list. The agent loop sends a snapshot taken when the run starts, so
that edit never reached the model during the run in flight; the guard now runs
on the loop's per-call context hook instead.

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

## Tool-output stubs (mid-turn, lossless)

When a single turn's tool loop passes 80% of the context window, Bitterbot first replaces the oldest tool outputs with a one-line stub that names the tool call id. Nothing is lost: the transcript keeps the full output and the agent fetches it with [`recall_range`](/tools/recall-range). The two most recent outputs and small outputs are left alone. Stubs are recorded in the transcript and re-applied every turn, so they also survive a restart. See `agents.defaults.compaction.offload.toolOutputStubs` (default on).

## Compaction policies

`agents.defaults.compaction.policy` selects how the context is compacted between turns and on overflow:

- `summary` (default): an LLM summary of the history before a token-based cut point replaces that history.
- `offload`: a horizon cut at a user-turn boundary. The replaced history becomes a ledger: what range was moved out, where it is in the transcript (entry ids and JSONL lines), the user's threads, and how to reach it ([`recall_range`](/tools/recall-range), `deep_recall`), followed by a short cheap-model summary. When there is no boundary to cut at (one long turn), old tool outputs are stubbed instead. `/compact` still produces an LLM summary.

After an offload, each new user message is searched against the offloaded dialogue and up to three matching excerpts are placed in front of it automatically (`compaction.offload.proactiveRecall`), so the model does not have to decide to look. Tool outputs are not included; `recall_range` returns those on request.

The offload policy also drops bare heartbeat pairs (the heartbeat prompt and a plain acknowledgement) from the window; they stay in the transcript, and a heartbeat that carried system events or ran tools is kept. `deep_recall` has a daily budget (`compaction.offload.recallBudgetUsdPerDay`, default $1, counted for the node per UTC day); beyond it the tool points at `recall_range`, which is free.

The policy can be set per agent (`agents.list[].compaction.policy`). The offload policy runs on the `bitterbot` runtime engine (`agents.defaults.runtime.engine`). It triggers after a turn when the prompt exceeds 55% of the context window and before a turn at 70%; the summary policy triggers when less than the reserve is left.

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
