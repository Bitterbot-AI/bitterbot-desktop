---
summary: "CLI reference for `bitterbot heartbeat` — inspect what the heartbeat considered"
read_when:
  - You're debugging "why didn't the agent do X?" on the heartbeat path
  - You want to see what each heartbeat tick acted on, skipped, or blocked
title: "heartbeat"
---

# `bitterbot heartbeat`

Inspect the heartbeat-runner's append-only **considerations log** —
the persistent record of what the heartbeat thought about each cycle,
including options it ultimately skipped or blocked. Complements the
existing `system-events` queue (which records what the heartbeat
acted on).

Storage: per-day NDJSON at `~/.bitterbot/heartbeat/considerations-YYYY-MM-DD.ndjson`.
30-day retention. An in-memory ring of the last 1000 entries gives the
CLI a fast read path without touching disk.

## `heartbeat why`

Show recent considerations, newest first.

```bash
bitterbot heartbeat why
bitterbot heartbeat why --session "agent-foo:main"
bitterbot heartbeat why --category trigger --decision skipped
bitterbot heartbeat why --day 2026-04-25 --limit 100
bitterbot heartbeat why --json
```

Options:

- `--session <key>` — filter by session key.
- `--category <name>` — filter by category. Valid values: `trigger`, `skill-eligibility`, `channel-route`, `bounty-match`, `dream-target`, `skill-crystallize`, `compaction`, `spawn`, `other`.
- `--decision <name>` — filter by decision. Valid values: `acted`, `skipped`, `deferred`, `blocked`.
- `--limit <n>` — max rows (default 50, max 500).
- `--day <YYYY-MM-DD>` — read from a specific day's NDJSON file (default: in-memory ring).
- `--json` — output JSON.

Output format (TTY):

```
2026-04-25T14:23:11.045Z  acted    channel-route        agent-a:main  heartbeat → telegram
    delivered heartbeat payload
2026-04-25T14:22:11.001Z  blocked  channel-route        agent-a:main  heartbeat → telegram
    alerts disabled for this channel/account; indicator only
```

The reason line below each row is one sentence — meant to read like a
log message a human could scan. Long subjects are truncated to 50 chars.

## `heartbeat today`

Print the day-key for today's persisted considerations file. Useful for
scripting or for finding the path on disk.

```bash
bitterbot heartbeat today
# Day key: 2026-04-25
```

## What's instrumented

The runner emits a consideration alongside every meaningful heartbeat
decision. Today's instrumented points (in `src/infra/heartbeat-runner.ts`):

- `empty-heartbeat-file` — heartbeat file is empty (skipped).
- `alerts-disabled` (early) — alerts/ok/indicator all off (blocked).
- `ok-empty` — agent ran but produced no output (acted).
- `ok-token` — agent returned only an ack token (acted).
- `duplicate` — agent reply matched the previous heartbeat output (skipped).
- `no-target` — delivery channel/to missing (blocked).
- `alerts-disabled` (post-build) — alerts off for this channel (blocked).
- `channel not ready` — plugin readiness check failed (deferred).
- `sent` — delivered heartbeat payload (acted).

Adding more is mechanical — call `recordConsideration({...})` next to
the existing `emitHeartbeatEvent({...})` at the decision point.

## Live runtime state (cache + breaker)

The considerations log is file-based and survives restarts. For
**in-memory** state — prompt cache hit ratios per session and
compaction circuit breaker state — see `bitterbot doctor`'s "Agent
runtime" section, which calls the `agent.runtime.health` RPC against
the running gateway.
