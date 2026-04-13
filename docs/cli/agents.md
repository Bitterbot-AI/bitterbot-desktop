---
summary: "CLI reference for `bitterbot agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `bitterbot agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
bitterbot agents list
bitterbot agents add work --workspace ~/.bitterbot/workspace-work
bitterbot agents set-identity --workspace ~/.bitterbot/workspace --from-identity
bitterbot agents set-identity --agent main --avatar avatars/bitterbot.png
bitterbot agents delete work
```

## Identity

Agent identity (name, theme, emoji, avatar) is configured via the CLI or config file. The agent's personality and self-concept evolve through dream cycles and are stored in the Phenotype section of `MEMORY.md`.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

```bash
bitterbot agents set-identity --name "Bitterbot" --emoji "🤖"
```

Override fields explicitly:

```bash
bitterbot agents set-identity --agent main --name "Bitterbot" --emoji "🤖" --avatar avatars/bitterbot.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Bitterbot",
          theme: "assistant",
          emoji: "🤖",
          avatar: "avatars/bitterbot.png",
        },
      },
    ],
  },
}
```
