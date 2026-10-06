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
- **Forget it.** It is deleted from the memory table, the keyword index and the vector index together. This cannot be undone.
- **Retire a settled fact.** Facts the agent treats as true without looking them up are listed separately. Retiring one stops that; it is kept in the fact's history, and it can come back if you state it again.
- **Remove a learned preference** (what the agent has picked up about how you like things).
- **Export everything** to a JSON file in `~/.bitterbot/exports/` (0600): every memory with its metadata (no embeddings), the facts ledger with its history, learned preferences, and `MEMORY.md`.

Over the gateway: `memory.list`, `memory.get`, `memory.facts` and `memory.preferences` need read access; `memory.edit`, `memory.forget`, `memory.retireFact`, `memory.forgetPreference` and `memory.export` need admin.

```bash
bitterbot gateway call memory.list --params '{"q":"coffee"}'
bitterbot gateway call memory.forget --params '{"id":"fact_..."}'
bitterbot gateway call memory.export
```

## What is read-only here

- **Memories from conversations and files** (session transcripts, `MEMORY.md`, skill files) are rebuilt from those files whenever they change, so a change made here would not stick. They are listed for reading; change the file instead.
- **Frozen memories** (skills and protected core memories) cannot be changed here.

## What forgetting does not reach

- The conversation transcript the memory was learned from is still on disk; delete the session to remove it.
- Knowledge-graph links that cited the memory are left in place, though they no longer lead to it.
- SQLite keeps deleted text in free pages of the database file until it is compacted.

Every change is written to the memory audit log as "the owner forgot / edited this", without the text.
