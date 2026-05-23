---
name: protocol-quiet-in-groups
description: Enforces PROTOCOLS.md "stay quiet in group chats" deterministically. Blocks outbound messages in Discord/Telegram/Slack/etc group channels when the bot was not @mentioned and recently spoke.
tier: executable
bitterbot:
  always: true
  interceptors:
    - id: protocol-quiet-in-groups:default
      builtin: true
      activates_on: send_message-shaped tools on group channels
      intervention: block
---

# protocol-quiet-in-groups

In group channels (Discord, Telegram, Slack, WhatsApp groups, Google Chat rooms, IRC), the agent should usually observe more than it speaks. PROTOCOLS.md captures this as a "speak ~1 in 5 turns" rule, but as a prompt-level instruction it is fragile under high-engagement conditions.

This interceptor makes the rule deterministic. If the agent is in a group channel AND was not @mentioned in the last 3 turns AND has spoken within the past minute (or is in the first few turns of joining), it silently blocks the next outbound message.

## What you'll see

In group chats you will notice the agent participating less often than it would otherwise. When it is directly addressed (@bitterbot or @bot), the block is bypassed and the agent responds normally.

## Implementation

Built-in interceptor `protocol-quiet-in-groups:default` lives in `src/agents/skills/builtin-interceptors/protocol-quiet-in-groups.ts`. High priority (90) so it short-circuits ahead of recall/calibration when it fires. Up to 50 fires per session.
