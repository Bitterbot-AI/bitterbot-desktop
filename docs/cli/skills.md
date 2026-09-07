---
summary: "CLI reference for `bitterbot skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `bitterbot skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- Skills: [Skills](/tools/skills)

## Commands

```bash
bitterbot skills list
bitterbot skills list --eligible
bitterbot skills info <name>
bitterbot skills check
bitterbot skills evidence [name]
```

### `skills evidence`

Prints the evidence record behind a live skill: its lifecycle ladder
(staged, validated, canary, stable, rolled back, retired, canary off), the
validation gate verdict with its p-value and win/loss trials, the canary
window, production reads over the 14-day window with their success rate and
evidence level, the models it was validated on and read by, and the gate
history. Without a name it lists every evolved or received skill; `--all`
includes local and bundled skills; `--json` prints the record as written.

The record is the `.evidence.json` housekeeping rebuilds next to each live
skill, so this command, the Control UI's Evolution tab and the evidence
published with the skill all show the same numbers. It reads the files
directly and does not need the gateway.
