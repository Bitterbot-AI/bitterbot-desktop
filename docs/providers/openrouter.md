---
summary: "Use OpenRouter's unified API to access many models in Bitterbot"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in Bitterbot
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
bitterbot onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.

## App attribution

Bitterbot identifies itself to OpenRouter with the standard
[app attribution headers](https://openrouter.ai/docs/app-attribution) on every OpenRouter request,
including background work such as dreams, memory extraction, and image understanding:

| Header | Value |
| --- | --- |
| `HTTP-Referer` | `https://bitterbot.ai` |
| `X-OpenRouter-Title` (and legacy `X-Title`) | `Bitterbot` |
| `X-OpenRouter-Categories` | `personal-agent,general-chat` |

These headers name the app only. They carry nothing about you, your node, or your conversations.
Your usage counts toward Bitterbot's public app page and its place in OpenRouter's rankings.

The same headers are sent to any custom provider whose base URL is `openrouter.ai`.
