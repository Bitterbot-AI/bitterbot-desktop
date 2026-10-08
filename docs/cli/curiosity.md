---
summary: "CLI reference for `bitterbot curiosity` (status/list/pause/resume/ask/dismiss/run)"
read_when:
  - You want to see what the agent is wondering about and what it learned on its own
  - You want to pause autonomous research, or hand the agent a question
title: "curiosity"
---

# `bitterbot curiosity`

The curiosity loop from the terminal: the same view and controls as the
Curiosity page in the Control UI. The agent researches its own open
questions on a schedule without asking; this is where you see it and stop it.

Related:

- How it works: [Curiosity and search](/memory/curiosity-and-search)
- What leaves the node: [Egress](/network/egress)

## Examples

```bash
bitterbot curiosity status
bitterbot curiosity list
bitterbot curiosity ask "How does the IPFS DHT crawler estimate reachable nodes?"
bitterbot curiosity dismiss abcdef12
bitterbot curiosity pause
bitterbot curiosity resume
bitterbot curiosity run
```

## Commands

- `status` — exploring, paused, or off (and which config key turned it off);
  today's questions against the budget; when the next pass runs; how many
  facts it learned, how many came up in conversation, and what they cost.
- `list` — open questions (with their source, attempts, and the search phrase
  it refused to send, if any), what it learned (answer, confidence, sources,
  whether it was used, cost; dimmed items were found but not confident
  enough to remember), and questions set aside.
- `ask <question>` — queue a question at top priority. Near-duplicates of an
  open or recently answered question are not queued.
- `dismiss <id>` — close a question for good. A unique id prefix from `list`
  is enough.
- `pause` / `resume` — stop or restart the schedule. Pause persists across
  restarts.
- `run` — research now instead of waiting for the next pass. Counts against
  the day's budget; the pass runs in the background, so check `list` after a
  few minutes.

`--json` on `status` and `list` prints the raw payload.

## Configuration

`memory.curiosity.research` in `bitterbot.json`: `enabled` (default true when
web search is configured), `intervalMinutes` (240), `maxPerDay` (10),
`maxPagesPerTarget` (3), `minConfidence` (0.45), `blockedDomains`,
`strictEgress` (false). See [Curiosity and search](/memory/curiosity-and-search).
