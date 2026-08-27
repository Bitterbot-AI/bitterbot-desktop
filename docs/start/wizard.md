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
bitterbot onboard
```

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
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). Easiest path: `bitterbot configure --section web`
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).

<Tabs>
  <Tab title="QuickStart (defaults)">
    Five prompts: risk acknowledgement, setup flow, provider + API key, and
    P2P network consent. Everything else takes a sane default:

    - Local gateway (loopback), port **19001**, auth **Token** (auto‑generated), Tailscale **Off**
    - Workspace default (or existing workspace)
    - The provider's default model (no model picker)
    - Long-term memory runs on the bundled local embedding model unless a remote key already exists
    - Built-in hooks enabled automatically (session-memory, boot-md, command-logger)
    - Channels, skills, web search, and the wallet are deferred — set them up
      anytime in the Control UI or via `bitterbot configure`

  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes every step (mode, workspace, gateway, model picker, embeddings,
      web search, channels, daemon, skills, wallet, hooks).
  </Tab>
</Tabs>

## What the wizard configures

**Local mode (default)** walks you through these steps:

1. **Model/Auth** — Anthropic API key (recommended), OpenAI, or Custom Provider
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Advanced flow also picks a default model.
2. **Workspace** — Location for agent files (default `~/.bitterbot/workspace`). Seeds bootstrap files.
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
4. **Channels** _(Advanced)_ — WhatsApp, Telegram, Discord, Google Chat, Mattermost, or Signal.
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
