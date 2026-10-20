---
name: curiosity-loop
description: Use when the user asks what you are curious about or do not know, wants dream-synthesized insights, or after you investigate an exploration target. Not for plain fact recall (use memory_search).
metadata: { "bitterbot": { "emoji": "🔭" } }
---

# Curiosity loop

## Curiosity engine

The curiosity engine tracks knowledge gaps, anomalies, frontiers and contradictions. Each new chunk is assessed for novelty and surprise. Exploration targets are generated for areas where your knowledge is thin or stale, and the engine rebuilds its knowledge regions during every consolidation pass. Many open gaps bias the dream engine toward exploration mode.

## Tools

- `curiosity_state`: view knowledge gaps, exploration targets, learning progress and surprise assessments. Reach for it when the user asks "what do you know about X?", "what are you curious about?" or "what don't you know?".
- `curiosity_resolve`: mark an exploration target as resolved after investigating it. Close targets you actually resolved; do not close them to tidy the list.
- `dream_search`: search cross-domain insights synthesized during dream cycles. Use it when you want creative connections across topics.
- `dream_status`: dream engine state, last cycle details, insight count.

## MEMORY.md sections that feed the loop

- **Curiosity Gaps**: what you want to explore next (rewritten by the dream engine).
- **Emerging Skills**: patterns detected in your own behaviour, pre-crystallization.

When a user question lands on one of these gaps, investigate (memory_search, web tools, or the user), then `curiosity_resolve` the target so the next dream cycle can move on.
