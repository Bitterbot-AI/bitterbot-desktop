---
summary: "CLI reference for `bitterbot onboard` (browser setup page, terminal wizard, non-interactive)"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "onboard"
---

# `bitterbot onboard`

Sets Bitterbot up. By default it finishes setup in your browser: it starts the
gateway (or reuses the one already running), then prints and opens a one-time
setup link:

```text
http://127.0.0.1:19001/setup?token=...
```

The setup page asks the same questions as the terminal QuickStart, in the same
order, because both run one shared list of steps:

1. **Model provider key.** Keys already on this machine
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` in the gateway
   environment or `~/.bitterbot/.env`, or a key an earlier setup saved) are
   offered by name and last four characters only; the value never reaches the
   browser. The key you pick is saved once where Bitterbot keeps that
   provider's key (the auth profile store for Anthropic and OpenRouter,
   `~/.bitterbot/.env` for OpenAI), so setup will not ask again.
2. **Model.**
3. **Memory embeddings.** The local model is the default (about 330 MB,
   downloaded the first time memory needs it).
4. **Web search** (optional). Curiosity research needs it.
5. **Channels.** "Later" is the default; you can chat in the Control UI
   right away.
6. **P2P network.** An explicit choice, with one sentence on what joining
   sends (quoted in [What this node connects to](/network/egress)). Your
   current setting is preselected.
7. **Privacy.** Bitterbot sends no telemetry to the project, and there is no
   account to create.

"Use recommended defaults" accepts all of them in one click (it still asks for
a key when none was found). After the config is written, setup runs a first
reply on the chosen model ("Say hello and tell me one thing you can do.") and
shows it with its latency; a failure shows the provider's error with Retry,
Back and Skip. A read-only doctor summary closes the setup (`bitterbot doctor`
has the full report).

## The setup link

- Works once, for 30 minutes, and only for the setup steps: it cannot read
  your config, chat, or use any other gateway function. Finishing setup
  deletes it; running `bitterbot onboard` again replaces it.
- Works only at `127.0.0.1` on the gateway's own machine (for Docker, through
  the published loopback port).
- Once setup is complete, a setup link no longer starts setup; open
  `http://127.0.0.1:19001/setup` in the signed-in Control UI to run it again.
- The page lives under the Control UI base path (`gateway.controlUi.basePath`).

## Choosing the surface

| Situation                                                                  | What `bitterbot onboard` does                    |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| Desktop, terminal session                                                  | Prints the link and opens your browser           |
| SSH, headless, or inside a container                                       | Prints the link (and an `ssh -L` hint over SSH)  |
| `--browser`                                                                | Setup page, even with terminal flags             |
| `--no-browser`                                                             | The terminal wizard                              |
| `--flow`, `--mode`, `--auth-choice`, provider key, gateway or daemon flags | The terminal wizard                              |
| `--non-interactive`                                                        | No prompts: every recommended answer (see below) |

When no gateway is running, `onboard` starts one in the background
(`gateway --allow-unconfigured --bind loopback`, log in
`~/.bitterbot/logs/gateway-setup.log`). Run it as a service afterwards with
`bitterbot gateway install`.

## Non-interactive

`bitterbot onboard --non-interactive --accept-risk` runs the same steps with
their recommended answers: the first key found (as above) unless a provider
flag picks one, the provider's recommended model, local embeddings, web search
and channels later, and P2P left as it is.

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
