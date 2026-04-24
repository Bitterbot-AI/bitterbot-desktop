---
title: "Environment variables"
description: "Where the gateway reads env vars from, and the vars you're most likely to set."
sidebarTitle: "Environment vars"
---

# Environment variables

The gateway reads environment variables from (highest to lowest precedence):

1. The parent process's environment (the shell that launched Bitterbot, or the systemd / launchd unit).
2. `./.env` in the current working directory.
3. `~/.bitterbot/.env` (or `$BITTERBOT_STATE_DIR/.env`).
4. The `env.vars` block in `~/.bitterbot/bitterbot.json`.

Existing non-empty process-env vars are **never** overridden by a lower-precedence source. That means:

- Your shell's `OPENAI_API_KEY` beats the one in `~/.bitterbot/.env`.
- Inline `env.vars` only fills in missing keys; it can't rotate an already-set secret.
- If you want to reset a value, unset it upstream (or edit the file that actually supplies it).

`${VAR_NAME}` substitution works inside `bitterbot.json` string values — useful for keeping secrets out of committed config. See [Config reference → Env var substitution](/gateway/configuration-reference#env-var-substitution).

<Note>
The onboarding wizard (`bitterbot configure`) writes most of these for you. This page is for operators who want to set them directly (CI, Docker, launchd, systemd, ansible, …).
</Note>

## Gateway

| Var                              | Purpose                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `BITTERBOT_GATEWAY_TOKEN`        | WS auth token. Recommended even for loopback binds. Generate with `openssl rand -hex 32`.      |
| `BITTERBOT_GATEWAY_PASSWORD`     | Alternative auth mode (use token OR password).                                                 |
| `BITTERBOT_HOME`                 | Override the home directory used for internal path resolution (default: `$HOME`).              |
| `BITTERBOT_STATE_DIR`            | Override the state dir (default: `~/.bitterbot`). Picks up `.env`, config, sessions from here. |
| `BITTERBOT_CONFIG_PATH`          | Override the config file (default: `~/.bitterbot/bitterbot.json`).                             |
| `BITTERBOT_LOAD_SHELL_ENV`       | `1` to import missing keys from your login shell profile.                                      |
| `BITTERBOT_SHELL_ENV_TIMEOUT_MS` | Timeout for the shell-env import (default 15 000 ms).                                          |

Startup skip flags (`BITTERBOT_SKIP_CHANNELS`, `BITTERBOT_SKIP_CRON`, …) live in [Config reference → Startup skip flags](/gateway/configuration-reference#startup-skip-flags-bitterbot_skip_).

## Model providers

Set at least one to actually run the agent. The wizard writes whichever one you pick, but any of these are picked up directly from env.

| Var                  | Provider                                 |
| -------------------- | ---------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI                                   |
| `ANTHROPIC_API_KEY`  | Anthropic                                |
| `GEMINI_API_KEY`     | Google Gemini                            |
| `OPENROUTER_API_KEY` | OpenRouter (multi-model proxy)           |
| `XAI_API_KEY`        | xAI (Grok)                               |
| `OPENCODE_API_KEY`   | OpenCode Zen (or `OPENCODE_ZEN_API_KEY`) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway                        |
| `MINIMAX_API_KEY`    | MiniMax                                  |
| `SYNTHETIC_API_KEY`  | Synthetic (Anthropic-compatible)         |
| `ZAI_API_KEY`        | Z.AI                                     |

Provider lookup order: auth profiles → env vars → `models.providers.*.apiKey` in config.

## Agent wallet (CDP)

Required if the wallet is enabled. Easiest path: run `bitterbot configure --section wallet` and let the wizard walk you through getting these from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com).

| Var                  | Purpose                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `CDP_API_KEY_ID`     | UUID. From CDP Portal → API Keys. Config fallback: `tools.wallet.cdpApiKeyId`.                       |
| `CDP_API_KEY_SECRET` | Ed25519 base64 string. Shown once by the portal. Config fallback: `tools.wallet.cdpApiKeySecret`.    |
| `CDP_WALLET_SECRET`  | Separate signing key. From CDP Portal → Wallets → Wallet Secret. **Env-only** (not in config).       |
| `RPC_URL`            | Base RPC endpoint (default: `https://mainnet.base.org`). Swap for a paid RPC if you hit rate limits. |

See [Agent wallet](/wallet) for what the credentials unlock.

## Wallet funding (Stripe Crypto Onramp)

Three ways to point the agent at a funding source. Set at most one group.

| Var                      | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | Tier 2 — BYO Stripe. Creates onramp sessions locally.           |
| `STRIPE_PUBLISHABLE_KEY` | Tier 2 companion.                                               |
| `BITTERBOT_ONRAMP_URL`   | Tier 3 — BYO hosted endpoint. POSTs to your own onramp service. |

With no Stripe keys and no onramp URL set, Tier 1 kicks in automatically: the wallet uses `https://onramp.bitterbot.ai`.

See [Wallet funding](/wallet/wallet-funding) for what each tier does.

## Channels

Only set what you actually enable. The wizard prompts for these, but you can skip the wizard by pre-populating env.

| Var                             | Channel                          |
| ------------------------------- | -------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | Telegram bot token               |
| `DISCORD_BOT_TOKEN`             | Discord bot token                |
| `SLACK_BOT_TOKEN`               | Slack bot token (`xoxb-…`)       |
| `SLACK_APP_TOKEN`               | Slack app-level token (`xapp-…`) |
| `MATTERMOST_BOT_TOKEN`          | Mattermost                       |
| `MATTERMOST_URL`                | Mattermost base URL              |
| `ZALO_BOT_TOKEN`                | Zalo                             |
| `BITTERBOT_TWITCH_ACCESS_TOKEN` | Twitch (`oauth:…`)               |

WhatsApp pairs via QR and stores credentials on disk at `~/.bitterbot/credentials/whatsapp/<accountId>/`, so it has no env var.

## Tools / voice / web

All optional.

| Var                  | Tool                             |
| -------------------- | -------------------------------- |
| `BRAVE_API_KEY`      | Brave web search                 |
| `PERPLEXITY_API_KEY` | Perplexity                       |
| `FIRECRAWL_API_KEY`  | Firecrawl                        |
| `TAVILY_API_KEY`     | Tavily                           |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS (or `XI_API_KEY`) |
| `DEEPGRAM_API_KEY`   | Deepgram STT                     |

## Related

- [Config reference](/gateway/configuration-reference) — everything that lives in `bitterbot.json`, including `env.vars` / `env.shellEnv` and `${VAR}` substitution.
- [Authentication](/gateway/authentication) — where auth tokens are sourced and rotated.
- [Setup → Credential storage map](/start/setup#credential-storage-map) — where each credential lands on disk.
- [Agent wallet](/wallet) — what the CDP credentials unlock.
