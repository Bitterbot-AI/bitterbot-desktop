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

- **Control UI → Usage** (main navigation, right after Overview; the Overview page also
  carries a spend card with today, the current 5-hour block, the 30-day total, cache state,
  the tightest budget and the loudest flag): Overview (cost, tokens, cache hit rate, embeddings,
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
  were never read back (turns spaced past the TTL). "Never read" is judged per model, feature
  and session class (the shared main session, other keyed sessions, unattributed rows), so
  chat turns that read the cache fine cannot hide a heartbeat lane that only writes it; the
  coaching tip names the TTL seen on that lane's rows.
- Cache TTL on rows: `cache_ttl` is the retention the request asked for (`cacheRetention`
  short = 5m, long = 1h on Anthropic), recorded on chat turns, hidden lanes and reconciled
  transcript rows alike. When the model library surfaces Anthropic's per-TTL
  `cache_creation` split (`usage.cacheWrite5m` / `usage.cacheWrite1h`, read defensively), the
  row stores it in `cache_write_5m` / `cache_write_1h`, the label is set from the split
  (`1h` when any 1h tokens were written, else `5m`), and only the 1h share is priced at the
  1h rate; without the split the configured label is the fallback, as before.
  Anthropic 1-hour cache writes are priced at 2x input: library-reported costs (which assume
  the 5-minute 1.25x rate) are rescaled on 1h rows and the price used is frozen on the row.
- Heartbeats are recognised by content, not by session key: the reconciler labels an
  assistant turn `agent/heartbeat` (channel `heartbeat`) when its user turn is the heartbeat
  prompt (default or `agents.defaults.heartbeat.prompt`, per-agent overrides included) or the
  reply is only `HEARTBEAT_OK`. A one-time `relabel:v3` pass (keyed per agent in `usage_meta`)
  re-walks existing transcripts on the first reconcile after upgrade and fixes rows imported
  as chat turns; where a transcript is gone it falls back to the heartbeat signature (reply
  of 20 tokens or fewer, no cache read, no session key). Live rows are never touched.
- The reconciler leaves transcript lines younger than two minutes for the next pass so the
  live hook's row (with its run, session and cache observation) lands first; if a reconcile
  row still slips in first, the live row adopts it on the dedupe conflict.
- `bitterbot doctor` (Usage & Cost section) adds three idle-spend lines: unread prompt-cache
  writes in the last 7 days per lane (warn at $1/day, fail at $5/day), heartbeat cost and
  cost of pass (dollars per delivered heartbeat message, or "no deliveries"; warn at $1/day
  with none delivered), and the idle-day floor: the cheapest of the last 14 whole days with
  zero real chat turns (a real turn answers with more than 20 tokens or reads its cache),
  naming the lane that set it (warn at $1/day). Three more lines come from the tool and
  prefix telemetry below: the hot-set proof, spilled tool results, and prefix stability.
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

## Tool telemetry (hot-set proof)

The agent sees a hot set of tool schemas in chat (`tools.hotSet`) and reaches the rest
through `list_tools` / `use_tool` or, once the model library parses `tool_reference`
blocks, through Anthropic's native tool search. Whether the hot set is the right one is an
empirical question, so every tool call lands in a `tool_calls` table in the same ledger
database (`usage:v3`; created on open):

| column                                           | meaning                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`, `day`, `agent_id`, `session_key`, `run_id` | when and where                                                                                                                                                                |
| `tool`                                           | the tool actually reached; for `use_tool` the dispatched target (`input.name`)                                                                                                |
| `via`                                            | `direct` (hot set), `use_tool`, `native-search` (a `server_tool_use` block named `tool_search_tool_*`; one row per `tool_reference` it surfaced), `list_tools`                |
| `ok`, `error_class`                              | body-level outcome (the same classifier the journal uses); coarse class: `timeout`, `denied`, `not-found`, `invalid-args`, `rate-limit`, `network`, `error`                   |
| `duration_ms`                                    | start to end of the tool execution                                                                                                                                            |
| `result_chars`, `spilled`                        | size of the result; when it overflowed `tools.resultMaxChars` to a file, `spilled` is 1 and `result_chars` is the original length from the `[truncated: N chars total` marker |

Rows are captured from the agent event stream in `pi-embedded-subscribe.ts`
(`createToolCallTelemetry` in `pi-embedded-subscribe.tools.ts`), written through the same
fire-and-forget queue as usage rows, and pruned with the same retention.

Where it shows up:

- `bitterbot doctor` (7d): `hot-set: N direct calls, M via use_tool (K failed), J via native
search in 7d; top deferred tools reached indirectly: ...`, warning with a tip to add a tool
  to `tools.hotSet` when it is reached indirectly 5 or more times a week
  (`HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK`; scaled to the window), and `tool results
spilled: N in 7d, avg X chars` (info).
- `bitterbot gateway usage --tools [--days N] [--json]`: the same lines plus failures by
  class and the prefix-stability report below. It reads the ledger file directly, so it works
  without a running gateway.

## Prefix stability

Nobody else records this: every chat row stores two digests of the request it answered,
`prefix_digest` (SHA-256 of the stable system block above `<!-- BITTERBOT_CACHE_BOUNDARY -->`)
and `tools_digest` (SHA-256 of the sorted tool names). They are computed on every request by
the stream wrapper in `cache-trace.ts`, which now always wraps the stream: with
`BITTERBOT_CACHE_TRACE` off it is digest-only (no file, no per-message fingerprints), with it
on the full JSONL trace is written as before. A digest that moves between two turns less
than 60 minutes apart is a cache bust the operator can fix.

- `bitterbot doctor` (7d): `prefix stability: N sessions in 7d where the cached prefix
changed mid-session (turns < 60 min apart): <session, turn count, likely tier: tools|system>`,
  warn when N > 0, with the tip "a prompt section above the cache boundary is changing between
  turns; run with BITTERBOT_CACHE_TRACE=1 to see which". Rows without digests (older
  releases, reconciled transcripts) never count as changes.

## Batch rows

Latency-tolerant hidden lanes (`memory/dream`, `memory/extraction`, `memory/discovery`,
`skills/evolution` judge and maintainer) go through the Anthropic Message Batches API by
default (`memory.batch.enabled`, `memory.batch.lanes`, `memory.batch.maxWaitMinutes` = 20;
see the dream engine docs). A batched call is recorded with `batch = 1`, priced at the 50%
batch discount from the price table (the library reports no cost for batch results), with
cache read/write tokens and the per-TTL split as the API reported them. A call that fell back
to the live path (timeout, error, non-Anthropic model, OAuth token, images in the prompt)
is recorded as an ordinary row. The what-if replay keeps the batch flag, so re-pricing a
window under another model preserves the discount.

## Known gaps

- Compaction summaries (automatic and manual) are counted as estimates
  (`agent/compaction`): the model library exposes no usage for them.
- `items` means different things per kind: characters for `tts`, one billable request for
  `audio` and `search`, and embedded texts for `embedding`. Text-to-speech characters are
  never summed into token totals.
- Speech-to-text providers that report no tokens (Whisper, Deepgram) and ElevenLabs speech
  are recorded per call or per character but stay unpriced.
- OpenAI service tiers (batch, flex, priority) are not distinguished for chat calls.
- Rows recorded before 2026-09-19 by hidden lanes and the reconciler carry no `cache_ttl`;
  their cost is the library's 5-minute figure, which is what was charged at the time.

## Provider quota (separate from the ledger)

`usage.status` / `bitterbot status --usage` pull each provider's own plan-quota windows
(Anthropic, GitHub Copilot, Gemini CLI, Antigravity, OpenAI Codex, MiniMax, z.ai) when
matching OAuth or API credentials exist. Those are provider-reported percentages, not tokens.
