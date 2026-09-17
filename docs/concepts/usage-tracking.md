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
  energy, budgets, burn rate, daily spend stacked by model, cost per outcome, explain, cost
  coach flags), Models (sortable per-model table with cache read/write, cache hit %, pricing
  source, cost modes, what-if replay), Features (chat vs embeddings vs dreams vs extraction vs
  evolution, plus provider, agent and task), Sessions (from the ledger, so it sums to the
  Overview), and Live (streams every call as it happens over the `usage` gateway event).
- **Chat**: assistant replies carry a `⬆ in · ⬇ out · $cost` badge and the header shows the
  status strip.
- **CLI**: `bitterbot gateway usage [--days 30] [--by model|feature|provider|kind|agent|day] [--json]`.
  The older `bitterbot gateway usage-cost` (transcript scan, whole-node daily cost) still works.
- **Chat commands**: `/usage off|tokens|full` per-response footer, `/usage cost`, `/status`.
- **Doctor**: the "Usage & Cost (ledger)" section flags unpriced models, stale reconciles,
  estimated-only embeddings and budgets near or over their limit.
- **Gateway RPC**: `usage.ledger.summary` (optionally per `sessionKey`), `usage.ledger.events`,
  `usage.ledger.whatif`, `usage.ledger.explain` (read scope); events `usage` (one per row) and
  `usage.budget` (threshold crossings, shown as toasts in the Control UI).

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
`memory/discovery`, `tasks/judge`, `rlm/deep-recall`, `tts/summary`, `tts/synthesis`,
`media/image`, `media/audio`, `agent/compaction`, `tools/web-search`.

## Counting a new model call

- Non-streaming LLM calls: use `completeAttributed()` from `src/agents/complete-attributed.ts`
  with a `feature`; it records before surfacing provider errors.
- Embeddings: the `EmbeddingProvider` records itself; pass `{ feature }` as the second argument
  to `embedQuery` / `embedBatch` so the row is attributed.
- Anything else: `recordUsage()` from `src/infra/usage-ledger.ts`. It never throws.

## Cost intelligence

- **Cost per outcome** (Overview): spend on long-horizon tasks divided by the tasks that
  completed, per model and per feature, so a cheaper model with a lower resolve rate is
  visible for what it is.
- **What if** (Models tab, `bitterbot gateway usage --whatif provider/model`): the window's
  chat calls re-priced under another model's price table. Same tokens; a different model would
  also change output length, cache behaviour and quality.
- **Why does usage look like this** (Overview, `/usage why [today|7d|30d]` in chat,
  `bitterbot gateway usage --why`): the window against the one before it, with the features,
  models, sessions and days that moved the bill.
- **Spend as a hormone**: with budgets configured, the agent's prompt carries the budget
  pressure from 50% upward and it paces itself (shorter answers, fewer optional tool calls)
  before enforce mode pauses background lanes.
- **Cache-aware heartbeats**: a heartbeat due within the cache TTL fires right after a user
  turn, while the prompt cache is warm, instead of re-writing it minutes later.
- **Runaway runs**: runs costing five times the median in the window are flagged.
- **Energy**: a watt-hour and CO₂e estimate per window from published per-token figures, with
  the uncertainty band shown; an order of magnitude, not a meter reading.
- The chat header carries a status strip: context used of window, session cost, cache
  warm/cold, and the current 5-hour block; assistant replies show their cost once the ledger
  row streams in.

## Cache health, burn rate, cost modes

- The Overview's prompt-cache line shows hit rate, busts with their likely cause (cold start,
  TTL expired, prompt prefix changed, context grew, written but never read), warm/cold with
  the TTL in use, what the busts cost in re-written cache, and the cost of cache writes that
  were never read back (turns spaced past the TTL). Anthropic 1-hour cache writes (`cacheRetention: "long"`)
  are priced at 2x input.
- Burn rate: last hour, the rolling 5-hour window with cost per hour and projection, and the
  busiest previous 5-hour block as the bar's ceiling.
- Cost modes (Models tab): `reported` is what the model library returned with the call,
  `computed` is tokens times our price table, `both` shows the drift.
- Live pricing: a dated snapshot of OpenRouter's model list is refreshed daily under
  `<state>/model-pricing/` and used only for models the override, catalog and local tiers
  do not know, priced by the snapshot in force at the event time. Disable with
  `usage.pricing.liveRefresh: false`.
- OpenTelemetry: with an OTLP endpoint configured, every row is exported as the per-modality
  counters `gen_ai.client.inference.usage.{input_tokens,output_tokens,cache_read.input_tokens,cache_write.input_tokens,reasoning.output_tokens}`,
  the `gen_ai.client.token.usage` histogram, and `bitterbot.usage.cost` (USD).

## Known gaps

- Compaction summaries (automatic and manual) are counted as estimates
  (`agent/compaction`): the model library exposes no usage for them.
- `items` means different things per kind: characters for `tts`, one billable request for
  `audio` and `search`, and embedded texts for `embedding`. Text-to-speech characters are
  never summed into token totals.
- Speech-to-text providers that report no tokens (Whisper, Deepgram) and ElevenLabs speech
  are recorded per call or per character but stay unpriced.
- OpenAI service tiers (batch, flex, priority) are not distinguished for chat calls.

## Provider quota (separate from the ledger)

`usage.status` / `bitterbot status --usage` pull each provider's own plan-quota windows
(Anthropic, GitHub Copilot, Gemini CLI, Antigravity, OpenAI Codex, MiniMax, z.ai) when
matching OAuth or API credentials exist. Those are provider-reported percentages, not tokens.
