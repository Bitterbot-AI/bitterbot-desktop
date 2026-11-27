---
summary: "Standing practices: tell the agent once how to do a kind of task"
read_when:
  - You keep adding the same follow-up to a recurring request
  - You want to see, re-scope or retire an instruction the agent stored
  - You want to know what "applied" means for a practice
  - The agent asked "Include it every time? (yes / no)" and you want to know what that does
  - One task shows up as two task types and you want to merge them
title: "Standing practices"
---

# Standing practices

A **practice** is a standing instruction about how to do a kind of task: "For repo stats, give the numbers first and include npm downloads." It is a sentence, not a key/value fact. Facts ("the deploy endpoint is api2.acme.com") live in the [settled facts ledger](/memory/controls); practices live in their own table and are rendered in their own block of the prompt.

Each practice has:

- a **statement**, one short instruction (8 to 300 characters);
- a **scope**, where it applies;
- a **status**: `candidate`, `active`, `retired` or `suppressed` (you declined it). Only `active` practices ever reach a prompt;
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
- A message you send right after the answer to a recurring request (same conversation, within 15 minutes) does not start a type of its own unless it matches a recurring type by itself. It is first checked as a follow-up (below) and is counted as a new kind of request only when that check says it was a new topic.

Limits: the matching is lexical. The same request in different words does not join its type, and two different requests that share their main words do. One task can therefore end up as two or three types (in one real history, "how many clones yesterday", "how about our npm downloads" and "has GitHub updated the traffic stats" became three), and a practice saved under one of them is not shown for the others. A request with a single distinctive word ("can you check the latest stats?") matches nothing. Messages with fewer than 2 or more than 24 content words are not typed.

### Merging task types

- **At naming time.** The naming call is shown the label and two example requests of each recurring type that already exists, and may answer that the new type is the same task as one of them. The new type is then folded into the existing one: its example requests are added (a merged type keeps up to 16, and up to 4 from the folded-in type are always kept), the counts are combined, and practices scoped to it move along. This needs the model; with the fallback name nothing is merged.
- **By hand.** `bitterbot memory practices merge-types <from> <into>`, or the gateway method `memory.mergeTaskTypes` with `from` and `into`. `bitterbot memory practices list` prints the slugs. The merge is written to the memory audit log. If both types hold nearly the same practice, the two rows become one (evidence and history are kept).

## How a practice is captured

