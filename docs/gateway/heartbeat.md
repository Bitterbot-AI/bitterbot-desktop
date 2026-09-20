---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.

Heartbeat runs **periodic agent turns** so the model can surface anything that
needs attention without spamming you. Since the 2026-09-19 token-efficiency
build an idle heartbeat costs nothing: an interval tick whose inputs have not
changed never calls the model, and a tick that does run uses a small isolated
session on a cheap model (see [Cost model](#cost-model)).

Troubleshooting: [/automation/troubleshooting](/automation/troubleshooting)

## Quick start (beginner)

1. Leave heartbeats enabled (default is `30m`, or `1h` for Anthropic OAuth/setup-token) or set your own cadence.
2. Create a tiny `HEARTBEAT.md` checklist in the agent workspace (optional but recommended).
3. Decide where heartbeat messages should go (`target: "last"` is the default).
4. Optional: enable heartbeat reasoning delivery for transparency.
5. Optional: restrict heartbeats to active hours (local time).

Example config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Defaults

- Interval: `30m` (or `1h` when Anthropic OAuth/setup-token is the detected auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  Outside the window, heartbeats are skipped until the next tick inside the window.
- `skipWhenUnchanged: true`, `isolatedSession: true`, `lightContext: true` (all
  default on; see [Cost model](#cost-model)).

### Gate order

Every tick passes these gates in order; the first one that fails ends the tick:

1. **enabled**: heartbeats on, agent has a heartbeat, interval parses.
2. **activeHours**: inside the configured window.
3. **busy**: main command lane is idle (`requests-in-flight` otherwise; retried).
4. **empty-file**: `HEARTBEAT.md` has actionable content (interval ticks only).
5. **hash gate** (`skipWhenUnchanged`): inputs differ from the last completed
   tick (interval and cache-warm ticks only).
6. **run**: the model is called, in the isolated session when eligible.

## What the heartbeat prompt is for

The default prompt is intentionally broad:

- **Background tasks**: “Consider outstanding tasks” nudges the agent to review
  follow-ups (inbox, calendar, reminders, queued work) and surface anything urgent.
- **Human check-in**: “Checkup sometimes on your human during day time” nudges an
  occasional lightweight “anything you need?” message, but avoids night-time spam
  by using your configured local timezone (see [/concepts/timezone](/concepts/timezone)).

If you want a heartbeat to do something very specific (e.g. “check Gmail PubSub
stats” or “verify gateway health”), set `agents.defaults.heartbeat.prompt` (or
`agents.list[].heartbeat.prompt`) to a custom body (sent verbatim).

## Response contract

- If nothing needs attention, reply with **`HEARTBEAT_OK`**.
- During heartbeat runs, Bitterbot treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated
  specially.
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped
and logged; a message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (e.g. "telegram")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
        skipWhenUnchanged: true, // default: true; no model call when inputs are unchanged
        isolatedSession: true, // default: true; run in <main>:heartbeat, fresh transcript
        lightContext: true, // default: true; minimal prompt, HEARTBEAT.md only, cheap model
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` sets global heartbeat behavior.
- `agents.list[].heartbeat` merges on top; if any agent has a `heartbeat` block, **only those agents** run heartbeats.
- `channels.defaults.heartbeat` sets visibility defaults for all channels.
- `channels.<channel>.heartbeat` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) overrides per-channel settings.

### Per-agent heartbeats

If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

Example: two agents, only the second agent runs heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Active hours example

Restrict heartbeats to business hours in a specific timezone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.

### Multi account example

Use `accountId` to target a specific account on multi-account channels like Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Field notes

- `every`: heartbeat interval (duration string; default unit = minutes).
- `model`: optional model override for heartbeat runs (`provider/model`).
- `includeReasoning`: when enabled, also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`).
- `session`: optional session key for heartbeat runs.
  - `main` (default): agent main session.
  - Explicit session key (copy from `bitterbot sessions --json` or the [sessions CLI](/cli/sessions)).
  - Session key formats: see [Sessions](/concepts/session) and [Groups](/channels/groups).
- `target`:
  - `last` (default): deliver to the last used external channel.
  - explicit channel: `whatsapp` / `telegram` / `discord` / `slack` / `signal`.
  - `none`: run the heartbeat but **do not deliver** externally.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id).
- `accountId`: optional account id for multi-account channels. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts; otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.
- `prompt`: overrides the default prompt body (not merged).
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery.
- `skipWhenUnchanged` (default `true`): content-hash gate. Before an interval
  tick calls the model, Bitterbot computes a SHA-256 over exactly three inputs:
  the normalized `HEARTBEAT.md` content (CRLF, trailing spaces and blank-line
  runs ignored; a missing file hashes differently from an empty one), the
  resolved heartbeat prompt body, and the text of the system events queued for
  the heartbeat session. If it matches the hash committed by the last tick whose
  model call completed, the tick is skipped with reason `unchanged-hash` (no API
  call, schedule advances). Nothing else is hashed: not the clock, not the
  model, not the delivery target. `wake`, `exec-event`, `cron:*`, `hook:*`,
  `manual` and `retry` reasons bypass the gate because they carry new input by
  definition. The last hash is kept in memory and at
  `~/.bitterbot/heartbeat/last-input-hash-<agentId>.json` so a restart does not
  trigger a spurious tick.
- `isolatedSession` (default `true`): interval ticks run in
  `agent:<id>:<mainKey>:heartbeat`. The previous isolated entry and its
  transcript are dropped before each run, so the model never sees the main chat
  history or earlier heartbeat turns. Delivery still resolves from the main
  session (`target: "last"` keeps working; the agent's `message` tool has no
  implicit last route inside the isolated session, so prefer explicit targets
  in `HEARTBEAT.md`). Ticks that must drain queued system events (exec
  completions, cron payloads, wake/hook events) stay in the main session where
  the events were enqueued, as do heartbeats pinned to an explicit `session`
  and `session.scope: "global"` deployments.
- `lightContext` (default `true`): the run uses the minimal system prompt
  (same shape as cron/subagent turns), injects `HEARTBEAT.md` as the only
  workspace file (no GENOME/PROTOCOLS/TOOLS/MEMORY), pins thinking to `low`,
  skips proactive recall, and, when `model` is unset, uses the cheap tier
  (`anthropic/claude-haiku-4-5` with an `ANTHROPIC_API_KEY`,
  `openai/gpt-4o-mini` with an `OPENAI_API_KEY`, otherwise the agent's default
  model). An explicit `model` always wins.
- `activeHours`: restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive), `end` (HH:MM exclusive; `24:00` allowed for end-of-day), and optional `timezone`.
  - Omitted or `"user"`: uses your `agents.defaults.userTimezone` if set, otherwise falls back to the host system timezone.
  - `"local"`: always uses the host system timezone.
  - Any IANA identifier (e.g. `America/New_York`): used directly; if invalid, falls back to the `"user"` behavior above.
  - Outside the active window, heartbeats are skipped until the next tick inside the window.

## Delivery behavior

- Interval heartbeats run in the isolated `agent:<id>:<mainKey>:heartbeat`
  session by default (`isolatedSession: true`); event-driven ticks, explicit
  `session` overrides and `global` scope run in the base session
  (`agent:<id>:<mainKey>` or `global`). Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` only affects the run context; delivery is controlled by `target` and `to`.
- To deliver to a specific channel/recipient, set `target` + `to`. With
  `target: "last"`, delivery uses the last external channel for that session.
- If the main queue is busy, the heartbeat is skipped and retried later.
- If `target` resolves to no external destination, the run still happens but no
  outbound message is sent.
- Heartbeat-only replies do **not** keep the session alive; the last `updatedAt`
  is restored so idle expiry behaves normally.

## Visibility controls

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is
delivered. You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → channel defaults → built-in defaults.

### What each flag does

- `showOk`: sends a `HEARTBEAT_OK` acknowledgment when the model returns an OK-only reply.
- `showAlerts`: sends the alert content when the model returns a non-OK reply.
- `useIndicator`: emits indicator events for UI status surfaces.

If **all three** are false, Bitterbot skips the heartbeat run entirely (no model call).

### Per-channel vs per-account examples

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Common patterns

| Goal                                     | Config                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Default behavior (silent OKs, alerts on) | _(no config needed)_                                                                     |
| Fully silent (no messages, no indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (no messages)             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs in one channel only                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Think of it as your “heartbeat checklist”: small, stable, and
safe to include every 30 minutes.

If `HEARTBEAT.md` exists but is effectively empty, Bitterbot skips the heartbeat
run to save API calls. "Effectively empty" means the file contains only blank
lines, markdown headers (`# Heading`), empty list items, HTML comments (single
or multi-line), fenced code blocks, horizontal rules, the template sentences, or
placeholder prose such as `_No active heartbeat tasks._`, `Nothing to do` or
`If nothing needs attention, reply HEARTBEAT_OK.` (the italic placeholder line
that shipped in an early workspace and defeated the old check). Any other line
counts as a task. If the file is missing, the heartbeat still runs and the model
decides what to do (and the hash gate then skips every following tick until
something changes).

Keep it tiny (short checklist or reminders) to avoid prompt bloat.

Example `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Can the agent update HEARTBEAT.md?

Yes — if you ask it to.

`HEARTBEAT.md` is just a normal file in the agent workspace, so you can tell the
agent (in a normal chat) something like:

- “Update `HEARTBEAT.md` to add a daily calendar check.”
- “Rewrite `HEARTBEAT.md` so it’s shorter and focused on inbox follow-ups.”

If you want this to happen proactively, you can also include an explicit line in
your heartbeat prompt like: “If the checklist becomes stale, update HEARTBEAT.md
with a better one.”

Safety note: don’t put secrets (API keys, phone numbers, private tokens) into
`HEARTBEAT.md` — it becomes part of the prompt context.

## Manual wake (on-demand)

You can enqueue a system event and trigger an immediate heartbeat with:

```bash
bitterbot system event --text "Check for urgent follow-ups" --mode now
```

If multiple agents have `heartbeat` configured, a manual wake runs each of those
agent heartbeats immediately.

Use `--mode next-heartbeat` to wait for the next scheduled tick.

## Reasoning delivery (optional)

By default, heartbeats deliver only the final “answer” payload.

If you want transparency, enable:

- `agents.defaults.heartbeat.includeReasoning: true`

When enabled, heartbeats will also deliver a separate message prefixed
`Reasoning:` (same shape as `/reasoning on`). This can be useful when the agent
is managing multiple sessions/codexes and you want to see why it decided to ping
you — but it can also leak more internal detail than you want. Prefer keeping it
off in group chats.

## Cost model

Why the old defaults cost real money: a heartbeat used to be a full agent turn
in the main session. On a typical node that is a ~54k-token prompt (system
prompt, 59 tool schemas, every workspace file) on the primary model. The prompt
cache TTL is 5 minutes and the interval is 30 minutes, so every tick was a cold
cache write at 1.25x input price (~$0.33) that produced 13 output tokens
(`HEARTBEAT_OK`). 48 ticks a day is ~$16 per idle day, with nothing delivered.
The audited node ran 1,021 ticks, all ack-only, because its `HEARTBEAT.md`
carried one italic placeholder line that the empty-file skip did not recognize.

What the defaults do now:

- `skipWhenUnchanged`: an idle node hashes to the same value every tick, so
  after the first completed tick there are zero model calls until
  `HEARTBEAT.md`, the prompt, or a queued event changes. Idle cost: $0.
- `isolatedSession` + `lightContext`: when a tick does run, it is a minimal
  prompt with one workspace file in a fresh session on Haiku (or gpt-4o-mini),
  a few thousand tokens at cheap-tier rates instead of ~54k at primary rates.
- Event-driven ticks (exec completions, cron, wake, hooks) are unchanged: they
  run in the main session with the events they need to surface.

If you turn the gates off, the old advice applies: shorter intervals burn more
tokens; keep `HEARTBEAT.md` small, keep `every` under your cache TTL, and set a
cheaper `model` or `target: "none"` if you only want internal state updates.

## Considerations log (`heartbeat why`)

In addition to `emitHeartbeatEvent` (which records what the heartbeat acted
on), each meaningful decision point also calls `recordConsideration` —
including options the heartbeat ultimately skipped, blocked, or deferred.
The log is persisted at `~/.bitterbot/heartbeat/considerations-YYYY-MM-DD.ndjson`
with 30-day retention.

Inspect from the CLI:

```bash
bitterbot heartbeat why                 # last 50, in-memory ring
bitterbot heartbeat why --session KEY   # filter by session
bitterbot heartbeat why --decision blocked
bitterbot heartbeat why --day 2026-04-25 --limit 100
```

A hash-gated skip shows as `skipped trigger heartbeat-tick` with reason
`unchanged-hash` and a payload carrying the hash prefix and the timestamp of the
last completed tick. An idle node should show one `acted` entry followed by a
run of `unchanged-hash` entries; if you see `acted` on every tick, something is
changing the inputs (an agent that rewrites `HEARTBEAT.md`, or a cron job
queuing events every interval).

Full reference: [bitterbot heartbeat](/cli/heartbeat).
