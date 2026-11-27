---
summary: "Standing practices: tell the agent once how to do a kind of task"
read_when:
  - You keep adding the same follow-up to a recurring request
  - You want to see, re-scope or retire an instruction the agent stored
  - You want to know what "applied" means for a practice
  - The agent asked "Include it every time? (yes / no)" and you want to know what that does
  - One task shows up as two task types and you want to merge them
  - A reply ended with "Applied: ..." and you want to know what that means or how to turn it off
  - You want to see or change practices on the Memory page
  - You want a scheduled job to change its report after you comment on it
  - A scheduled report ended with "Changed since last time: ..." or your reply got "Rolled back: ..."
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
- Your next message after the answer to a recurring request (same conversation, within 6 hours) does not start a type of its own unless it matches a recurring type by itself. It is first checked as a follow-up (below) and is counted as a new kind of request only when that check says it was a new topic.
- A message that matches a recurring type and comes right after a request that matched none is typed at once (its practices apply to that turn) but is counted as an occurrence only when the follow-up check says it was not the missing part of the request before it.

Limits: the matching is lexical. The same request in different words does not join its type, and two different requests that share their main words do. One task can therefore end up as two or three types (in one real history, "how many clones yesterday", "how about our npm downloads" and "has GitHub updated the traffic stats" became three), and a practice saved under one of them is not shown for the others. A request with a single distinctive word ("can you check the latest stats?") matches nothing. Messages with fewer than 2 or more than 24 content words are not typed.

### Merging task types

- **At naming time.** The naming call is shown the label and up to four example requests of each recurring type that already exists, and is told which of them shares the most words with the new requests (a hint; the code merges nothing by itself). It is asked to answer that the new type is the same task as an existing one when both would be answered by the same kind of report or lookup, or are often asked in the same breath, even if they name a different metric, and to name the general task ("repo stats") instead of one metric of it. The new type is then folded into the existing one: its example requests are added (a merged type keeps up to 16, and up to 4 from the folded-in type are always kept), the counts are combined, and practices scoped to it move along. This needs the model; with the fallback name nothing is merged. The model decides, so the same history can merge on one run and stay split on another; merge by hand when it does not.
- **By hand.** `bitterbot memory practices merge-types <from> <into>`, or the gateway method `memory.mergeTaskTypes` with `from` and `into`. `bitterbot memory practices list` prints the slugs. The merge is written to the memory audit log. If both types hold nearly the same practice, the two rows become one (evidence and history are kept).

## How a practice is captured

