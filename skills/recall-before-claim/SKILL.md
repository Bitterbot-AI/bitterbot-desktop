---
name: recall-before-claim
description: Forces a memory_search before the agent sends a message containing a factual assertion that has not yet been grounded this turn. Closes the citation-rate gap from ~40% to ~90%+.
tier: executable
bitterbot:
  always: false
  interceptors:
    - id: recall-before-claim:default
      builtin: true
      activates_on: send_message-shaped tools when draft contains an unverified factual assertion
      intervention: require_prereq memory_search
---

# recall-before-claim

This skill installs a deterministic guard around the agent's outgoing messages. When the candidate message contains a factual-assertion shape ("X is Y", "A did B") and no memory tool (memory_search / deep_recall / knowledge_graph_search) has fired in the current turn, the interceptor requires a `memory_search` call against the assertion's subject before the message goes out.

## Why this exists

Bitterbot has a strong memory system, but it only helps the user if the agent actually consults it before making claims. In practice the agent skips memory recall a meaningful fraction of the time — relying on its in-context knowledge instead. This produces ungrounded assertions that the user has no easy way to spot.

The interceptor closes that loop without depending on the LLM remembering to do it.

## What you'll see

When this fires, the agent will run a `memory_search` first, integrate the result, and then send. You may notice slightly longer responses to factual questions; you should notice that the agent stops making confidently wrong statements about things it actually has memory of.

## How it decides not to fire

- Opinion shapes ("I think", "maybe", "in my opinion") are skipped.
- Questions are skipped.
- If a memory tool already fired in the last ~30 seconds, the assertion is considered grounded.

## Implementation

Built-in interceptor `recall-before-claim:default` lives in `src/agents/skills/builtin-interceptors/recall-before-claim.ts`. Fires at most 8 times per session.
