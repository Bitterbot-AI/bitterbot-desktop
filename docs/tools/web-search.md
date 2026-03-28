---
summary: "Web search provider setup: Tavily, Brave, Perplexity, Grok"
read_when:
  - You want to configure a web search provider
  - You need API keys for Tavily, Brave, Perplexity, or Grok
title: "Web Search Providers"
---

# Web Search Providers

Bitterbot supports 4 web search providers for the `web_search` tool. Pick one and configure its API key.

| Provider | Env Variable | Free Tier | Best For |
|----------|-------------|-----------|----------|
| **Tavily** | `TAVILY_API_KEY` | 1,000 req/month | Structured results, AI-optimized |
| **Brave** | `BRAVE_API_KEY` | 2,000 req/month | Privacy-focused, fast |
| **Perplexity** | `PERPLEXITY_API_KEY` | Pay-per-use | AI-synthesized answers with citations |
| **Grok** | `XAI_API_KEY` | Varies | X/Twitter integration |

## Quick Setup

The fastest path: pick a provider, set the env variable, done.

```bash
# Option 1: Tavily (recommended for most users)
export TAVILY_API_KEY="tvly-..."

# Option 2: Brave
export BRAVE_API_KEY="BSA..."

# Option 3: Perplexity
export PERPLEXITY_API_KEY="pplx-..."

# Option 4: Grok
export XAI_API_KEY="xai-..."
```

Or add to your `.env` file in the Bitterbot root / gateway environment.

## Config File Setup

You can also configure the provider in `~/.bitterbot/bitterbot.json`:

### Tavily

```json5
{
  tools: {
    web: {
      search: {
        provider: "tavily",
        tavily: {
          apiKey: "tvly-...",
          searchDepth: "basic",  // or "advanced" for deeper results
        },
      },
    },
  },
}
```

Get your key at [tavily.com](https://tavily.com). The free tier includes 1,000 searches/month.

### Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BSA...",
        maxResults: 5,
      },
    },
  },
}
```

Get your key at [brave.com/search/api](https://brave.com/search/api/). Use the **Data for Search** plan (not Data for AI).

### Perplexity

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          model: "perplexity/sonar-pro",  // or sonar, sonar-reasoning-pro
        },
      },
    },
  },
}
```

Get your key at [perplexity.ai](https://www.perplexity.ai/). Also available via OpenRouter (`OPENROUTER_API_KEY`).

### Grok

```json5
{
  tools: {
    web: {
      search: {
        provider: "grok",
      },
    },
  },
}
```

Uses your `XAI_API_KEY` environment variable.

## Auto-Detection

If no provider is explicitly set, Bitterbot checks for API keys in this order:
1. `TAVILY_API_KEY` → Tavily
2. `BRAVE_API_KEY` → Brave
3. `PERPLEXITY_API_KEY` → Perplexity
4. `XAI_API_KEY` → Grok

Set the key and it just works.

## See Also

- [Web Tools](/tools/web) — full `web_search` + `web_fetch` reference
- [Brave Search details](/tools/brave-search)
- [Perplexity Sonar details](/tools/perplexity)
