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

## What sticks, and who can undo it

Your decisions outrank the agent's. Every fact in the ledger carries who wrote it, and a higher tier is never overwritten by a lower one:

| Tier | Source                           | Who writes it                                                                 |
| ---- | -------------------------------- | ----------------------------------------------------------------------------- |
| 3    | `owner` (alias `user_directive`) | You: `memory.pinFact` (the Memory page's Retire and Bring back use this tier) |
| 2    | `agent_pin`                      | The agent's `memory_pin` tool                                                 |
| 1    | `extraction`, `seed`             | Session extraction, the first-boot seed                                       |
| 0    | `promotion`, `web_research`      | Dream promotion, curiosity research                                           |

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