Capture rides on the [correction pass](/memory/controls#teach-it-once-corrections-captured-as-you-chat): the same pre-filter, the same single model call per message, the same skip rules (direct chats with you only; never groups, guests, subagents, scheduled runs or heartbeats). No second call is made.

1. **Pre-filter.** In addition to the corrective shapes, these behavioural phrasings earn the call: "stop asking", "don't worry about X", "no need to include X", "give me X too" (also "as well", "every time", "each time"), and "you should check X". Each is guarded so that narration ("I had to stop working") and questions ("should I stop using npm?") do not. A phrasing outside the list is not captured.
2. **The model call** may return up to three practices next to the facts, each with a scope hint and a flag saying whether you stated it directly. A malformed entry, a statement that is too short or too long, or credential-shaped text is dropped.
3. **Tier.** A practice is stored `active` at your tier only when the model marked it as stated directly **and** more than half of the statement's content words appear in your own prose. Code, quoted lines, and forwarded or pasted text do not count. Anything else is stored as a `candidate` at the `extraction` tier. Candidates are never rendered and never announced.
4. **Scope.** The narrowest the turn supports: the scheduled job when your message is the next one after that job's report and the instruction is about the report (see [Scheduled jobs](#scheduled-jobs)), else the recurring task type of this message or of your message just before it (remembered in process for 30 minutes), else the active project when you named it, else `global`. Saying "everywhere" or "globally" forces `global`.
5. **The confirmation line.** The reply ends with a system-generated line, for example `Practice saved for repo stats: "Include the npm downloads."`. Outside a direct chat it carries a count only, never the statement. Replying "everywhere" (or "apply that everywhere") within 30 minutes in the same conversation widens that practice to `global`.

A statement nearly identical to an existing practice at the same scope (80% of content words in common) adds evidence to that row. It does not create a second one.

## Learning from follow-ups

Most people do not phrase feedback as an instruction. They ask a regular question, read the answer, and ask for the part it left out: "how about our npm downloads". Follow-up learning turns that into a practice, with your yes in between.

1. **The follow-up check.** A message is checked when it is your next message in the same conversation after an answer, within 6 hours, with no other message of yours in between, and either
   - the answered request was a recurring task, or
   - the answered request matched no task type ("can you check the latest stats?") and the new message itself matches a recurring type by its words ("give me day by day clones and the npm downloads too"). A gap is then stored under the new message's task type. A message that opens a conversation is never checked.

   One cheap model call (usage feature `memory/correction`) is shown your request, the answer and your new message, and classifies the message as a **gap** (it asks for another metric, item, breakdown or time range of the same report, one the answer did not give, even when the assistant had offered it) or **other** (a different task, a reaction, thanks, a deeper question about something the answer did contain, or the whole request made again with other parameters). When the correction pre-filter fires on the same message, the check is one more section of that pass's call, so the turn still costs one call. Only the first message after an answer is checked. The model's answer is read from the first JSON object in its response; a gap that the model takes back in the text after it ("wait, let me reconsider") is discarded.

2. **A candidate.** For a gap the model returns a short instruction such as "Include npm downloads". It is kept only when more than half of the words naming the missing item are in your own message (the word "Include" is generated, so it is not asked of you; a word of five letters or more that is one typo away from yours, "vistors" for "visitors", counts as yours). An instruction that names one instance is dropped: a number or ordinal, a month or weekday name, or "yesterday", "today" or "tomorrow" ("Include clone stats for the 24th to 27th"). It is stored as a `candidate` practice for that task type with your follow-up as evidence. A candidate is never added to a prompt and is not announced.
3. **Seen again.** The same gap on a later answer adds evidence to the same candidate. "Same" means the near-duplicate rule (80% of content words in common), or one item's words contained in the other's ("Include npm" and "Include npm downloads").
4. **The offer.** Once a candidate has been seen in two different conversations or on two different days, or once when your follow-up was itself an explicit instruction ("give me X too", "always include X", "from now on ..."), one generated line is added to a reply in a direct chat:

   `You have asked for npm downloads after repo stats twice. Include it every time? (yes / no)`

   The line is generated by the gateway, never written by the model. It is added to the reply to the follow-up, or to the next answer for that task type. A candidate is offered at most twice in total and never twice in one conversation, and a reply carries at most one offer.

   Two rules keep a bare "yes" from meaning something you did not intend:

   - **No offer after a question of the agent's own.** When the last line of the reply ends with a question mark ("Want me to pull npm downloads too?"), your "yes" answers that question, so the reply gets no offer. The candidate stays ready for a later reply and this does not count as one of its two offers.
   - **An offer counts only once it was shown.** The `offered` event, and the state that makes your next bare yes or no an answer, are written when the line was handed to the surface that shows it (see [Where the generated lines appear](#where-the-generated-lines-appear)). If the line could not be shown, nothing is recorded, your next "yes" is an ordinary message, and the offer is made again later.

5. **Your answer.** If your next message in that conversation, within 30 minutes, is a bare yes ("yes", "yep", "sure", "please do", "go ahead") the candidate becomes an `active` practice at your tier, and the reply ends with `Practice saved for repo stats: "Include npm downloads"`. A bare no ("no", "nope", "don't", "no thanks") sets it to `suppressed` for good and the reply ends with `Understood, I will not ask again.` No model call is involved. Anything else, including "ok", "yes but only weekly" or a new question, does nothing: the offer lapses and the candidate stays a candidate.

If you state the instruction explicitly and the correction pass saves it as an active practice on the spot (see above), there is no candidate and no offer.

### How to decline, and how to undo

- Answer the offer with "no". The candidate is suppressed and the same gap is not stored or offered again.
- Ignore the offer. It is made once more in a later conversation and then never again.
- Changed your mind: **Bring back** on the Memory page, or `memory.unretirePractice` with the practice id, activates a suppressed or candidate practice; **Retire** or `memory.retirePractice` retires an active one. `bitterbot memory practices list` prints the ids.
- Turn offers off with `memory.practices.offers.enabled: false`, or the whole mechanism with `memory.practices.followUps.enabled: false`.

### What the agent is told

The offer line and the confirmation line are written by the gateway, not by the model. So that a bare "yes" is not read as a new request, the turn that answers an offer gets a short "Practice offer answered" section next to the practices block. It names the statement that was offered and the task it was offered for, says what your answer did (saved, or dropped as a proposal that was never in effect), states that no other practice changed, and asks for a one-sentence acknowledgement that does not restate or change any other practice and does not claim the agent changed anything itself.

### Where the generated lines appear

"The generated lines" are the offer, `Practice saved ...`, `Understood, I will not ask again.`, the [`Applied: ...` line](#the-applied-line) and the `Memory updated: ...` line of [correction capture](/memory/controls).

- **Desktop app and browser Control UI.** The line is a short message of its own, right after the answer of that turn. It shows without a reload and is stored in the conversation transcript, so it is still there after a reload and in `chat.history`. The stored message is marked as a generated note (`bitterbotGeneratedNote: true`, model `gateway-injected`).
- **Channels (Telegram, WhatsApp and the others).** The line is the last line of the reply message, as before. It is not stored in the transcript.

On the desktop app the note is in the transcript, so the model can see it on later turns. In the model's view (not in the transcript and not in the chat) it carries a marker saying that the system wrote it and that it must not be repeated, re-asked or imitated.

The `bitterbot agent` command and the gateway `agent` method do not run correction capture or follow-up learning: a turn sent that way gets none of these lines, and no offer is made or recorded on it.

### Backfill from existing conversations

```bash
bitterbot memory practices backfill              # dry run
bitterbot memory practices backfill --apply      # store what it finds as candidates
bitterbot memory practices backfill --max-calls 20
```

The command reads the agent's existing conversation transcripts (current and reset ones; deleted ones are skipped), types your messages the same way, finds the messages the follow-up check would have looked at (the same two cases, the same 6 hours; a reply to a heartbeat or a scheduled job in between is not taken for the answer), and runs the same check on each. New task types are named largest first, and a later one can only be folded into a type that already has its name. Before the first model call it prints how many follow-ups it found and the most calls it will make (`--max-calls`, default 40; naming new task types counts toward it). Then it prints each candidate with the messages it came from, and how many follow-ups were not a gap, unusable, or about one date or number only. With `--json` the result also lists every follow-up it examined and what became of it (`examined`).

Without `--apply` nothing is written. With `--apply` the candidates are stored with origin `backfill`, together with the task types they belong to. They are candidates, never active: you confirm them through the normal offer the next time you make that request, or with `memory.unretirePractice`. Running it twice does not add evidence twice.

## Counters

Every practice keeps an event history, and the counts are reported by `memory.practices` (per practice under `counts`, overall under `counters`), by `bitterbot memory practices list`, and by `bitterbot doctor`:

| Counter       | Counts                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`     | Runs whose prompt included the practice.                                                                                                  |
| `repeats`     | Times you had to say it again: an explicit instruction or a follow-up gap that nearly matches a practice already active for that turn.    |
| `notFollowed` | Runs whose prompt included the practice and whose answer did not show it (see ["Applied" and "not followed"](#applied-and-not-followed)). |
| `offers`      | Offer lines sent.                                                                                                                         |
| `confirmed`   | Offers you answered with yes.                                                                                                             |
| `declined`    | Offers you answered with no.                                                                                                              |

A repeat is a counter and nothing more. Nothing else diagnoses why a practice was not followed and nothing repairs it. `bitterbot doctor` shows a warning when the repeat count is above zero.

## What reaches the prompt

Before each of your turns the agent types the turn, selects the `active` practices whose scope matches, and renders them under `## Standing Practices`, most specific scope first (job, task, project, person, global), newest first within a scope. At most 8 practices and about 400 tokens are rendered; what does not fit is the least specific. A practice that is not global carries a short tag such as `[repo stats]` or `[project acme]`.

The block is not rendered for guests, group or channel chats, subagents, remote tasks or heartbeats. A scheduled job's own session gets that job's `job:` practices and nothing else.

### "Applied" and "not followed"

**The `applied` counter means included in the prompt.** Each rendered practice gets an `applied` event and its `appliedCount` goes up by one per run.

Whether the answer shows the practice is checked by a word match, with no model call, in two places: when the ["Applied" line](#the-applied-line) is decided for a reply in a direct chat, and when a scheduled job's report is about to be announced. The practice's content words are its statement without the leading instruction verb ("Include npm downloads" gives "npm downloads"), lowercased, without common words. The answer **shows** the practice when more than half of those words are in the answer text; a word of five letters or more that is one typo away counts.

- When more than half are there, the reply can carry the "Applied" line.
- When **none** of them is there, and the practice names something to put in the answer (it starts with include, add, show, give, report, mention, provide or list), a `not_followed` event is written and counted under `notFollowed`. No line is shown.
- In between (some of the words, not most), nothing is counted and no line is shown. Example from a real run: the practice "Include unique counts every time you report repo traffic" and the report "Clones: 379 (45 unique)". The report did what was asked, and only one of the practice's seven content words is in it.
- A practice about manner ("Keep answers under ten lines") or one that says what to leave out ("Do not include the score") is never counted as not followed, because a word match cannot tell. Such a practice gets no "Applied" line unless its words happen to be in the answer.

This is a word match and not a judgement. An answer that says "no npm downloads data today" counts as showing the practice, and an answer that gives the numbers under another name ("package installs") counts as not followed.

### When a turn matches no task type

Task typing compares words, so a short or vague request ("can you check the latest stats?") can match nothing even though it is one of your recurring tasks. A practice that is not in the prompt cannot be followed, so on a turn that matched no task type the block also carries up to four of your task practices, taken from your most frequent recurring task types and worded as conditions:

```text
- When the request is about repo stats: Include npm downloads.
```

The answering model decides whether the request is that kind of task. These conditional lines share the block's size budget, are never shown in a cron job's session, and are not counted as applied, because nothing established that the practice fits the turn. The model can misjudge in either direction: it may skip a practice that did apply, or apply one to a loosely related request.

## The "Applied" line

When the prompt of your turn carried a practice because its scope matched the turn, the reply can end with one generated line:

```text
Applied: "Include npm downloads" for repo stats, from 12 Nov.
```

The gateway writes this line from its own records. The model does not write it. On the desktop app and the browser Control UI it is a short message of its own after the answer; on a channel it is the last line of the reply (see [Where the generated lines appear](#where-the-generated-lines-appear)).

- **What it says.** The practice was included in the prompt of this run and more than half of its content words are in the answer, as defined under ["Applied" and "not followed"](#applied-and-not-followed). It is a word match: it does not prove the answer did what the practice asks.
- **When it is not shown.** A practice that was in the prompt and whose words are not, for the most part, in the answer gets no line. That does not use up one of its showings. If it names something to put in the answer and none of its words is there, a `not_followed` event is recorded.
- **Which practices.** Only a practice scoped to a task type or a project, rendered because that scope matched. Never a practice that applies everywhere, never a person-scoped one (person scopes show on every turn, so the credit would be wrong), and never the conditional "When the request is about ..." lines, because nothing established that those fit the turn.
- **How often.** The first two times a practice is applied this way, then it stays silent. After you reword a practice or change where it applies, it is named once more. The count is stored as `attributed` events on the practice, so it survives a gateway restart.
- **One line per reply.** When several practices qualify (each of them shown by the answer), the most specific is named and the others are counted ("and 2 more"). Only the named one uses up one of its showings.
- **Other lines win.** A reply that already ends with a "Memory updated", "Practice saved" or offer line, or with the answer to an offer, gets no "Applied" line, and the showing is not used up.
- **Where.** Direct chats with you only. Never in a group or channel, for a guest, a subagent or a heartbeat, and not in a scheduled job's announcement (a job's report has its own line, see [Scheduled jobs](#scheduled-jobs)). A turn that produced no final text (for example a fully block-streamed answer) gets none either.
- **The date** is the day the practice was saved, or the day you said yes to it, in your timezone (`agents.defaults.userTimezone`, else the gateway host's). The year is added when it is not the current one.
- **Off switch.** `memory.practices.attribution.enabled: false`.

The line is built from the `applied` events of the run, which are matched by the conversation's transcript file and the time the run started. A run with no transcript file gets no line.

## Scheduled jobs

An isolated [scheduled job](/automation/cron-jobs) runs the same instruction every time. When you comment on its report, the comment can become a practice for that job, so the next run does it your way. The job's own instruction (`payload.message`) is never rewritten: what you taught the job is kept as `job:<cronJobId>` practices, which are given to the job's own session in its prompt and to nothing else.

### Which message counts

When an isolated job's report is announced to you (sent to a channel, or kept in the main session), the gateway records which job was announced, when, and an excerpt of the job's instruction (600 characters) and of the report (2,000 characters). The record is in the memory database, so it survives a gateway restart. It is used up by your next message and deleted after 30 days, or when the job is deleted.

Your message is treated as possibly being about that report when all of these hold:

- it is in the agent's main conversation (the desktop app, the Control UI, or a direct chat that shares the main session);
- it is your **next** message after the announcement, with no other message of yours in between;
- it arrives within 6 hours of the announcement;
- no answer to a later message of yours exists. When both a report and an answer to one of your recurring requests come before your message, the more recent of the two is the one your message is checked against.

Every message of yours uses up the pending announcement, whatever the message was about. All the usual rules apply: only your own first-party turns, never a group, a guest, a subagent or a heartbeat.

### What can be learned from it

- **An explicit instruction** ("give me the unique counts too every time"). The [correction pass](#how-a-practice-is-captured) runs as on any turn, with one more section in its single model call that names the job and asks, for each instruction it extracts, whether it is about that report. An instruction marked as about the report is saved at `job:<jobId>`, active at once under the same rule as any other practice (stated directly, and more than half of its content words in your own prose). The reply ends with `Practice saved for the <job name> report: "..."`. An instruction that is not about the report ("stop asking where I live") is scoped as on any other turn. Saying "everywhere" still makes it global.
- **A request for something the report left out** ("what about the unique visitors?"). The [follow-up check](#learning-from-follow-ups) runs with the report in the place of the previous answer and the job's instruction in the place of your previous request. A gap becomes a `candidate` at `job:<jobId>`, grounded in your words as usual, and is offered with the same rules: after two sightings on different days, or after one when your message was itself an explicit instruction. The line reads `You have asked for unique visitors after the <job name> report twice. Include it every time? (yes / no)`. Yes makes it an active practice of that job; no suppresses it for good.
- **A new topic.** The model answers `other` and nothing is stored.

A message that fires the correction pre-filter costs one model call, as before. A message that does not costs one call for the follow-up check, once per announced report that you reply to within 6 hours.

### The "Changed since last time" line

The first run of a job after one of its practices was saved, confirmed, reworded or moved to it ends its report with one generated line:

```text
Changed since last time: "Include the unique counts" (from your message on 27 Nov).
```

- The gateway writes the line; the model does not. On a channel it is the last paragraph of the report. For a report kept in the main session it follows the summary.
- One line per report. When several practices changed, the most recent is named and the others are counted ("and 1 more").
- It is shown once per change. The first run after the change uses it up whether or not you reply. A run whose prompt did not carry the practice (for example one that started before you saved it) does not.
- The line says what changed in the job's instructions. It does not say the report followed the practice. If the practice names something to include and none of its content words is in the report, a `not_followed` event is recorded for it.
- A practice added on the Memory page reads "(saved on 27 Nov)".

### Rollback

If your next message after a report that carried the "Changed since last time" line **rejects** that practice ("no, stop including the unique counts"), the practice is retired with reason `rolled_back`, and the reply ends with:

```text
Rolled back: "Include the unique counts". The job runs as before.
```

Only a rejection rolls a practice back. If you ask for the same thing again after that run, the change did not do its work: that is counted as a repeat and the practice stays, because removing what you just asked for a second time would leave you with nothing.

The rules are conservative. A rejection needs all of: an instruction of the opposite kind (you say to stop or leave out what the practice says to include, or the reverse), the model's flag that you are undoing that instruction, its flag that your message is about the report, a statement in your own words, and the practice's own content words in that statement. A bare "no, drop that" is not enough and changes nothing; use the Memory page or name the thing. Only the run right before your message can be rolled back.

### The experience file

Each job with practices has a generated file:

```text
<agent dir>/cron/<jobId>/EXPERIENCE.md
```

By default that is `~/.bitterbot/agents/<agentId>/agent/cron/<jobId>/EXPERIENCE.md` (the state directory follows `BITTERBOT_STATE_DIR`). The folder name is the job id in lowercase.

It lists the practices active for the job, each with the day it took effect and the days you said it, and a dated list of changes: saved, reworded, moved, retired, rolled back, declined, each with the reason. It is written from the practices store and rewritten whole whenever a practice of the job changes. No model writes to it and nothing is appended. The job does not read it: the practices reach the job through its prompt. Edits to the file are lost at the next change.

The file is removed when the job is deleted. The job's practices are kept: they show with the job's id on the Memory page, where you can retire them or move them to another scope.

### Limits

- **Isolated jobs only.** A main-session job is a system event with no report of its own. Long-horizon task wakeups and jobs scheduled by a non-owner run are left out.
- **The main conversation only.** The link is made to the agent's main session. If your direct messages have their own sessions (a `session.dmScope` other than the default), a reply sent there is not linked to the job.
- **The next message only, within 6 hours.** A second comment on the same report, or a comment the next morning, is not linked. Add or change the practice on the Memory page instead, with the job as its scope.
- **A job with `delivery.mode: "none"`** announces nothing, so nothing is linked and no line is shown. Practices saved for it by hand are still given to it.
- **The model decides** whether an instruction is about the report and whether a message is a gap. It can be wrong in both directions.
- **An explicit instruction is often offered instead of saved at once.** The model tends to restate your words with more in them (on a real run, "give me the unique counts too every time" came back as "Include unique counts every time you report repo traffic"), which puts the statement at or under the half of its words that must be yours. It is then stored as a candidate and the same reply asks "Include it every time? (yes / no)". Your yes saves it for the job.
- **With `session.memory: "off"`** no report is recorded and nothing is linked.
- **No trial run.** A practice is not tested before the next scheduled run uses it. The plan's refinement step (re-running the job in a scratch session with two candidate practices and adopting what the trial shows) is not built. The first scheduled run with the "Changed since last time" line, and your next message, are the only check.
- **Rollback retires, it does not repair.** Nothing proposes a better wording.
- Switch all of this off with `memory.practices.jobs.enabled: false`.

## In the daily brief

The [daily dream brief](/memory/dream-engine#the-daily-dream-brief) has a section "What I learned from you". It is read from the practices tables with no model call and covers the same 24 hours as the rest of the brief:

- practices saved, or confirmed by you, in that time;
- candidates you were asked about and have not answered (a candidate that was never offered is not listed);
- "things you no longer have to repeat": active practices that were in a prompt in that time and that you never had to say again, with the number of runs whose prompt included them;
- practices you had to say again in that time, and how often. The brief says that the repeat was counted and nothing was changed, because that is all that happens.

The section is left out when all four are empty. A practice saved or a repeat makes the brief worth sending on a day with no dream news; waiting candidates and practices that were only applied again do not. The brief follows `memory.dreamBrief.enabled`.

## On the Memory page

The **Memory** page of the Control UI has a **Practices** section, below the settled facts. Each practice shows its text, where it applies in words ("For repo stats", "Everywhere"), its status (Active, Waiting for your answer, Retired, Declined), the day it was saved, how many times it was given to your agent, how many times you had to repeat it, and the line you said it on when the transcript still has it.

| Action               | What it calls                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yes, every time / No | `memory.answerPracticeOffer` on a candidate: the same change as answering the offer line in chat.                                                     |
| Edit                 | `memory.editPractice`.                                                                                                                                |
| The scope select     | `memory.setPracticeScope`: Everywhere, one of your recurring task types, the agent's project when it has one, or one of your isolated scheduled jobs. |
| Retire               | `memory.retirePractice`, after a confirmation.                                                                                                        |
| Bring back           | `memory.unretirePractice` on a retired or declined practice.                                                                                          |
| Add                  | `memory.savePractice`, with the scope you pick.                                                                                                       |
| Merge into another   | `memory.mergeTaskTypes`, in the **Task types** list under the practices.                                                                              |

The Task types list shows your recurring kinds of request with how often you asked; the ones that are not recurring yet can be shown too, named by one of their requests, so that a split task can be merged before it recurs.

Reading the section needs `operator.read`; every action needs admin. Without admin the list is shown and an action reports that the session may not change practices. On a gateway older than this section, the section is not shown.

"Given to your agent" is the `applied` counter: runs whose prompt included the practice. When the `notFollowed` counter is above zero the row also shows "not in the answer" with that count. A practice of a scheduled job shows as "For the scheduled job" followed by the job's name (its id when the job was deleted). The **Automations** page lists, under each scheduled job, the practices active for it.

## What sticks

Retiring a practice is your decision and it holds: capture, or any other writer below your tier, cannot store a nearly identical practice again, at any scope. The same goes for a practice with status `suppressed`. Stating the instruction again yourself, or un-retiring it, brings it back.

## Looking at and changing practices

Gateway methods (reads need `operator.read`, changes need admin, like the other `memory.*` methods):

| Method                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.practices`           | Lists practices of every status, or one `status`, with counters, plus the recurring task types. Each practice also carries `scopeLabel` (the scope in words; for a `job:` scope the job's name, or its id when the job no longer exists), `savedAt` and `evidence` (each ref with the line you said, or `null` when it cannot be read; only transcripts in the agent's own sessions folder are read). `activeProject` is the project a `project:` scope would match. `includePendingTaskTypes: true` adds the task types that are not recurring yet. `jobs` lists the isolated scheduled jobs a practice can be scoped to (`scope`, `name`). |
| `memory.savePractice`        | Adds a practice at your tier (`statement`, optional `scope`, optional `evidence`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `memory.editPractice`        | Rewords a practice (`id`, `statement`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory.setPracticeScope`    | Widens or narrows a practice (`id`, `scope`). Logged as `widened` or `narrowed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `memory.retirePractice`      | Retires a practice (`id`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory.unretirePractice`    | Brings back a retired or suppressed practice, or activates a candidate (`id`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `memory.answerPracticeOffer` | Answers a candidate as the offer line would (`id`, `answer`: `yes` or `no`): yes activates it, no sets it to `suppressed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory.mergeTaskTypes`      | Folds task type `from` into `into`; practices scoped to `from` move along.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`cron.list` returns, for each isolated job with active practices, a `practices` list (`id`, `statement`, `savedAt`); `bitterbot cron list` prints them under the job.

Every change writes an event on the practice (`stored`, `applied`, `repeat`, `not_followed`, `offered`, `confirmed`, `declined`, `edited`, `widened`, `narrowed`, `retired` (with `reason: "rolled_back"` for a rollback), `attributed` when a reply carried the "Applied" line for it, and `canary` when a scheduled run used up its "Changed since last time" line) and, for your own actions, an entry in the memory audit log.

From the terminal:

```bash
bitterbot memory practices list [--status candidate] [--json]
bitterbot memory practices backfill [--apply] [--max-calls 40]
bitterbot memory practices merge-types <from> <into>
```

## Configuration

| Key                                    | Default | Effect                                                                                                                                                                                                              |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.practices.enabled`             | `true`  | `false` stops practice capture, task typing and the prompt block. Stored practices are kept and can still be listed, edited and retired.                                                                            |
| `memory.practices.followUps.enabled`   | `true`  | `false` stops the follow-up check: no model call after a recurring-task answer and no candidates. Existing candidates are kept.                                                                                     |
| `memory.practices.offers.enabled`      | `true`  | `false` stops the offer line, and a bare yes or no is no longer read as an answer. Candidates are still stored and can be activated with `memory.unretirePractice`.                                                 |
| `memory.practices.attribution.enabled` | `true`  | `false` stops the "Applied" line. Practices are rendered and counted as before.                                                                                                                                     |
| `memory.practices.jobs.enabled`        | `true`  | `false` stops the announcement record, the link from your next message to a scheduled job, and the "Changed since last time" line. Practices already saved for a job are still given to it.                         |
| `memory.correction.enabled`            | `true`  | Practice capture uses this pass's model call, so `false` also stops practice capture, the follow-up check and the offer line. Stored practices are still rendered.                                                  |
| `session.memory`                       | `"on"`  | `"off"` stops capture (the correction pass does not run) and stops task typing from recording your turns: a turn is still matched against existing recurring types, read-only. Stored practices are still rendered. |

## What this does not do yet

- Follow-up learning looks at one message: your next one after an answer, in the same conversation, within 6 hours. A second follow-up to the same answer, a follow-up the next morning, or one in a new conversation is not checked. When neither the answered request nor the follow-up matches a recurring task type, nothing is checked.
- It costs one model call per recurring-task answer that you reply to within 6 hours, whether or not the reply turns out to be a gap (and one per recurring request sent right after an untyped one). With no model available for the correction pass nothing is checked.
- The model decides gap or other. A gap it misses is not stored, and a gap it names in words you did not use is dropped. The same follow-up can be judged a gap on one run and other on the next.
- To keep the last answer for the next message, the text of your last message (600 characters) and of its answer (2,000 characters) is kept in the memory database per conversation, for at most 7 days, whether or not the message was a recurring task.
- The rule against one-off instructions is about wording: any number or date word in the instruction drops it, including a legitimate one ("Include the top 10").
- Two gaps that mean the same thing in different words ("traffic", "views", "visitors") are separate candidates. A longer gap that contains a stored one ("day by day clones and npm downloads" after "npm downloads") strengthens the stored one and its extra part is not kept.
- In the backfill, a follow-up that was a gap is still counted as an occurrence of its task type.
- An answer delivered with no final text payload (for example fully block-streamed) is not recorded, so the message after it is not checked.
- A follow-up is attached to the task type of the answer before it. If word-overlap typing split your task into several types, the evidence for one gap is split too, until the types are merged.
- The offer is made in direct chats only.
- The "ends with a question" rule reads the last non-empty line of the reply text only. A question earlier in the reply does not hold the offer back, and a turn whose text was delivered by block streaming (no final text) is not checked.
- On a channel, "shown" means the line was appended to the reply handed to the channel's sender. A send that fails afterwards is not detected, and the offer still counts.
- The "Applied" line and the `notFollowed` counter rest on a word match between the practice and the answer. A practice about manner or about leaving something out is never checked.
- The daily brief covers 24 hours. On a day when no brief is sent (nothing new, or the brief is off), a practice that was only applied again is not reported later.
- A comment on a scheduled job's report is linked to the job only as your next message in the main conversation within 6 hours (see [Scheduled jobs](#scheduled-jobs)). Outside that, add a `job:` practice on the Memory page, or with `memory.savePractice` or `memory.setPracticeScope`.
- A practice for a scheduled job is not tried out before the next scheduled run uses it.
- A repeat is counted but not acted on.
- Practices are not part of the memory export or import.
- The link between an answer and your next message, and between an offer and your answer, is stored in the memory database and survives a gateway restart. The once-per-run de-duplication of `applied` and of task typing is in process memory and is lost on restart.
