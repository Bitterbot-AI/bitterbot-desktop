---
summary: "Web search provider setup: Tavily, Brave, Perplexity, Grok, Serply, Parallel"
read_when:
  - You want to configure a web search provider
  - You need API keys for Tavily, Brave, Perplexity, Grok, or Serply
title: "Web Search Providers"
---

# Web Search Providers

Bitterbot supports 6 web search providers for the `web_search` tool. Pick one and configure its API key, or explicitly select Parallel for free, keyless search.

| Provider       | Env Variable         | Free Tier       | Best For                              |
| -------------- | -------------------- | --------------- | ------------------------------------- |
| **Tavily**     | `TAVILY_API_KEY`     | 1,000 req/month | Structured results, AI-optimized      |
| **Brave**      | `BRAVE_API_KEY`      | 2,000 req/month | Privacy-focused, fast                 |
| **Perplexity** | `PERPLEXITY_API_KEY` | Pay-per-use     | AI-synthesized answers with citations |
| **Parallel**   | None                 | Free, keyless   | Web search with source excerpts       |
| **Grok**       | `XAI_API_KEY`        | Varies          | X/Twitter integration                 |
| **Serply**     | `SERPLY_API_KEY`     | Trial credits   | Google results, country and freshness |

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

# Option 5: Serply (also set provider: "serply", see below)
export SERPLY_API_KEY="..."
```

Or add to your `.env` file in the Bitterbot root / gateway environment.

## Config File Setup

You can also configure the provider in `~/.bitterbot/bitterbot.json`:

### Parallel Search MCP (keyless, opt-in)

Select **Parallel Search MCP** during advanced onboarding or
`bitterbot configure --section web`, or add:

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "parallel",
        maxResults: 5,
      },
    },
  },
}
```

The native `web_search` tool and configured non-tool search callers connect to
`https://search.parallel.ai/mcp` using Streamable HTTP. No API key, signup,
or separate MCP configuration is needed. See [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
Results include titles, URLs and source excerpts. `maxResults`, `timeoutSeconds`
and `cacheTtlMinutes` apply. Region, language and `freshness` filters are rejected;
include preferences in the query instead. The provider uses anonymous free-tier
limits and reports service errors without switching providers. Parallel is never
selected automatically; existing defaults and saved settings continue to apply.

### Tavily

```json5
{
  tools: {
    web: {
      search: {
        provider: "tavily",
        tavily: {
          apiKey: "tvly-...",
          searchDepth: "basic", // or "advanced" for deeper results
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
          model: "perplexity/sonar-pro", // or sonar, sonar-reasoning-pro
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

### Serply

```json5
{
  tools: {
    web: {
      search: {
        provider: "serply",
        maxResults: 5,
        serply: {
          apiKey: "...", // or set SERPLY_API_KEY
        },
      },
    },
  },
}
```

Returns Google web results (titles, URLs and snippets) from
`https://api.serply.io/v1/search`, with the key sent in an `X-Api-Key` header.
`country` maps to Google's region (`gl`) and `freshness` accepts `pd`, `pw`, `pm`
and `py`. Date ranges, `search_lang` and `ui_lang` are rejected; put language
preferences in the query instead. Serply is never selected automatically.
Get a key at [serply.io](https://serply.io) ([API docs](https://serply.io/docs));
new accounts get 2,500 free credits for 30 days.

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
