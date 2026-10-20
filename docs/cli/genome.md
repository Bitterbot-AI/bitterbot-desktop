---
summary: "CLI reference for `bitterbot genome temperament` (show, add or change the agent's base personality)"
read_when:
  - You want to see or change your agent's starting voice
  - Your agent was created before GENOME.md had a Temperament section
title: "genome"
---

# `bitterbot genome`

Your agent's `GENOME.md` from the terminal. Today that is one command,
`temperament`, for the section that sets the agent's starting voice. The
agent itself cannot change `GENOME.md`; these are your edits.

Related:

- What the Genome and the Temperament are: [Biological identity](/memory/biological-identity)
- Setup's vibe pick: [`bitterbot onboard`](/cli/onboard)

## Examples

```bash
bitterbot genome temperament                      # show the section, or what would be added
bitterbot genome temperament --add                # add it (level irreverent)
bitterbot genome temperament --add --level calm   # add it at another level
bitterbot genome temperament --level playful      # change the level
bitterbot genome temperament --json
```

## `genome temperament`

Without flags it shows the Temperament section of the agent's `GENOME.md`
and its level, or, for a `GENOME.md` from before the section existed, the
section that would be added. Nothing is written.

- `--add` adds the section after everything else in `GENOME.md`. No other
  section changes, and the Phenotype in `MEMORY.md` is not touched.
- `--level calm|playful|irreverent` sets the level (with `--add`, the level
  of the new section). Calm is dry with no swearing, playful has warm humor
  and swears only if you do, irreverent is witty and swears where it fits.
- `--agent <id>` picks another configured agent (default: the default agent).
- `-y, --yes` skips the confirmation. Without a terminal, `--yes` is required
  for a write.
- `--json` prints the status or the result as JSON.

Each write keeps a copy of the previous `GENOME.md` in
`~/.bitterbot/genome-guard/owner-previous-<time>-<hash>.md`. With the gateway
running, the write goes through it (`genome.temperament.apply`), so the
genome guard knows the new content is yours; with no gateway running it is
written directly. The new voice applies from the agent's next turn.

The Control UI offers the same thing once, as a card on the Overview page:
"A base personality is available for your agent" with Preview, Add and Not
now. The card does not come back after Not now (per browser) or once the
section exists.
