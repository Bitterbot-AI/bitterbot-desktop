---
summary: "Durable, self-monitored, multi-hour Tasks with handoffs, wakeups, and Judge verification"
read_when:
  - You want the agent to work on a multi-hour or multi-day task that survives restarts
  - You need to monitor a background task's progress without blocking
  - You're integrating the curiosity / dream / hormonal subsystems with the task primitive
title: "Long-Horizon Tasks"
---

# Long-Horizon Tasks (PLAN-16)

Bitterbot agents can now own multi-hour and multi-day work units that
survive context-window saturation, gateway restarts, and rest cycles.
Every long-horizon task carries a durable plan, a structured handoff
record at every suspend point, and an independent Judge that verifies
done-criteria before the task can move to `completed`.

This is Bitterbot's answer to Claude Code's background-task harness —
but wired through the biological memory substrate so curiosity gaps
auto-generate tasks, dreams refine paused plans, and hormonal state
modulates concurrency.

## Mental model

```
user / curiosity / subagent
            │
            ▼
       ┌─────────┐         ┌──────────────────┐
       │  Task   │────────▶│ handoff records  │
       │  store  │         │ (one per suspend)│
       └────┬────┘         └──────────────────┘
            │
            ▼
    ┌──────────────┐       ┌──────────────────┐
    │ event journal│──────▶│   task_monitor   │
    │  (SQLite)    │       │ (streaming view) │
    └──────┬───────┘       └──────────────────┘
           │
           ▼
   ┌──────────────────┐    ┌──────────────────┐
   │ cron-scheduled   │───▶│ isolated agent   │
   │ wakeup           │    │ resumes cold     │
   └──────────────────┘    └──────────────────┘
                                   │
                                   ▼
                           ┌──────────────────┐
                           │ Judge (isolated) │
                           │ pass / fail /    │
                           │ needs_more       │
                           └──────────────────┘
```

A Task is the **durable coordination object** that lives above any
single agent run. It captures the goal, judge-criteria, plan, current
progress, and pointers to the latest checkpoint and handoff record.

## The agent tool surface

When the gateway is running with PLAN-16 enabled (the default), every
agent gets these tools added to its loadout:

| Tool                   | What it does                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `task_create`          | Register a new long-horizon task with goal, falsifiable `done_criteria`, optional plan steps |
| `task_update`          | Mutate status, plan, output ref, or do a single-step `step_update`                           |
| `task_get`             | Fetch a task with its most recent journal events                                             |
| `task_list`            | Filter by status / source / parent / since-timestamp                                         |
| `task_stop`            | Graceful termination with a recorded reason                                                  |
| `task_output`          | Return the final artifact ref for a completed task                                           |
| `task_monitor`         | Stream durable events from the journal (incremental polling via `since_seq`)                 |
| `task_write_handoff`   | Author a structured handoff before suspending                                                |
| `task_read_handoff`    | First call on resume — rebuild context cold from the handoff                                 |
| `task_schedule_wakeup` | Schedule a future agent invocation that resumes this task                                    |
| `task_judge`           | Run the independent Judge to verify `done_criteria`                                          |

## The handoff-and-wakeup protocol

Long-horizon tasks succeed by **rebuilding context cold from a
structured handoff document** rather than relying on in-context
summarization (the [Amp pattern][amp-handoff]; see also [ACON][acon]).

[amp-handoff]: https://tessl.io/blog/amp-retires-compaction-for-a-cleaner-handoff-in-the-coding-agent-context-race/
[acon]: https://arxiv.org/html/2510.00615v1

When you (the agent) are about to suspend a task — typically when your
context window approaches **70% saturation**, at a rest boundary, or
when blocked on an external dependency — do this:

1. **Write the handoff:**

   ```ts
   task_write_handoff({
     task_id: "task-abc-123",
     intent: "context at 72%, suspending for rest cycle",
     decisions: [
       "chose ACON for short tasks, handoff for long",
       "skipping E.4 P2P bidding pending wallet integration",
     ],
     pending: ["finalize Phase C tests", "write Mintlify docs for the task tools"],
     context: "see crystal:research-citations-v3 for sources",
     context_tokens: 145000,
   });
   ```

2. **Schedule the wakeup:**

   ```ts
   task_schedule_wakeup({
     task_id: "task-abc-123",
     delay_seconds: 1800, // 30 minutes
     reason: "rest cycle then resume",
   });
   ```

3. **Exit your current turn.** The cron engine fires the wakeup at the
   scheduled time, spawns a fresh isolated agent, and that agent
   receives a prompt instructing it to call `task_read_handoff` first.

The fresh agent's flow:

1. `task_read_handoff({ task_id })` — load intent, decisions, pending
2. `task_get({ task_id })` — load status, plan, original goal /
   done_criteria
3. Continue the work using whatever tools are appropriate
4. When done, set `status="judging"` and call `task_judge`

## The Judge

When you believe a task is complete:

```ts
task_update({ task_id: "...", status: "judging", output: "crystal:final-doc" });
task_judge({ task_id: "..." });
```

The Judge is an **independent pass**: it sees only the goal,
done_criteria, plan-step statuses, output reference, and latest
handoff — never the worker's chain of thought. Three verdicts:

