---
summary: "Model providers (LLMs) supported by Bitterbot"
read_when:
  - You want to choose a model provider
  - You need a quick overview of supported LLM backends
title: "Model Providers"
---

# Model Providers

Bitterbot can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Signal)? See [Channels](/channels).

## Recommended: Anthropic

Anthropic is the recommended provider — the wizard defaults to it, and the
strongest models available should back any agent with tools or untrusted
inboxes (see the security note in the README). Privacy-focused alternatives
like [Venice AI](/providers/venice) and fully local inference via
[Ollama](/providers/ollama) or [vLLM](/providers/vllm) are also supported.

## Quick start

1. Authenticate with the provider (usually via `bitterbot onboard`).
2. Set the default model:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
}
```

## Provider docs

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Together AI](/providers/together)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [NEAR AI Cloud (TEE inference)](/providers/nearai)
- [Venice (Venice AI, privacy-focused)](/providers/venice)
- [Hugging Face (Inference)](/providers/huggingface)
- [Ollama (local models)](/providers/ollama)
- [vLLM (local models)](/providers/vllm)
- [Qianfan](/providers/qianfan)
- [NVIDIA](/providers/nvidia)

## Transcription providers

- [Deepgram (audio transcription)](/providers/deepgram)

## Community tools

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use Claude Max/Pro subscription as an OpenAI-compatible API endpoint

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
