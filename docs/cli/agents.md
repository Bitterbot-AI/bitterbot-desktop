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

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.bitterbot/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
bitterbot agents set-identity --workspace ~/.bitterbot/workspace --from-identity
```

Override fields explicitly:

```bash
bitterbot agents set-identity --agent main --name "Bitterbot" --emoji "🦞" --avatar avatars/bitterbot.png
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
          emoji: "🦞",
          avatar: "avatars/bitterbot.png",
        },
      },
    ],
  },
}
```
