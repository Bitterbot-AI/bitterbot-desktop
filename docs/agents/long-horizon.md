---
summary: "Drive a multi-hour agent task through work-rest-dream cycles with full checkpoint coverage"
read_when:
  - Building a long-running agent task (SWE-bench Pro, multi-day research)
  - Needing resume/abort/budget controls on a normal agent loop
  - Pairing checkpoint replay with a live runtime
title: "Long-horizon runtime"
---

# Long-horizon runtime

`LongHorizonRuntime` drives an agent task through a biological cycle
of **work**, **rest**, and **dream** phases. Each phase boundary
writes a checkpoint to the [checkpoint store](../tools/checkpoints.md)
so a multi-hour run can be paused, resumed, or forked without losing
progress.

The runtime is deliberately decoupled from any specific agent runner.
You supply a `workStep` function that does one unit of work and an
optional `dreamStep` that runs the dream pass. The same driver powers
CLI runs, gateway-backed runs, and isolated sandboxed runs without
each owning its own loop logic.

## The cycle

```
   ┌──── work phase (default 25m) ────┐
   │                                   │
   │  workStep() ──┐                   │
   │      ↑        │                   │
   │      └────────┘  (until done      │
   │                   or workMs hits) │
   └────────────────┬──────────────────┘
                    ▼
            rest phase (2m)
                    │
                    ▼
            dream phase (one pass)
                    │
                    ▼
              [next cycle]
```

The cycle repeats until **any** stop condition fires:

- `workStep` returns `{ done: true }` (task complete)
- Wall-clock budget hit (default 8 hours)
- Iteration cap hit (default 200 cycles)
- Caller's `AbortSignal` fires

## Quick example

```typescript
import { LongHorizonRuntime } from "bitterbot/agents/long-horizon";
import { CheckpointStore } from "bitterbot/checkpoints";

const store = CheckpointStore.open("~/.bitterbot/checkpoints.sqlite");

const runtime = new LongHorizonRuntime({
  threadId: "swe-bench-task-1247",
  workMs: 30 * 60 * 1000, // 30-min work blocks
  restMs: 3 * 60 * 1000, // 3-min rest
  budgetMs: 6 * 60 * 60_000, // 6-hour cap
  maxIterations: 12,
  store,
  workStep: async () => {
    const result = await agent.step();
    return {
      done: result.complete,
      state: { messages: result.messages },
      label: `iter ${result.iteration}`,
    };
  },
  dreamStep: async () => {
    const stats = await memory.dream();
    return { state: stats, label: `${stats?.newInsights.length ?? 0} insights` };
  },
});

const stats = await runtime.run();
console.log(stats);
// { cycles: 9, workSteps: 142, dreamSteps: 9, reason: "done", ... }
```

## API

### `new LongHorizonRuntime(opts)`

| Option          | Type                                        | Default            | Purpose                                      |
| --------------- | ------------------------------------------- | ------------------ | -------------------------------------------- |
| `threadId`      | `string`                                    | required           | Stable id used as the checkpoint `thread_id` |
| `workStep`      | `() => Promise<WorkStepResult>`             | required           | One unit of agent work                       |
| `dreamStep`     | `() => Promise<{ label?, state? } \| void>` | omit               | One dream pass at end of cycle               |
| `workMs`        | `number`                                    | 25 min             | Work-phase duration before yielding to rest  |
| `restMs`        | `number`                                    | 2 min              | Rest-phase duration                          |
| `budgetMs`      | `number`                                    | 8 hours            | Hard wall-clock cap                          |
| `maxIterations` | `number`                                    | 200                | Hard cycle cap                               |
| `signal`        | `AbortSignal`                               | none               | External cancel                              |
| `store`         | `CheckpointStore`                           | none               | Where to write phase checkpoints             |
| `now`           | `() => number`                              | `Date.now`         | Test seam                                    |
| `sleep`         | `(ms) => Promise<void>`                     | `setTimeout`-based | Test seam                                    |

### `runtime.run()`

Returns `LongHorizonStats`:

```typescript
{
  cycles: number; // completed work-rest-dream cycles
  workSteps: number; // total workStep() calls
  dreamSteps: number; // total dreamStep() calls
  startedAt: number;
  endedAt: number;
  reason: "done" | "budget" | "iterations" | "aborted";
  lastStepId: string | null; // tip for resume
}
```

### `LongHorizonRuntime.resume(threadId, store)`

Returns the latest step id from the checkpoint store, or `null` if
the thread has no history. The caller continues the lineage by passing
that id as the parent of the next checkpoint write.

```typescript
const tip = LongHorizonRuntime.resume("swe-bench-task-1247", store);
if (tip) {
  // ...rebuild runtime state from store.ancestors(threadId, tip)
}
```

The runtime does **not** automatically rebuild runner state from
checkpoints — that's the caller's job, since "state" depends on the
specific agent runner. The runtime gives you the tip; you decide how
to replay.

## What gets checkpointed

Every phase boundary writes one checkpoint with `kind: "custom"` and
a `phase` metadata field:

| Phase   | When written                   | `state`                                  |
| ------- | ------------------------------ | ---------------------------------------- |
| `work`  | After each `workStep()`        | Whatever `workStep` returned in `state`  |
| `rest`  | At the start of the rest phase | `undefined`                              |
| `dream` | After `dreamStep()` runs       | Whatever `dreamStep` returned in `state` |

Each new checkpoint references the prior step as its parent, so
`store.ancestors(threadId, latest)` produces a clean replayable
lineage.

## OTel coverage

When [observability](../observability.md) is enabled, the runtime
emits four spans:

- `long_horizon.run` — the entire `runtime.run()` call, with
  `long_horizon.thread_id` attribute
- `long_horizon.work_step` — one `workStep()` invocation, with
  `phase=work` and `cycle` attributes
- `long_horizon.dream_step` — one `dreamStep()` invocation, with
  `phase=dream` and `cycle` attributes
- (memory subsystem spans nested under each step)

This gives you a full multi-hour trace where the biological cadence
shows up directly in the timeline.

## Failure model

`LongHorizonRuntime` does **not** swallow errors from `workStep` or
`dreamStep`. If either throws, the run aborts with the exception
propagating to the caller. The most-recent checkpoint is still in the
store, so resume from there is the recovery path.

If `store.save()` itself throws (disk full, schema mismatch, etc.),
the runtime logs a warning and continues — checkpoint loss is treated
as recoverable, not as a reason to halt the work loop.

## Design notes

- **Why fixed phase durations?** Biological circadian rhythm has
  consistent intervals; agent recovery from a long task benefits from
  the same. Adaptive scheduling (work expands when productive, dream
  triggers on memory pressure) is a candidate for a later iteration
  but adds operational complexity.
- **Why decouple `workStep`?** A LongHorizonRuntime that owned the
  agent runner would force every backend (CLI, gateway, sandbox) to
  fork. Instead, it's a generic loop driver — the shape that's worked
  for `setInterval` for sixty years.
- **Why not just a `setTimeout` loop?** The checkpointing, OTel spans,
  abort handling, budget caps, and reason reporting are all common
  needs that get reinvented (badly) every time someone writes "let me
  just hack a long-running task".
