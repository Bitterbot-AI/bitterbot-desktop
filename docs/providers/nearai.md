---
summary: "Use NEAR AI Cloud TEE inference in Bitterbot"
read_when:
  - You want NEAR AI Cloud setup guidance
  - You want TEE-backed OpenAI-compatible inference
title: "NEAR AI Cloud"
---

# NEAR AI Cloud

NEAR AI Cloud provides OpenAI-compatible model inference through `https://cloud-api.near.ai/v1`.
Bitterbot registers it as the `nearai` provider and uses `NEARAI_API_KEY` for auth.

## Setup

### 1. Get an API key

Create a key from [cloud.near.ai](https://cloud.near.ai).

### 2. Configure Bitterbot

Environment variable:

```bash
export NEARAI_API_KEY="..."
```

Interactive setup:

```bash
bitterbot onboard --auth-choice nearai-api-key
```

Non-interactive setup:

```bash
bitterbot onboard --non-interactive \
  --auth-choice nearai-api-key \
  --nearai-api-key "$NEARAI_API_KEY"
```

### 3. Verify

```bash
bitterbot chat --model nearai/zai-org/GLM-5.1-FP8 "Hello, are you working?"
```

## Model Discovery

When `NEARAI_API_KEY` or a `nearai` auth profile is present, Bitterbot discovers current chat
models from the public NEAR AI catalog:

```text
GET https://cloud-api.near.ai/v1/model/list
```

The built-in fallback catalog is only used for offline setup, tests, or temporary catalog failures.
It is seeded from the public model list so setup still works when runtime discovery is unavailable.

## Default Model

Bitterbot defaults NEAR AI Cloud setup to:

```text
nearai/zai-org/GLM-5.1-FP8
```

Other useful models currently exposed by the catalog include:

| Model ref                               | Notes                 |
| --------------------------------------- | --------------------- |
| `nearai/zai-org/GLM-5.1-FP8`            | Default TEE model     |
| `nearai/Qwen/Qwen3.6-35B-A3B-FP8`       | TEE text model        |
| `nearai/Qwen/Qwen3-VL-30B-A3B-Instruct` | TEE vision model      |
| `nearai/anthropic/claude-opus-4-7`      | Long-context model    |
| `nearai/anthropic/claude-sonnet-4-6`    | Long-context model    |
| `nearai/openai/gpt-5.4-mini`            | OpenAI-compatible API |

Run `bitterbot models list | grep nearai` for the current list available to your account.

## Compatibility

NEAR AI Cloud uses OpenAI-compatible chat completions with these provider settings:

- Base URL: `https://cloud-api.near.ai/v1`
- API key env var: `NEARAI_API_KEY`
- Auth header: `Authorization: Bearer <key>`
- Model catalog: `GET /model/list`
- Token limit field: `max_tokens`

Bitterbot disables unsupported OpenAI-only request fields for NEAR AI Cloud, including `store`,
`developer`, `reasoning_effort`, and strict structured-output mode.

## Config File Example

```json5
{
  env: { NEARAI_API_KEY: "..." },
  agents: { defaults: { model: { primary: "nearai/zai-org/GLM-5.1-FP8" } } },
  models: {
    mode: "merge",
    providers: {
      nearai: {
        baseUrl: "https://cloud-api.near.ai/v1",
        apiKey: "${NEARAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "zai-org/GLM-5.1-FP8",
            name: "GLM 5.1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.85, output: 3.3, cacheRead: 0.17, cacheWrite: 0.85 },
            contextWindow: 202752,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```
