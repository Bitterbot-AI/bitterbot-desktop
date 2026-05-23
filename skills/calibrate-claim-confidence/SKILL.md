---
name: calibrate-claim-confidence
description: When the agent's epistemic state (GCCRF) indicates low empowerment and falling certainty, hedges out confident absolutes ("definitely", "always", "100%") in outgoing messages.
tier: executable
bitterbot:
  always: true
  interceptors:
    - id: calibrate-claim-confidence:default
      builtin: true
      activates_on: send_message-shaped tools when GCCRF empowerment < 0.3 and certaintyDelta < 0
      intervention: modify (hedge confident absolutes)
---

# calibrate-claim-confidence

Bitterbot has an epistemic state (the GCCRF reward function) that quantifies how empowered the agent feels by its current knowledge: high empowerment means it has corroborated context, low means it's running on uncertain ground. When the agent is about to send a message containing confident absolutes ("definitely", "certainly", "always", "100%") but its empowerment is low and its certainty is dropping, this interceptor rewrites the message into hedged language.

This is the canonical example of state-binding: no other agent framework reads `gccrf.empowerment` to decide whether to hedge an outgoing statement.

## What you'll see

When the agent is uncertain, you will see softer language: "likely" instead of "definitely", "typically" instead of "always", "it appears" instead of "obviously". When it is confident (high empowerment, rising certainty), absolutes are left intact.

## Implementation

Built-in interceptor `calibrate-claim-confidence:default` lives in `src/agents/skills/builtin-interceptors/calibrate-claim-confidence.ts`. Fires up to 6 times per session.
