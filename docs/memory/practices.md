---
summary: "Standing practices: tell the agent once how to do a kind of task"
read_when:
  - You keep adding the same follow-up to a recurring request
  - You want to see, re-scope or retire an instruction the agent stored
  - You want to know what "applied" means for a practice
title: "Standing practices"
---

# Standing practices

A **practice** is a standing instruction about how to do a kind of task: "For repo stats, give the numbers first and include npm downloads." It is a sentence, not a key/value fact. Facts ("the deploy endpoint is api2.acme.com") live in the [settled facts ledger](/memory/controls); practices live in their own table and are rendered in their own block of the prompt.

Each practice has:

- a **statement**, one short instruction (8 to 300 characters);
- a **scope**, where it applies;
- a **status**: `candidate`, `active`, `retired` or `suppressed`. Only `active` practices ever reach a prompt;
- the **tier** that wrote it (`owner` for your own words, `extraction` for something inferred);
- **evidence**, the line of the conversation you said it on (`session:<file>#L<n>`);
- counters and an event history.

## Scope

| Scope             | Applies to                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `global`          | Every turn of yours.                                                                         |
| `person:<name>`   | Every turn of yours (person scopes are not routed yet, as for facts).                        |
| `project:<name>`  | Turns whose active project matches. The project is the name of the agent's workspace folder. |
| `task:<slug>`     | Turns typed as that recurring kind of request (below).                                       |
| `job:<cronJobId>` | The scheduled job's own session (`cron:<jobId>`), and nowhere else.                          |

One validator checks all five forms. A scope that does not validate is a rejected write, so a practice is never stored where nothing will ever show it. Facts still accept `global`, `project:` and `person:` only.

## Recurring task types

A task type is a kind of request you make repeatedly, such as asking for yesterday's repo stats. Each of your turns in a direct chat is compared with the stored example texts of every task type by word overlap: the message is lowercased, the channel's `[Day YYYY-MM-DD HH:MM TZ]` prefix and common words are dropped, plurals and `-ing` endings are cut, and a turn joins a type when at least two words and 60% of the smaller word set are shared. There is no model call on this path.

- A turn that matches nothing starts a pending type. Pending types are never used for scoping. At most 150 are kept; the least recently seen are dropped.
- A type becomes **recurring** at three occurrences on three different days.
- When a type becomes recurring it is named once, by one cheap model call on the correction lane (usage feature `memory/correction`). With no model available the name is built from its most frequent words (for example `clone-yesterday-repo`).

Limits: the matching is lexical. The same request in different words does not join its type, and two different requests that share their main words do. Messages with fewer than 2 or more than 24 content words are not typed.

## How a practice is captured

Capture rides on the [correction pass](/memory/controls#teach-it-once-corrections-captured-as-you-chat): the same pre-filter, the same single model call per message, the same skip rules (direct chats with you only; never groups, guests, subagents, scheduled runs or heartbeats). No second call is made.

1. **Pre-filter.** In addition to the corrective shapes, these behavioural phrasings earn the call: "stop asking", "don't worry about X", "no need to include X", "give me X too" (also "as well", "every time", "each time"), and "you should check X". Each is guarded so that narration ("I had to stop working") and questions ("should I stop using npm?") do not. A phrasing outside the list is not captured.
2. **The model call** may return up to three practices next to the facts, each with a scope hint and a flag saying whether you stated it directly. A malformed entry, a statement that is too short or too long, or credential-shaped text is dropped.
3. **Tier.** A practice is stored `active` at your tier only when the model marked it as stated directly **and** more than half of the statement's content words appear in your own prose. Code, quoted lines, and forwarded or pasted text do not count. Anything else is stored as a `candidate` at the `extraction` tier. Candidates are never rendered and never announced.
4. **Scope.** The narrowest the turn supports: the scheduled job when the turn carries a job context, else the recurring task type of this message or of your message just before it (remembered in process for 30 minutes), else the active project when you named it, else `global`. Saying "everywhere" or "globally" forces `global`.
5. **The confirmation line.** The reply ends with a system-generated line, for example `Practice saved for repo stats: "Include the npm downloads."`. Outside a direct chat it carries a count only, never the statement. Replying "everywhere" (or "apply that everywhere") within 30 minutes in the same conversation widens that practice to `global`.

A statement nearly identical to an existing practice at the same scope (80% of content words in common) adds evidence to that row. It does not create a second one.

## What reaches the prompt

Before each of your turns the agent types the turn, selects the `active` practices whose scope matches, and renders them under `## Standing Practices`, most specific scope first (job, task, project, person, global), newest first within a scope. At most 8 practices and about 400 tokens are rendered; what does not fit is the least specific. A practice that is not global carries a short tag such as `[repo stats]` or `[project acme]`.

The block is not rendered for guests, group or channel chats, subagents, remote tasks or heartbeats. A scheduled job's own session gets that job's `job:` practices and nothing else.

**"Applied" means included in the prompt.** Each rendered practice gets an `applied` event and its `appliedCount` goes up by one per run. Nothing checks whether the answer followed the practice.

## What sticks

Retiring a practice is your decision and it holds: capture, or any other writer below your tier, cannot store a nearly identical practice again, at any scope. The same goes for a practice with status `suppressed`. Stating the instruction again yourself, or un-retiring it, brings it back.

## Looking at and changing practices

Gateway methods (reads need `operator.read`, changes need admin, like the other `memory.*` methods):

| Method                    | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `memory.practices`        | Lists practices of every status, or one `status`, plus the recurring task types.   |
| `memory.savePractice`     | Adds a practice at your tier (`statement`, optional `scope`, optional `evidence`). |
| `memory.editPractice`     | Rewords a practice (`id`, `statement`).                                            |
| `memory.setPracticeScope` | Widens or narrows a practice (`id`, `scope`). Logged as `widened` or `narrowed`.   |
| `memory.retirePractice`   | Retires a practice (`id`).                                                         |
| `memory.unretirePractice` | Brings back a retired or suppressed practice, or activates a candidate (`id`).     |

Every change writes an event on the practice (`stored`, `applied`, `edited`, `widened`, `narrowed`, `retired`, `confirmed`) and an entry in the memory audit log.

## Configuration

| Key                         | Default | Effect                                                                                                                                                                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.practices.enabled`  | `true`  | `false` stops practice capture, task typing and the prompt block. Stored practices are kept and can still be listed, edited and retired.                                                                            |
| `memory.correction.enabled` | `true`  | Practice capture uses this pass's model call, so `false` also stops practice capture. Stored practices are still rendered.                                                                                          |
| `session.memory`            | `"on"`  | `"off"` stops capture (the correction pass does not run) and stops task typing from recording your turns: a turn is still matched against existing recurring types, read-only. Stored practices are still rendered. |

## What this does not do yet

- It does not learn from follow-ups. If you ask for npm downloads after every stats answer without phrasing it as an instruction, nothing is stored.
- There is no page for practices in the Control UI and no CLI command; use the gateway methods above.
- A correction you make in your main chat about a scheduled job's report is not linked to that job. `job:` practices can be added with `memory.savePractice` or `memory.setPracticeScope`.
- Nothing detects that you had to repeat an instruction, and nothing checks whether an answer followed a practice.
- Practices are not part of the memory export or import.
- The "message just before" lookup and the once-per-run counters are kept in process memory and are lost when the gateway restarts.
