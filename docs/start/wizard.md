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
and opens a setup link, `http://127.0.0.1:19001/setup?token=...`. The link
works until setup finishes, for at most 30 minutes, only on this machine, and
only for the setup steps. Running `bitterbot onboard` again prints a new link
and retires the old one, together with any setup it had started (a closed tab
never blocks setup). Over SSH, in a container, or without a display, it prints
the link instead of opening it; over SSH, forward the port first
(`ssh -N -L 19001:127.0.0.1:19001 <host>`). Without a terminal at all (a
script), `bitterbot onboard` stops with an error: pass `--browser` to print
the link, or use `--non-interactive`.

Setup starts with the same explicit risk acknowledgement as the terminal
wizard. Then the browser and the terminal QuickStart run **one list of
steps**, so they ask the same things:

1. **Model provider key**: keys found on this machine (`ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) are offered by
   name and last four characters; their values never reach the browser. You
   can also paste an Anthropic, OpenAI, OpenRouter or Google Gemini API key. A saved sign-in
   that is not a key (an OAuth sign-in or a setup token) is offered as
   "Already signed in" and kept. The key you pick is saved once, so you are not
   asked again. If a different key is already saved where it goes, the file is
   copied to a timestamped backup next to it first (`auth-profiles.json.bak-*`
   or `.env.bak-*`, readable by you only) and setup tells you where. Other
   sign-in methods (Codex OAuth, Anthropic setup tokens, Bedrock, local and
   custom endpoints) are under "Other sign-in methods": run
   `bitterbot onboard --no-browser --flow manual`.
2. **Model**: a model already in your config is kept unless you pick another.
   The recommended model is Claude Sonnet 5.5 for Anthropic, GPT-5.5 for
   OpenAI, OpenRouter Auto for OpenRouter, and Gemini 3.1 Pro preview for
   Google Gemini.
3. **Memory embeddings**: the local model by default (about 330 MB, downloaded
   on first use). With an OpenAI or Google Gemini key, that provider's
   embeddings are offered too.
4. **Web search** (optional): curiosity research needs it. Use a search key
   already in the environment, Parallel Search (free, no key), or paste a
   Brave Search (free tier), Tavily, or Perplexity (paid per search) key.
5. **Channels**: later by default.
6. **P2P network**: an explicit choice, with what joining sends (see
   [What this node connects to](/network/egress)); your current setting is
   preselected.
7. **Keep running**: install the gateway as a background service (systemd
   user service on Linux, LaunchAgent on macOS) so it keeps running and starts
   on login. Recommended wherever the terminal QuickStart installs one; not
   offered in a container, on Linux without systemd user services, or when a
   service is already installed. The Done screen says whether it is running as
   a service. The gateway `bitterbot onboard` started for setup hands its port
   to the service when you click Finish.
8. **Privacy**: Bitterbot sends no telemetry to the project, and there is no
   account.

**Use recommended defaults** accepts every step in one click, except two it
still asks: the model key when none was found, and web search when no search
key was found (leaving it for later keeps curiosity research off). When the config
is written, setup runs a first reply on your model and shows it with its
latency (Retry, Back and Skip on failure), then a read-only doctor summary.
The first reply runs in its own session (`agent:<id>:setup`), not your main
chat. Setup counts as finished only when you click Finish: if the tab closes
halfway, run `bitterbot onboard` again for a new link that picks it up.
Details: [`bitterbot onboard`](/cli/onboard).

<Note>
An OpenAI key is saved to `~/.bitterbot/.env` (mode 0600). The gateway loads
that file without overriding its own environment, so an `OPENAI_API_KEY`
already exported in the gateway's shell or service environment wins after a
restart; setup warns when the two differ. Remove or update the exported one.
</Note>

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
    Risk acknowledgement and the flow choice, then the setup steps above (or
    "Use recommended defaults"; with `--auth-choice` on a terminal the fork is
    still shown, and only a run without a terminal takes the recommended answers
    unasked). Everything else takes a sane default:

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

1. **Model/Auth**: Anthropic API key (recommended), OpenAI, or Custom Provider
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Advanced flow also picks a default model.
2. **Workspace**: Location for agent files (default `~/.bitterbot/workspace`). Seeds bootstrap files.
3. **Gateway**: Port, bind address, auth mode, Tailscale exposure.
4. **Channels** _(Advanced)_: WhatsApp, Telegram, Discord, Slack, or Signal.
   QuickStart defers this to the Control UI or `bitterbot channels add`.
5. **Daemon**: Installs a LaunchAgent (macOS) or systemd user unit (Linux/WSL2).
6. **Health check**: Starts the Gateway and verifies it's running.
7. **Skills** _(Advanced)_: Installs recommended skills and optional dependencies.
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
