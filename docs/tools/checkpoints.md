---
summary: "Session checkpoint graph — fork, replay, and time-travel agent runs"
read_when:
  - Recovering from an interrupted long-running task
  - Branching a run to explore an alternative path
  - Debugging by replaying from a known-good intermediate state
title: "Checkpoints"
---

# Checkpoints

The checkpoint graph captures every meaningful event in an agent run
(tool calls, tool results, lifecycle boundaries) as a parent-chained
DAG. From any captured point you can fork a new thread, replay state,
or simply inspect what happened — without touching the original
timeline.

This is the LangGraph-parity feature for Bitterbot: combined with the
[long-horizon runtime](../agents/long-horizon.md), a 6-hour run can be
paused, branched, and resumed from any intermediate state.

## Enabling

Checkpointing is **off by default** because writes are not free
(SQLite inserts on every meaningful event). Turn it on per process:

```bash
BITTERBOT_CHECKPOINTS=1 pnpm start gateway
```

The default DB lives at `~/.bitterbot/checkpoints.sqlite`. Override
with:

```bash
BITTERBOT_CHECKPOINT_DB=/path/to/checkpoints.sqlite \
  BITTERBOT_CHECKPOINTS=1 pnpm start gateway
```

When disabled, no DB file is created and the agent-event bus is not
subscribed to — zero overhead.

## What gets captured

Each event flowing through the agent-event bus produces one
checkpoint, keyed on `(thread_id, step_id)`. The thread id is the
agent's `runId`; the step id is the per-run monotonic `seq`.

Persisted events:

- **Tool start** → checkpoint kind `tool_call`
- **Tool result** → checkpoint kind `tool_result`
- **Lifecycle start / end** → checkpoint kind `custom` (run boundary)

Skipped events (too noisy to be useful):

- Assistant text deltas (per-token streams)
- Tool partial-result frames (`update` phase)

Each checkpoint stores:

- The full event payload (gzip-compressed JSON)
- A SHA-256 hash for dedup
- A label (`Read start`, `Bash result`, etc.) for the timeline UI

## CLI reference

The `bitterbot checkpoints` command opens the local DB directly — no
gateway connection needed, so it works offline.

### List threads

```bash
bitterbot checkpoints threads
```

```
agent-run-7f3a    142 steps    last=2026-04-29T18:14:22Z
agent-run-1b2c     53 steps    last=2026-04-29T17:02:11Z
agent-run-0e9d      7 steps    last=2026-04-29T15:48:03Z
```

### Inspect a thread

```bash
bitterbot checkpoints list agent-run-7f3a
```

```
2026-04-29T18:11:01Z   custom         1     parent=-          "run start"
2026-04-29T18:11:14Z   tool_call      2     parent=1          "Read start"
2026-04-29T18:11:14Z   tool_result    3     parent=2          "Read result"
2026-04-29T18:11:18Z   tool_call      4     parent=3          "Bash start"
2026-04-29T18:13:44Z   tool_result    5     parent=4          "Bash result"
...
```

### Show a single checkpoint's full state

```bash
bitterbot checkpoints show agent-run-7f3a 5
```

Returns the JSON event payload (decompressed).

### Fork from a step

```bash
bitterbot checkpoints fork agent-run-7f3a 5
```

```json
{
  "newThreadId": "agent-run-7f3a.fork-l9a8b3",
  "forkedFrom": { "threadId": "agent-run-7f3a", "stepId": "5" }
}
```

The forked thread copies the lineage from root → step 5 plus a
`fork_root` marker that points back to the source. The original
thread is untouched. New checkpoints written under the forked thread
id continue from the forked tip.

You can name the new thread explicitly:

```bash
bitterbot checkpoints fork agent-run-7f3a 5 --new-thread alt-attempt-1
```

### Delete a thread

```bash
bitterbot checkpoints delete agent-run-7f3a
```

Removes every checkpoint in the thread. Forks made from it are
unaffected — they have their own copy of the lineage.

### JSON output

Every command accepts `--json` for piping into other tools:

```bash
bitterbot checkpoints threads --json | jq '.[] | select(.steps > 100)'
```

## Programmatic API

For code that needs to write checkpoints directly (custom runtimes,
test fixtures, replay tools):

```typescript
import { CheckpointStore } from "bitterbot/checkpoints";

const store = CheckpointStore.open("~/.bitterbot/checkpoints.sqlite");

const cp = store.save({
  threadId: "task-A",
  stepId: "step-1",
  parentStepId: null,
  kind: "user_message",
  state: { messages: [{ role: "user", content: "hi" }] },
  label: "first message",
});

const lineage = store.ancestors("task-A", "step-1"); // root → step
const newThread = store.fork("task-A", "step-1");
```

The store uses Node's built-in `node:sqlite` (no native build step) and
WAL mode so reads and writes don't block each other.

## Long-horizon runs

When [LongHorizonRuntime](../agents/long-horizon.md) drives a task,
each phase boundary writes a checkpoint with a `phase` metadata field
(`work`, `rest`, or `dream`). After a crash or shutdown,
`LongHorizonRuntime.resume(threadId, store)` returns the latest step
id so the runtime can continue the lineage.

## Storage shape

A single SQLite table:

```sql
CREATE TABLE checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  parent_step_id  TEXT,
  ts              INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  label           TEXT,
  state_hash      TEXT NOT NULL,
  state_blob      BLOB NOT NULL,
  metadata_json   TEXT,
  UNIQUE(thread_id, step_id)
);
```

Indexes on `(thread_id, ts)`, `parent_step_id`, and `state_hash` keep
common queries fast. State blobs are gzip-compressed JSON; a typical
tool-result checkpoint is 200–800 bytes on disk after compression.

## Capacity planning

A busy agent can produce ~50 tool checkpoints per turn. Assuming
500 bytes per checkpoint compressed, a 6-hour run with 60 turns/hour
produces ~9 MB of checkpoint data. The default DB file grows linearly;
prune with `bitterbot checkpoints delete <threadId>` once a thread is
no longer needed.

There is no automatic retention policy. Wire one in via cron:

```bash
bitterbot cron add \
  --every 24h \
  --message "find threads older than 30 days and delete"
```
