---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up Bitterbot on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
bitterbot onboard               # finishes setup in your browser (default)
bitterbot onboard --no-browser  # the same steps in the terminal
```

## Setup in the browser (default)

`bitterbot onboard` starts the gateway (or reuses the running one) and prints
and opens a one-time link, `http://127.0.0.1:19001/setup?token=...`. The link
works once, for 30 minutes, only on this machine, and only for the setup steps.
Over SSH, in a container, or without a display, it prints the link instead of
opening it; over SSH, forward the port first
(`ssh -N -L 19001:127.0.0.1:19001 <host>`).

The browser and the terminal QuickStart run **one list of steps**, so they ask
the same things:

1. **Model provider key**: keys found on this machine are offered by name and
   last four characters; their values never reach the browser. The key you
   pick is saved once, so you are not asked again.
2. **Model**.
3. **Memory embeddings**: the local model by default (about 330 MB, downloaded
   on first use).
4. **Web search** (optional): curiosity research needs it.
5. **Channels**: later by default.
6. **P2P network**: an explicit choice, with what joining sends (see
   [What this node connects to](/network/egress)); your current setting is
   preselected.
7. **Privacy**: Bitterbot sends no telemetry to the project, and there is no
   account.

**Use recommended defaults** accepts every step in one click. When the config
is written, setup runs a first reply on your model and shows it with its
latency (Retry, Back and Skip on failure), then a read-only doctor summary.
Details: [`bitterbot onboard`](/cli/onboard).

<Info>
Fastest first chat: open the Control UI (no channel setup needed). Run
`bitterbot dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).
</Info>

To reconfigure later:

```bash
bitterbot configure
bitterbot agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`;
it runs the same steps with their recommended answers.
</Note>

## QuickStart vs Advanced (terminal)

The terminal wizard starts with **QuickStart** (the setup steps above) vs
**Advanced** (full control).

<Tabs>
  <Tab title="QuickStart (the setup steps)">
    Risk acknowledgement and the flow choice, then the seven setup steps above
    (or "Use recommended defaults"). Everything else takes a sane default:

    - Local gateway (loopback), port **19001**, auth **Token** (auto-generated), Tailscale **Off**
    - Workspace default (or existing workspace)
    - Built-in hooks enabled automatically (session-memory, boot-md, command-logger)
    - Skills and the wallet are deferred: set them up anytime in the Control UI
      or via `bitterbot configure`

  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes every step (mode, workspace, gateway, every provider, model picker,
      embeddings, web search, channels, daemon, skills, wallet, hooks).
  </Tab>
</Tabs>

## What the wizard configures

**Local mode (default)** walks you through these steps:

1. **Model/Auth** — Anthropic API key (recommended), OpenAI, or Custom Provider
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Advanced flow also picks a default model.
2. **Workspace** — Location for agent files (default `~/.bitterbot/workspace`). Seeds bootstrap files.
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
4. **Channels** _(Advanced)_ — WhatsApp, Telegram, Discord, Slack, or Signal.
   QuickStart defers this to the Control UI or `bitterbot channels add`.
5. **Daemon** — Installs a LaunchAgent (macOS) or systemd user unit (Linux/WSL2).
6. **Health check** — Starts the Gateway and verifies it's running.
7. **Skills** _(Advanced)_ — Installs recommended skills and optional dependencies.
   QuickStart keeps the bundled skills and defers extras.

<Note>
Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).
If the config is invalid or contains legacy keys, the wizard asks you to run `bitterbot doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## Add another agent

Use `bitterbot agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspaces follow `~/.bitterbot/workspace-<agentId>`.
- Add `bindings` to route inbound messages (the wizard can do this).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step breakdowns, non-interactive scripting, Signal setup,
RPC API, and a full list of config fields the wizard writes, see the
[Wizard Reference](/reference/wizard).

## Related docs

- CLI command reference: [`bitterbot onboard`](/cli/onboard)
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
