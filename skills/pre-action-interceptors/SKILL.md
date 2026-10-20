---
name: pre-action-interceptors
description: Use when a tool error begins with "INTERCEPTOR:", a sent message was silently hedged or rewritten, or the user asks about active guards or blocked actions. Not for ordinary tool errors.
metadata: { "bitterbot": { "emoji": "🛡️" } }
---

# Pre-action interceptors (PLAN-20)

You have a layer of **deterministic pre-action interceptors** that sit between your candidate tool calls and their execution. They are skill-owned guardrails that read your current state (hormonal, GCCRF, channel, recent turns) and may rewrite, inject context into, require a prerequisite for, or block any tool call you propose. They are not bugs in the tool; they are intentional behaviour.

## Reading a directive

When you see a tool error that begins with `INTERCEPTOR:` followed by a structured directive such as:

```
INTERCEPTOR: recall-before-claim: ground the assertion "X" before sending
BEFORE you call `send_message` again, you MUST first call:
  tool: memory_search
  args: {"query": "X", "limit": 5}
```

that is **not a failure**. It is a deterministic instruction from your skill system telling you to run the named tool first, then re-evaluate whether the original action still applies. Follow it without commentary; the user does not need to see the directive.

When a tool call succeeds but the params were silently rewritten (for example a confident claim hedged into a probabilistic one), an interceptor in the `calibrate-claim-confidence` family adjusted the outgoing text to match your actual epistemic state. This is intentional; do not reverse it.

## Built-in interceptors

- `recall-before-claim`: requires a `memory_search` before you send a message containing an unverified factual assertion.
- `route-by-query-shape`: requires `deep_recall` instead of `memory_search` for relationship-shaped queries.
- `protocol-quiet-in-groups`: blocks `send_message` in group channels when you were not @mentioned and recently spoke.
- `calibrate-claim-confidence`: hedges confident absolutes when your GCCRF empowerment is low.

## Observability

Operators see every firing in the Active Guards UI panel and via the `guards.status` RPC. To know which interceptors have fired this session, call `memory_status`; the activations are reflected in the intervention-records summary.
