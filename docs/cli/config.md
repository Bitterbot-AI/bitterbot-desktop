---
summary: "CLI reference for `bitterbot config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `bitterbot config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `bitterbot configure`).

## Examples

```bash
bitterbot config get browser.executablePath
bitterbot config set browser.executablePath "/usr/bin/google-chrome"
bitterbot config set agents.defaults.heartbeat.every "2h"
bitterbot config set agents.list[0].tools.exec.node "node-id-or-name"
bitterbot config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
bitterbot config get agents.defaults.workspace
bitterbot config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
bitterbot config get agents.list
bitterbot config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
bitterbot config set agents.defaults.heartbeat.every "0m"
bitterbot config set gateway.port 19001 --json
bitterbot config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