Capture rides on the [correction pass](/memory/controls#teach-it-once-corrections-captured-as-you-chat): the same pre-filter, the same single model call per message, the same skip rules (direct chats with you only; never groups, guests, subagents, scheduled runs or heartbeats). No second call is made.

1. **Pre-filter.** In addition to the corrective shapes, these behavioural phrasings earn the call: "stop asking", "don't worry about X", "no need to include X", "give me X too" (also "as well", "every time", "each time"), and "you should check X". Each is guarded so that narration ("I had to stop working") and questions ("should I stop using npm?") do not. A phrasing outside the list is not captured.
2. **The model call** may return up to three practices next to the facts, each with a scope hint and a flag saying whether you stated it directly. A malformed entry, a statement that is too short or too long, or credential-shaped text is dropped.
3. **Tier.** A practice is stored `active` at your tier only when the model marked it as stated directly **and** more than half of the statement's content words appear in your own prose. Code, quoted lines, and forwarded or pasted text do not count. Anything else is stored as a `candidate` at the `extraction` tier. Candidates are never rendered and never announced.
4. **Scope.** The narrowest the turn supports: the scheduled job when the turn carries a job context, else the recurring task type of this message or of your message just before it (remembered in process for 30 minutes), else the active project when you named it, else `global`. Saying "everywhere" or "globally" forces `global`.
5. **The confirmation line.** The reply ends with a system-generated line, for example `Practice saved for repo stats: "Include the npm downloads."`. Outside a direct chat it carries a count only, never the statement. Replying "everywhere" (or "apply that everywhere") within 30 minutes in the same conversation widens that practice to `global`.

A statement nearly identical to an existing practice at the same scope (80% of content words in common) adds evidence to that row. It does not create a second one.

## Learning from follow-ups

Most people do not phrase feedback as an instruction. They ask a regular question, read the answer, and ask for the part it left out: "how about our npm downloads". Follow-up learning turns that into a practice, with your yes in between.

1. **The follow-up check.** When you send a message in the same conversation within 15 minutes of the answer to a recurring request, one cheap model call (usage feature `memory/correction`) is shown your request, the answer and your new message, and classifies the message as a **gap** (it asks for something the answer should have contained) or **other** (a new topic, a reaction, thanks, or a deeper question about something the answer did contain). When the correction pre-filter fires on the same message, the check is one more section of that pass's call, so the turn still costs one call. Only the first message after an answer is checked.
2. **A candidate.** For a gap the model returns a short instruction such as "Include npm downloads". It is kept only when more than half of the words naming the missing item are in your own message (the word "Include" is generated, so it is not asked of you). It is stored as a `candidate` practice for that task type with your follow-up as evidence. A candidate is never added to a prompt and is not announced.
3. **Seen again.** The same gap on a later answer adds evidence to the same candidate. "Same" means the near-duplicate rule (80% of content words in common), or one item's words contained in the other's ("Include npm" and "Include npm downloads").
4. **The offer.** Once a candidate has been seen in two different conversations or on two different days, or once when your follow-up was itself an explicit instruction ("give me X too", "always include X", "from now on ..."), one generated line is added to a reply in a direct chat:

   `You have asked for npm downloads after repo stats twice. Include it every time? (yes / no)`

   The line is generated by the gateway, never written by the model. It is added to the reply to the follow-up, or to the next answer for that task type. A candidate is offered at most twice in total and never twice in one conversation, and a reply carries at most one offer.

5. **Your answer.** If your next message in that conversation, within 30 minutes, is a bare yes ("yes", "yep", "sure", "please do", "go ahead") the candidate becomes an `active` practice at your tier, and the reply ends with `Practice saved for repo stats: "Include npm downloads"`. A bare no ("no", "nope", "don't", "no thanks") sets it to `suppressed` for good and the reply ends with `Understood, I will not ask again.` No model call is involved. Anything else, including "ok", "yes but only weekly" or a new question, does nothing: the offer lapses and the candidate stays a candidate.

If you state the instruction explicitly and the correction pass saves it as an active practice on the spot (see above), there is no candidate and no offer.

### How to decline, and how to undo

- Answer the offer with "no". The candidate is suppressed and the same gap is not stored or offered again.
- Ignore the offer. It is made once more in a later conversation and then never again.
- Changed your mind: `memory.unretirePractice` with the practice id activates a suppressed or candidate practice; `memory.retirePractice` retires an active one. `bitterbot memory practices list` prints the ids.
- Turn offers off with `memory.practices.offers.enabled: false`, or the whole mechanism with `memory.practices.followUps.enabled: false`.

### What the agent is told

The offer line and the confirmation line are not part of the model's conversation. So that a bare "yes" is not read as a new request, the turn that answers an offer gets a short "Practice offer answered" section next to the practices block, saying what was asked and what you answered.

### Backfill from existing conversations

```bash
bitterbot memory practices backfill              # dry run
bitterbot memory practices backfill --apply      # store what it finds as candidates
bitterbot memory practices backfill --max-calls 20
```

The command reads the agent's existing conversation transcripts (current and reset ones; deleted ones are skipped), types your messages the same way, finds the messages that followed a recurring-task answer within 15 minutes, and runs the same follow-up check on each. Before the first model call it prints how many follow-ups it found and the most calls it will make (`--max-calls`, default 40; naming new task types counts toward it). Then it prints each candidate with the messages it came from.

Without `--apply` nothing is written. With `--apply` the candidates are stored with origin `backfill`, together with the task types they belong to. They are candidates, never active: you confirm them through the normal offer the next time you make that request, or with `memory.unretirePractice`. Running it twice does not add evidence twice.

## Counters

Every practice keeps an event history, and the counts are reported by `memory.practices` (per practice under `counts`, overall under `counters`), by `bitterbot memory practices list`, and by `bitterbot doctor`:

| Counter     | Counts                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`   | Runs whose prompt included the practice.                                                                                               |
| `repeats`   | Times you had to say it again: an explicit instruction or a follow-up gap that nearly matches a practice already active for that turn. |
| `offers`    | Offer lines sent.                                                                                                                      |
| `confirmed` | Offers you answered with yes.                                                                                                          |
| `declined`  | Offers you answered with no.                                                                                                           |

A repeat is a counter and nothing more. Nothing diagnoses why the practice was not followed and nothing repairs it. `bitterbot doctor` shows a warning when the repeat count is above zero.

## What reaches the prompt

Before each of your turns the agent types the turn, selects the `active` practices whose scope matches, and renders them under `## Standing Practices`, most specific scope first (job, task, project, person, global), newest first within a scope. At most 8 practices and about 400 tokens are rendered; what does not fit is the least specific. A practice that is not global carries a short tag such as `[repo stats]` or `[project acme]`.

The block is not rendered for guests, group or channel chats, subagents, remote tasks or heartbeats. A scheduled job's own session gets that job's `job:` practices and nothing else.

**"Applied" means included in the prompt.** Each rendered practice gets an `applied` event and its `appliedCount` goes up by one per run. Nothing checks whether the answer followed the practice.

## What sticks

Retiring a practice is your decision and it holds: capture, or any other writer below your tier, cannot store a nearly identical practice again, at any scope. The same goes for a practice with status `suppressed`. Stating the instruction again yourself, or un-retiring it, brings it back.

## Looking at and changing practices

Gateway methods (reads need `operator.read`, changes need admin, like the other `memory.*` methods):

| Method                    | What it does                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `memory.practices`        | Lists practices of every status, or one `status`, with counters, plus the recurring task types. |
| `memory.savePractice`     | Adds a practice at your tier (`statement`, optional `scope`, optional `evidence`).              |
| `memory.editPractice`     | Rewords a practice (`id`, `statement`).                                                         |
| `memory.setPracticeScope` | Widens or narrows a practice (`id`, `scope`). Logged as `widened` or `narrowed`.                |
| `memory.retirePractice`   | Retires a practice (`id`).                                                                      |
| `memory.unretirePractice` | Brings back a retired or suppressed practice, or activates a candidate (`id`).                  |
| `memory.mergeTaskTypes`   | Folds task type `from` into `into`; practices scoped to `from` move along.                      |

Every change writes an event on the practice (`stored`, `applied`, `repeat`, `offered`, `confirmed`, `declined`, `edited`, `widened`, `narrowed`, `retired`) and, for your own actions, an entry in the memory audit log.

From the terminal:

```bash
bitterbot memory practices list [--status candidate] [--json]
bitterbot memory practices backfill [--apply] [--max-calls 40]
bitterbot memory practices merge-types <from> <into>
```

## Configuration

| Key                                  | Default | Effect                                                                                                                                                                                                              |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.practices.enabled`           | `true`  | `false` stops practice capture, task typing and the prompt block. Stored practices are kept and can still be listed, edited and retired.                                                                            |
| `memory.practices.followUps.enabled` | `true`  | `false` stops the follow-up check: no model call after a recurring-task answer and no candidates. Existing candidates are kept.                                                                                     |
| `memory.practices.offers.enabled`    | `true`  | `false` stops the offer line, and a bare yes or no is no longer read as an answer. Candidates are still stored and can be activated with `memory.unretirePractice`.                                                 |
| `memory.correction.enabled`          | `true`  | Practice capture uses this pass's model call, so `false` also stops practice capture, the follow-up check and the offer line. Stored practices are still rendered.                                                  |
| `session.memory`                     | `"on"`  | `"off"` stops capture (the correction pass does not run) and stops task typing from recording your turns: a turn is still matched against existing recurring types, read-only. Stored practices are still rendered. |

## What this does not do yet

- Follow-up learning looks at one message: the first one after the answer to a recurring request, in the same conversation, within 15 minutes. A second follow-up to the same answer, a follow-up the next morning, or one in a new conversation is not checked.
- It costs one model call per recurring-task answer that you reply to within 15 minutes, whether or not the reply turns out to be a gap. With no model available for the correction pass nothing is checked.
- The model decides gap or other. A gap it misses is not stored, and a gap it names in words you did not use is dropped.
- An answer delivered with no final text payload (for example fully block-streamed) is not recorded, so the message after it is not checked.
- A follow-up is attached to the task type of the answer before it. If word-overlap typing split your task into several types, the evidence for one gap is split too, until the types are merged.
- The offer is made in direct chats only.
- There is no page for practices in the Control UI; use the CLI commands and gateway methods above.
- A correction you make in your main chat about a scheduled job's report is not linked to that job. `job:` practices can be added with `memory.savePractice` or `memory.setPracticeScope`.
- A repeat is counted but not acted on, and nothing checks whether an answer followed a practice.
- Practices are not part of the memory export or import.
- The link between an answer and your next message, and between an offer and your answer, is stored in the memory database and survives a gateway restart. The once-per-run de-duplication of `applied` and of task typing is in process memory and is lost on restart.
