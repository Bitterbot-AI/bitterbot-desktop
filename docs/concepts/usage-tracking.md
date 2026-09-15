---
summary: "Usage ledger: every token, every model, every feature — and where it shows up"
read_when:
  - You want to know what the node spent on API tokens, per model or per feature
  - You are wiring a new model call and need it counted
  - You need to explain provider quota surfaces or budgets
title: "Usage Tracking"
---

# Usage tracking

## What it is

Bitterbot keeps a local **usage ledger**: one row per model call with the token split
(input, cache read, cache write, output, reasoning), the USD cost frozen at write time, the
price that was used and where it came from, and a `feature` that says what the tokens were
spent on. It covers chat turns, every hidden LLM lane (dreams, session fact extraction, skill
evolution, the task judge, deep recall, TTS summaries), embeddings (memory search, indexing,
recall, dream embeddings, the provider Batch APIs, the bundled local model) and vision calls.

- Store: `~/.bitterbot/usage-ledger.sqlite` (override `BITTERBOT_USAGE_LEDGER_DB`; disable
  with `BITTERBOT_USAGE_LEDGER=0` or `usage.ledger.enabled: false`).
- Retention: `usage.ledger.retentionDays` (default 365).
- History: on gateway start the ledger imports past session transcripts, and re-checks them
  every 10 minutes as a safety net. Live rows and imported rows never double count.
- Never estimates chat tokens: providers report them. Embedding counts are provider-reported
  where the API returns them (OpenAI, Voyage, newer Gemini) and estimated (marked ≈) otherwise.

## Where it shows up

- **Control UI → Usage** (Advanced group): Overview (cost, tokens, cache hit rate, embeddings,
  budgets, daily spend stacked by model, cost coach flags), Models (sortable per-model table
  with cache read/write, cache hit %, pricing source), Features (chat vs embeddings vs dreams vs
  extraction vs evolution, plus provider and agent), Sessions, and Live (streams every call as
  it happens over the `usage` gateway event).
- **Chat**: assistant replies carry a small `⬆ in · ⬇ out` token badge.
- **CLI**: `bitterbot gateway usage [--days 30] [--by model|feature|provider|kind|agent|day] [--json]`.
  The older `bitterbot gateway usage-cost` (transcript scan, whole-node daily cost) still works.
- **Chat commands**: `/usage off|tokens|full` per-response footer, `/usage cost`, `/status`.
- **Doctor**: the "Usage & Cost (ledger)" section flags unpriced models, stale reconciles,
  estimated-only embeddings and budgets near or over their limit.
- **Gateway RPC**: `usage.ledger.summary` and `usage.ledger.events` (read scope), events
  `usage` (one per row) and `usage.budget` (threshold crossings).

## Pricing

Resolution order per model: your override in `models.providers.<provider>.models[].cost`
(USD per 1M tokens: `input`, `output`, `cacheRead`, `cacheWrite`) → the built-in embedding
price table (embedding calls) → local providers (`ollama`, `vllm`, `local`, and
OpenAI-compatible endpoints on localhost/private hosts) at $0 → the vendored model catalog →
`unpriced`. Unpriced models show $0 with a red badge and a doctor warning rather than a made-up
number. Batch-API embeddings are priced at half rate. Provider-reported cost, when the model
library returns one, wins over the table.

Token buckets are stored _exclusively_ (a token is in exactly one of input / cache read /
cache write / output); `reasoning` is a subset of output kept for display. This matches the
Langfuse storage model and the OpenTelemetry GenAI convention where `cache_read.input_tokens`
and `reasoning.output_tokens` are subsets of the inclusive totals. Anthropic's `input_tokens`
already excludes cached tokens; OpenAI's `prompt_tokens` includes them and is split on ingest.

## Budgets

```json
{
  "usage": {
    "budgets": {
      "mode": "warn",
      "daily": { "usd": 5 },
      "monthly": { "usd": 100 },
      "perModel": { "anthropic/claude-opus-4-8": { "usd": 80 } },
      "perFeature": { "memory/dream": { "usd": 10 } }
    }
  }
}
```

Windows are UTC calendar periods (day, week from Monday, month). Alerts fire once per window
at 50 / 80 / 95 / 100% (log line, `usage.budget` event, Usage tab). `mode: "enforce"` pauses
background LLM lanes only (dream, extraction, skill evolution, marketability, discovery) while
a global budget or that lane's `perFeature` budget is exceeded; `perModel` budgets alert only.
Chat turns, the task judge, deep recall, TTS and embeddings are never blocked.

## Feature vocabulary

`agent/turn`, `agent/subagent`, `agent/cron`, `agent/heartbeat`, `agent/a2a`, `agent/acp`,
`agent/cli-backend`, `agent/continuity-gate`, `skills/evolution`, `memory/search`,
`memory/recall`, `memory/index`, `memory/index-batch`, `memory/dream`, `memory/extraction`,
`memory/probe`, `memory/planner`, `memory/architect`, `memory/marketability`,
`memory/discovery`, `tasks/judge`, `rlm/deep-recall`, `tts/summary`, `media/image`.

## Counting a new model call

- Non-streaming LLM calls: use `completeAttributed()` from `src/agents/complete-attributed.ts`
  with a `feature`; it records before surfacing provider errors.
- Embeddings: the `EmbeddingProvider` records itself; pass `{ feature }` as the second argument
  to `embedQuery` / `embedBatch` so the row is attributed.
- Anything else: `recordUsage()` from `src/infra/usage-ledger.ts`. It never throws.

## Known gaps

- Context compaction summaries run inside the model library without a usage callback and are
  not counted.
- Web search (Perplexity/xAI), speech-to-text and TTS audio synthesis (billed per character)
  are not counted.

## Provider quota (separate from the ledger)

`usage.status` / `bitterbot status --usage` pull each provider's own plan-quota windows
(Anthropic, GitHub Copilot, Gemini CLI, Antigravity, OpenAI Codex, MiniMax, z.ai) when
matching OAuth or API credentials exist. Those are provider-reported percentages, not tokens.
