---
summary: "See, correct, forget and export what your agent remembers"
read_when:
  - You want to check or change what the agent remembers
  - You want a copy of the agent's memory
title: "Your memory controls"
---

# Your memory controls

The **Memory** page in the Control UI shows what your agent remembers and gives you the say over it.

## What you can do

- **Find** a memory by its text, newest first.
- **Read** it in full, with where it came from.
- **Correct it.** The new text replaces the old one, is searchable by keyword at once, and is re-embedded so it is found by meaning again.
- **Forget it.** It is deleted from the memory table, the keyword index and the vector index together. This cannot be undone, and it sticks: the agent will not learn the same memory again from the same conversation (see below for the limit).
- **Retire a settled fact.** Facts the agent treats as true without looking them up are listed separately. Retiring one stops that; it is kept in the fact's history. Your retire is final until you lift it: the agent cannot bring the same value back by extracting it again or pinning it itself. Only you can, with **Bring back** in the retired list (`memory.unretireFact`) or by pinning it again (`memory.pinFact`).
- **Pin a fact** (`memory.pinFact`): what you state outranks what the agent pinned or learned, and brings back a fact you had retired.
- **Remove a learned preference** (what the agent has picked up about how you like things). It will not be learned again from the same wording or a close paraphrase.
- **Export everything** to a JSON file in `~/.bitterbot/exports/` (0600): every memory with its metadata (no embeddings), the facts ledger with its history, learned preferences, and `MEMORY.md`.

Over the gateway: `memory.list`, `memory.get`, `memory.facts` (with `status: "active" | "retired" | "all"`) and `memory.preferences` need read access; `memory.edit`, `memory.forget`, `memory.retireFact`, `memory.unretireFact`, `memory.pinFact`, `memory.forgetPreference` and `memory.export` need admin. There is no `bitterbot memory` CLI for these yet (PLAN-55 Phase 5); `bitterbot gateway call` reaches every RPC.

```bash
bitterbot gateway call memory.list --params '{"q":"coffee"}'
bitterbot gateway call memory.forget --params '{"id":"fact_..."}'
bitterbot gateway call memory.facts --params '{"status":"retired"}'
bitterbot gateway call memory.retireFact --params '{"key":"infra.deploy_endpoint"}'
bitterbot gateway call memory.unretireFact --params '{"key":"infra.deploy_endpoint"}'
bitterbot gateway call memory.pinFact --params '{"key":"infra.deploy_endpoint","value":"api2.acme.com"}'
bitterbot gateway call memory.export
```

## Teach it once: corrections captured as you chat

You should not have to open the Memory page to correct your agent. When you say "no, the deploy endpoint is api2.acme.com", "always use the client's timezone for Acme reports" or "call me Vic" in a direct chat, the fact is in the ledger at your authority before the next turn, and the reply tells you so.

How it works, per turn, in order:

1. **A pre-filter** looks at your message for a corrective or standing-instruction shape. The list is the cost policy: a message without one of these shapes costs nothing and is left to the dream-time extractor. The shapes: `No,` / `Nope.` / `Wrong:` at the start of a sentence; `X is not Y` / `isn't`; `actually`; `always`; `never`; `from now on`; `remember`; `it's X not Y`; `use X instead` / `instead of`; `I prefer`; `call me`; `my X is`. Code blocks, inline code, quoted lines (`> ...`) and forwarded or fetched content are ignored, so a pasted diff or an email cannot trigger it or speak as you.
2. **One cheap model call** (the extraction model, `memory.extraction.model`, else the dream model) reads your message and the reply and returns up to five key/value facts, each flagged as a correction or not, with a scope hint. Never more than one call per turn, recorded in the usage ledger as `memory/correction`.
3. **The pin.** A fact is written at your tier (`owner`) only when the model called it a correction **and** the value appears in your own words. Anything else is written at the `extraction` tier, which cannot replace what you or the agent pinned deliberately. The evidence stored on the fact is the line of the conversation you said it on (`session:<file>#L<n>`). If the agent had pinned the same value itself during the turn (`memory_pin`), your words raise that fact to your tier; the agent's `evidence` field never does.
4. **The confirmation line.** The reply ends with one system-generated line, never written by the model, built from what was actually written: `Memory updated: deploy endpoint = api2.acme.com (was api.acme.com)`. It also covers what the agent pinned itself during the turn and what was held (below). In a group or channel chat it carries counts only, never values.

What is held: when the agent's own `memory_pin` would replace a fact that you or it pinned earlier (trust tier 2 or higher), nothing is written. The attempt is recorded as a `pending_supersede` conflict, the line says `held for your confirmation: deploy endpoint api.acme.com -> api9.acme.com`, and the next open-question sweep asks you which is current. Diff-before-confirm with one-tap apply and revert are the next phase; today you confirm by stating the value yourself (chat, or `memory.pinFact`).

