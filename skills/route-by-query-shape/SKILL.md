---
name: route-by-query-shape
description: When the agent calls memory_search with a relationship-shaped query ("who did I talk to about X"), redirect to the knowledge_graph backend where it will actually find the answer.
tier: executable
bitterbot:
  always: false
  interceptors:
    - id: route-by-query-shape:relationship
      builtin: true
      activates_on: memory_search with relationship-shaped query
      intervention: modify (route to knowledge_graph backend)
---

# route-by-query-shape

When you ask Bitterbot a relationship question — "who did I talk to about Q4?", "who worked with me on Foo?" — the vector-based `memory_search` often misses because the answer lives in entity relationships, not in chunk text. The graph backend gets these right.

This interceptor watches `memory_search` calls, detects relationship-shaped queries, extracts the salient entity, and re-routes the call to the graph backend before it executes.

## What you'll see

For relationship questions, the agent will hit the knowledge graph rather than searching through unstructured text. Expect noticeably better hit rates on "who did X with Y" style questions.

## Implementation

Built-in interceptor `route-by-query-shape:relationship` lives in `src/agents/skills/builtin-interceptors/route-by-query-shape.ts`. Fires up to 12 times per session.
