---
summary: "CLI reference for `bitterbot onboard` (browser setup page, terminal wizard, non-interactive)"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "onboard"
---

# `bitterbot onboard`

Sets Bitterbot up. By default it finishes setup in your browser: it starts the
gateway (or reuses the one already running), then prints and opens a setup
link:

```text
http://127.0.0.1:19001/setup?token=...
```

The setup page first asks for the same explicit risk acknowledgement as the
terminal wizard, then asks the same questions as the terminal QuickStart, in
the same order, because both run one shared list of steps:

1. **Model provider key.** Keys already on this machine
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` in the gateway
   environment or `~/.bitterbot/.env`, or a key an earlier setup saved) are
   offered by name and last four characters only; the value never reaches the
   browser. Saved sign-ins that are not API keys (OAuth, setup tokens) are
   offered as "Already signed in" and kept as they are. The key you pick is
   saved once where Bitterbot keeps that provider's key (the auth profile
   store for Anthropic and OpenRouter, `~/.bitterbot/.env` with mode 0600 for
   OpenAI), so setup will not ask again. A different key already stored there
   is never lost: the file is copied to `<file>.bak-<time>` (mode 0600) first.
   "Other sign-in methods" points to
   `bitterbot onboard --no-browser --flow manual` for Codex OAuth, Gemini and
   custom endpoints.
2. **Model.** A model already configured is kept unless you pick another.
3. **Memory embeddings.** The local model is the default (about 330 MB,
   downloaded the first time memory needs it).
4. **Web search** (optional). Curiosity research needs it.
5. **Channels.** "Later" is the default; you can chat in the Control UI
   right away.
6. **P2P network.** An explicit choice, with one sentence on what joining
   sends (quoted in [What this node connects to](/network/egress)). Your
   current setting is preselected.
7. **Keep running.** Install the gateway as a background service (systemd
   user service, macOS LaunchAgent) so it keeps running and starts on login.
   Offered, and recommended, where the terminal QuickStart installs one; not in
   a container, on Linux without systemd user services, or when a service is
   already installed. The Done screen says whether Bitterbot now runs as a
   service; on Finish, the gateway `onboard` started for setup stops and the
   service takes over its port.
8. **Privacy.** Bitterbot sends no telemetry to the project, and there is no
   account to create.

"Use recommended defaults" accepts all of them in one click (it still asks for
a key when none was found). After the config is written, setup runs a first
reply on the chosen model ("Say hello and tell me one thing you can do.") and
shows it with its latency; a failure shows the provider's error with Retry,
Back and Skip. The reply runs in its own session (`agent:<id>:setup`), so
retries never land in your main chat, and a reply that takes too long is
stopped before Retry is offered. Provider errors are shown with secrets
masked. A read-only doctor summary closes the setup (`bitterbot doctor` has
the full report).

## The setup link

- Works until setup finishes, for at most 30 minutes, and only for the setup
  steps: it cannot read your config, chat, or use any other gateway function.
  Finishing setup deletes it; running `bitterbot onboard` again replaces it
  and cancels a setup the old link had started (a closed tab never blocks a
  new link).
- Works only at `127.0.0.1` on the gateway's own machine, from the page the
  gateway served (a page from another origin cannot use it). In a container,
  Docker's port mapping is the boundary: keep the published port on
  `127.0.0.1` (the `docker-compose.yml` default). Publishing it on all
  interfaces lets anyone on your network who holds the link reach the setup
  page.
- Setup is complete only after Finish. If the tab closes halfway, run
  `bitterbot onboard` again: the new link picks setup up. Once setup is
  complete, a setup link no longer starts setup; open
  `http://127.0.0.1:19001/setup` in the signed-in Control UI to run it again
  (a tab whose link was refused falls back to that sign-in).
- The page lives under the Control UI base path (`gateway.controlUi.basePath`).

## Choosing the surface

| Situation                                                                  | What `bitterbot onboard` does                    |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| Desktop, terminal session                                                  | Prints the link and opens your browser           |
| SSH, headless, or inside a container                                       | Prints the link (and an `ssh -L` hint over SSH)  |
| `--browser`                                                                | Setup page, even with terminal flags             |
| `--no-browser`                                                             | The terminal wizard                              |
| `--flow`, `--mode`, `--auth-choice`, provider key, gateway or daemon flags | The terminal wizard                              |
| `--json`, `--skip-channels`, `--skip-health`, `--skip-skills`, `--skip-ui` | The terminal wizard                              |
| `--non-interactive`                                                        | No prompts: every recommended answer (see below) |
| No terminal (a script), without `--browser` or `--non-interactive`         | Exits with an error explaining both              |

When no gateway is running, `onboard` starts one in the background
(`gateway --allow-unconfigured --bind loopback`, log in
`~/.bitterbot/logs/gateway-setup.log`). The setup page's "Keep running" step
installs the service; without it, run `bitterbot gateway install` later.

## Non-interactive

`bitterbot onboard --non-interactive --accept-risk` runs the same steps with
their recommended answers: a credential already found (a saved sign-in or key
for the configured model's provider first, else the first key, as above)
unless a provider flag picks one, the configured model kept (or the provider's
recommended model when none is set), local embeddings, web search and
channels later, and P2P left as it is. A key found only in the process
environment is used from there and not copied into any file.

## Related guides

- CLI onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)
- CLI onboarding reference: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI automation: [CLI Automation](/start/wizard-cli-automation)

## Examples

```bash
bitterbot onboard                 # setup page in the browser
bitterbot onboard --no-browser    # terminal wizard
bitterbot onboard --flow quickstart
bitterbot onboard --flow manual
bitterbot onboard --mode remote --remote-url ws://gateway-host:19001
```

Non-interactive custom provider:

```bash
bitterbot onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key` is optional in non-interactive mode. If omitted, onboarding checks `CUSTOM_API_KEY`.

Non-interactive Z.AI endpoint choices:

Note: `--auth-choice zai-api-key` now auto-detects the best Z.AI endpoint for your key (prefers the general API with `zai/glm-5`).
If you specifically want the GLM Coding Plan endpoints, pick `zai-coding-global` or `zai-coding-cn`.

```bash
# Promptless endpoint selection
bitterbot onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

Flow notes:

- `quickstart`: minimal prompts, auto-generates a gateway token.
- `manual`: full prompts for port/bind/auth (alias of `advanced`).
- Fastest first chat: `bitterbot dashboard` (Control UI, no channel setup).
- Custom Provider: connect any OpenAI or Anthropic compatible endpoint,
  including hosted providers not listed. Use Unknown to auto-detect.

## Common follow-up commands

```bash
bitterbot configure
bitterbot agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. Use `--non-interactive` for scripts.
</Note>