Where a fact applies (`scope`): `global` (the default), `project:<name>` or `person:<name>`. A project-scoped fact is injected into the agent's prompt only when the active project matches; the project is the name of the agent's workspace folder (`agents.list[].workspace`), and the shared default workspace counts as no project, so project facts never leak into it. Person-scoped facts are injected everywhere for now. The model only scopes a fact to a project when you tie it to one ("for Acme", "in this repo"); when the line says `scope acme; say "everywhere" to apply to all`, saying so re-pins it as global. The Memory page shows the scope as a chip next to the fact; `memory.facts` returns `scope` and `evidenceRef`; `memory.pinFact` accepts `scope` and `evidence`.

Not captured: heartbeats, cron and scheduled runs, subagents, A2A tasks, circles, webhook sessions, group and channel chats, and anyone who is not you. The dream-time extractor still learns from those transcripts under its own first-party rules.

Switches:

| Key                         | Default | Effect                                                                                                                                                         |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.correction.enabled` | `true`  | `false` stops the per-turn pass. Corrections then reach the ledger only through the agent's `memory_pin` or the dream-time extractor.                          |
| `memory.correction.confirm` | `true`  | `false` keeps the writes but drops the "Memory updated" line.                                                                                                  |
| `session.memory`            | `"on"`  | `"off"` is incognito: transcripts are not indexed into memory, the session extractor does not read them, and corrections are not captured. Replies still work. |

## What sticks, and who can undo it

Your decisions outrank the agent's. Every fact in the ledger carries who wrote it, and a higher tier is never overwritten by a lower one:

| Tier | Source                           | Who writes it                                                                                                     |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 3    | `owner` (alias `user_directive`) | You: `memory.pinFact`, and a correction you state in chat (the Memory page's Retire and Bring back use this tier) |
| 2    | `agent_pin`                      | The agent's `memory_pin` tool (replacing a tier 2+ fact is held for you)                                          |
| 1    | `extraction`, `seed`             | Session extraction, the first-boot seed                                                                           |
| 0    | `promotion`, `web_research`      | Dream promotion, curiosity research                                                                               |

When something is retired, what brings it back depends on who retired it:

| Retired by                                                | Status          | Same value pinned again by extraction, promotion or the agent                        | `memory.pinFact` (you) | Bring back / `memory.unretireFact` (you) |
| --------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------- |
| You: Retire on the Memory page, `memory.retireFact`       | `owner_retired` | Refused, logged as an `owner_retired` conflict, never turned into a question for you | Reactivates it         | Reactivates it                           |
| The agent: `memory_pin retire`                            | `retired`       | Reactivates it                                                                       | Reactivates it         | Reactivates it                           |
| Decay (90 days unconfirmed), hygiene or the ledger's cap  | `retired`       | Reactivates it                                                                       | Reactivates it         | Reactivates it                           |
| The staleness check (three unanswered "still true?" asks) | `unconfirmed`   | Reactivates it                                                                       | Reactivates it         | Reactivates it                           |

A retired fact is not a current belief: a different value for the same key is accepted from any source (it replaces the retired row, which stays in the history as superseded, and there is then nothing to bring back), and the agent is never asked "which is current?" about a key whose fact is retired. Only the exact value you retired stays out.

Behind this is a small table, `memory_suppressions`, that records what you removed. Session extraction, preference extraction, curiosity research and dream insight promotion check it before writing, and the ledger checks it before any pin below your tier. Each entry is recorded in the same transaction as the removal, so a memory is never gone without the record that keeps it gone. What each kind matches:

- **A forgotten memory**: its text, compared after lowercasing and dropping punctuation and spacing, so the same sentence re-extracted with different capitalisation, commas or a missing full stop still matches. A materially reworded memory is a different memory and can come back. If you corrected a memory before forgetting it, both the original and the corrected text are covered.
- **A retired fact**: the exact key and value (case and spacing aside).
- **A removed preference**: its key, and its value compared the same way as memory text; a restatement that the agent would have merged into the removed preference (the same word-overlap test it uses for duplicates) is skipped too.

`memory.unretireFact` and `memory.pinFact` lift a fact's entry; a forgotten memory's entry stays until a later release adds un-forget.

## What is read-only here

- **Memories from conversations and files** (session transcripts, `MEMORY.md`, skill files) are rebuilt from those files whenever they change, so a change made here would not stick. They are listed for reading; change the file instead.
- **Frozen memories** (skills and protected core memories) cannot be changed here.

## What forgetting does not reach

- The conversation transcript the memory was learned from is still on disk; delete the session to remove it.
- Knowledge-graph links that cited the memory are left in place, though they no longer lead to it.
- SQLite keeps deleted text in free pages of the database file until it is compacted.

Every change is written to the memory audit log as "the owner forgot / edited this", without the text.

## Recent changes

The bottom of the Memory page lists what happened to memories lately: what you
deleted or corrected, what faded out because it was not used, what was merged
into a similar memory, and what changed while the agent was dreaming. Internal
bookkeeping is left out, and so is the text of the memory. The same list is
available from the CLI:

```bash
bitterbot gateway call memory.audit --params '{"limit": 50}'
```
