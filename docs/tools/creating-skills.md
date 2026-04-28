---
title: "Creating Skills"
---

# Creating Custom Skills 🛠

Bitterbot is designed to be easily extensible. "Skills" are the primary way to add new capabilities to your assistant.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file (which provides instructions and tool definitions to the LLM) and optionally some scripts or resources.

## Two ways to author

### Option A — In-app editor (recommended)

The desktop app has a built-in skill editor. Open the **Skills** view, click **+ New skill**, pick a starter template (basic / API-backed / shell-tool), edit the SKILL.md inline, and save. The editor validates frontmatter client-side and writes the file via the `skills.create` gateway method. The new skill lands disabled by default and becomes visible to the agent on its next turn (no restart required).

You can target either:

- **Managed** (`~/.bitterbot/skills`) — shared across every agent on this machine.
- **Workspace** — scoped to the currently selected agent.

### Option B — Filesystem (CLI / editor)

If you'd rather author the skill outside the app:

#### 1. Create the directory

Skills live in your workspace, usually `~/.bitterbot/workspace/skills/`. Create a new folder for your skill:

```bash
mkdir -p ~/.bitterbot/workspace/skills/hello-world
```

#### 2. Define the `SKILL.md`

Create a `SKILL.md` file in that directory. This file uses YAML frontmatter for metadata and Markdown for instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

#### 3. Add tools (optional)

You can define custom tools in the frontmatter or instruct the agent to use existing system tools (like `bash` or `browser`).

#### 4. Pick it up

The skills file watcher (enabled by default) bumps the snapshot version when it sees a new `SKILL.md`. The agent picks up the change on its next turn — no manual refresh or restart needed.

## Best Practices

- **Be Concise**: Instruct the model on _what_ to do, not how to be an AI.
- **Safety First**: If your skill uses `bash`, ensure the prompts don't allow arbitrary command injection from untrusted user input.
- **Test Locally**: Use `bitterbot agent --message "use my new skill"` to test.

## Shared Skills

You can also browse and contribute skills on [GitHub](https://github.com/bitterbot/bitterbot).