- **`pass`** → task transitions to `completed`. Done.
- **`fail`** → a rejecting handoff is written with `missing` items as
  pending. Task transitions back to `running` (or to `failed` at the
  round cap, default 5).
- **`needs_more`** → same as fail but the judge wants more evidence
  rather than more work.

To configure the round cap: pass `max_rounds` to `task_judge`, or set
`BITTERBOT_TASKS_MAX_JUDGE_ROUNDS` at boot time.

The Judge requires an LLM provider to be registered at gateway boot.
Call `registerJudgeLlmCall(fn)` from `src/tasks/judge.ts` during
startup to wire it in. Until that's done, `task_judge` returns a
structured "judge LLM not registered" error.

## Monitoring

Every event emitted during a task's life lands in the event journal
(SQLite at `~/.bitterbot/event-journal.sqlite` by default). The
journal is queryable via `task_monitor`:

```ts
const first = task_monitor({ task_id: "task-abc-123" });
// returns { events: [...], nextSinceSeq: 42 }

// later, poll incrementally
const second = task_monitor({
  task_id: "task-abc-123",
  since_seq: 42,
});
```

You can also filter by stream:

```ts
task_monitor({
  task_id: "task-abc-123",
  streams: ["tool", "error"],
});
```

## Biology synergies (Phase E)

Three integrations turn the task primitive into a Bitterbot-native
capability rather than a generic agent harness. The adapters live in
`src/tasks/biology.ts`:

- **`maybeSpawnTaskFromCuriosity(gap)`** — when the GCCRF curiosity
  engine surfaces a frontier gap with sufficient novelty and
  alignment, it can spawn a Task with `source="curiosity"`. Bitterbot
  generates its own work from its own gaps.
- **`scanPendingTasksForDream({maxAgeHours})`** — returns
  `waiting_external` / `planning` tasks. The dream engine can call
  this in its pre-mode step and bias Replay / Simulation / Mutation
  toward refining paused plans.
- **`computeTaskConcurrency(hormonalState)`** — returns the max
  concurrent task count for the current hormonal state. High cortisol
  forces single-task focus; high dopamine permits exploratory breadth.

These adapters are pure functions; subsystem wiring (the actual
call-sites in `curiosity-engine.ts`, `dream-engine.ts`, and the
scheduler) is a small follow-up.

P2P bounty plumbing (`src/tasks/bounty.ts`) handles bid recording and
listing for biddable tasks. **No wallet, no payouts** — see the file
header for the policy boundary.

## Configuration

| Env var                       | Default                             | Effect                                   |
| ----------------------------- | ----------------------------------- | ---------------------------------------- |
| `BITTERBOT_EVENT_JOURNAL`     | `1` (on)                            | Set to `0` to disable the event journal  |
| `BITTERBOT_EVENT_JOURNAL_DB`  | `~/.bitterbot/event-journal.sqlite` | Journal DB path                          |
| `BITTERBOT_TASKS_DB`          | `~/.bitterbot/tasks.sqlite`         | Task store DB path                       |
| `BITTERBOT_TASKS_MAX_WAKEUPS` | `50`                                | Per-task wakeup cap (runaway-loop guard) |

## Verification: end-to-end test plan

1. **Phase A** — Spawn an agent, kill the gateway mid-run, restart,
   query `task_monitor` with the run id. Must return the events
   emitted before the kill.

2. **Phase B** — From a chat session, ask the agent to "create a task
   to refactor X and report when done." Verify: task row exists in
   `tasks.sqlite`, has a plan, `task_list` returns it.

3. **Phase C** — Force a context-saturation suspend by calling
   `task_write_handoff` + `task_schedule_wakeup` with a 5-second
   delay. Verify the cron job lands and the wakeup fires.

4. **Phase D** — Create a task with falsifiable done-criteria. Have
   the worker write a stub output that doesn't satisfy criteria. The
   Judge must `fail` it; verify the rejecting handoff lands with
   `pending` populated.

5. **Phase E.1** — Plant a high-novelty / high-alignment gap and
   trigger a curiosity pass; verify a `source="curiosity"` task
   appears in `task_list`.

## Where the code lives

| File                            | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `src/infra/event-journal.ts`    | Persistent agent-event journal (Phase A)                                          |
| `src/tasks/types.ts`            | Task / Plan / Handoff types                                                       |
| `src/tasks/store.ts`            | SQLite-backed Task store + handoff table (Phase B)                                |
| `src/tasks/judge.ts`            | Pure Judge prompt + parsing + orchestration (Phase D)                             |
| `src/tasks/biology.ts`          | Curiosity / dream / hormonal adapters (Phase E.1–E.3)                             |
| `src/tasks/bounty.ts`           | P2P bounty plumbing — no wallet (Phase E.4)                                       |
| `src/agents/tools/task-tool.ts` | All `task_*` agent tools                                                          |
| `src/cron/active.ts`            | Lean cron-engine registry (refactored out of `runtime.ts` for clean test imports) |

See [research/plans/PLAN-16-LONG-HORIZON-TASK-EXECUTION.md][plan] for
the design rationale.

[plan]: /research/plans/PLAN-16-LONG-HORIZON-TASK-EXECUTION
