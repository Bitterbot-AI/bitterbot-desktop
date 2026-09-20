---
summary: "Use Anthropic Claude via API keys or setup-token in Bitterbot"
read_when:
  - You want to use Anthropic models in Bitterbot
  - You want setup-token instead of API keys
  - You need to flip the in-tree runtime back to the vendored provider, or tune tool search / runtime-state placement
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic builds the **Claude** model family and provides access via an API.
In Bitterbot you can authenticate with an API key or a **setup-token**.

## Option A: Anthropic API key

**Best for:** standard API access and usage-based billing.
Create your API key in the Anthropic Console.

### CLI setup

```bash
bitterbot onboard
# choose: Anthropic API key

# or non-interactive
bitterbot onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Runtime: in-tree provider vs vendored pi-ai

Since 2026-09-20 Anthropic Messages requests are built and parsed by an
in-tree provider (`src/agents/providers/anthropic/`) instead of the vendored
`@mariozechner/pi-ai` 0.52.12 one. It is feature-complete with the vendored
provider for everything Bitterbot used (API key, setup-token/OAuth and
Copilot auth branches with the same headers and beta flags, thinking,
interleaved thinking, fine-grained tool streaming, tool use, error mapping)
and adds what pi-ai could not parse:

| Feature                     | Config key (`agents.defaults.anthropic`)                           | Default    |
| --------------------------- | ------------------------------------------------------------------ | ---------- |
| runtime kill switch         | `runtime: "native" \| "vendored"`                                  | `native`   |
| native tool search          | `toolSearch: { enabled, variant: "bm25" \| "regex" }`              | on, `bm25` |
| `<runtime-state>` placement | `runtimeStatePlacement: "auto" \| "user-tail" \| "system-message"` | `auto`     |

```json5
{
  agents: {
    defaults: {
      anthropic: {
        runtime: "native", // "vendored" = pi-ai's provider, byte-identical requests
        toolSearch: { enabled: true, variant: "bm25" },
        runtimeStatePlacement: "auto",
      },
    },
  },
}
```

`runtime: "vendored"` restores the previous chain exactly: pi-ai builds the
request, the `onPayload` cache-layout wrapper reshapes it, tool exposure goes
back to the `list_tools`/`use_tool` dispatcher. Use it if a live run
misbehaves; nothing else changes.

Two deliberate differences from the vendored provider in `native` mode:

- **Adaptive thinking on every 4.6+ model.** Vendored pi-ai only treated Opus
  4.6 as adaptive and sent `budget_tokens` to Opus 4.7/4.8/5, Sonnet 4.6+ and
  Fable, which those models reject with a 400. Native sends
  `thinking: { type: "adaptive" }` plus `output_config.effort` for all of
  them; Haiku 4.5 and older keep budget-based thinking.
- **Usage carries the cache-write TTL split.** `usage.cacheWrite` is still the
  total; `usage.cacheWrite5m` and `usage.cacheWrite1h` are set from
  `usage.cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens` when the response includes them (undefined
  otherwise, so a proxy that omits the field reads as unknown, not zero).

### Native tool search

With `toolSearch.enabled` (API-key auth against `api.anthropic.com` on a model
that supports it: Opus 4.5+, Sonnet 4.5+, Haiku 4.5, Fable, Mythos) every
registered tool is sent on every request: the lane's hot set as normal
definitions, every other tool with `defer_loading: true`, plus the server-side
search tool (`tool_search_tool_bm25_20251119` as `tool_search_tool_bm25`, or
the regex variant). Deferred definitions are excluded from the rendered prefix
by the API, so the tools cache entry only covers the loaded ones. When Claude
searches, the response carries a `server_tool_use` block and a
`tool_search_tool_result` with `tool_reference` entries; the API expands them
into full definitions and the model then calls the discovered tool as an
ordinary `tool_use`. Bitterbot keeps both blocks on the assistant message
(`serverToolUse` / `toolSearchResult`) and replays them verbatim on later
turns, so discovered tools stay usable for the rest of the session without
re-searching and without touching the tools prefix. `list_tools`/`use_tool`
are not exposed in this mode; see [Hot set](/tools/hot-set).

Guards: the search tool is never deferred, at least one tool is always loaded
(an empty hot set loads everything), a deferred tool never carries
`cache_control`, and a `tool_reference` to a tool that is no longer registered
is dropped before the request goes out (the API would otherwise return 400).
A tool the model already called whose search result has left the transcript
is sent non-deferred once so its schema is visible again. Setup-token (OAuth)
auth and non-Anthropic base URLs keep the dispatcher.

### Runtime-state placement

`auto` sends the volatile `<runtime-state>` half of the prompt as a
`{ role: "system" }` message appended after the last user message on Opus
4.8, Opus 5, Fable and Mythos (the models that accept mid-conversation
system messages) and as an unmarked user-message tail everywhere else (Haiku,
Sonnet, older Opus). A 400 `role 'system' is not supported` falls back to the
user tail for that request and for the rest of the process for that model.
`user-tail` forces the previous layout; `system-message` forces the system
message (same 400 fallback).

## Prompt caching (Anthropic API)

Bitterbot supports Anthropic's prompt caching feature. This is **API-only**; subscription auth does not honor cache settings.

### Configuration

Use the `cacheRetention` parameter in your model config:

| Value   | Cache Duration | Description                         |
| ------- | -------------- | ----------------------------------- |
| `none`  | No caching     | Disable prompt caching              |
| `short` | 5 minutes      | Default for API Key auth            |
| `long`  | 1 hour         | Extended cache (requires beta flag) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Defaults

When using Anthropic API Key authentication, Bitterbot automatically applies `cacheRetention: "short"` (5-minute cache) for all Anthropic models. You can override this by explicitly setting `cacheRetention` in your config.

### Legacy parameter

The older `cacheControlTtl` parameter is still supported for backwards compatibility:

- `"5m"` maps to `short`
- `"1h"` maps to `long`

We recommend migrating to the new `cacheRetention` parameter.

Bitterbot includes the `extended-cache-ttl-2025-04-11` beta flag for Anthropic API
requests; keep it if you override provider headers (see [/gateway/configuration](/gateway/configuration)).

### Marker layout (what Bitterbot sends)

Anthropic caches a prefix over `tools -> system -> messages`, tiered: a change in
`system` leaves the `tools` cache entry intact, and at most four `cache_control`
markers are allowed per request. The request builder places two markers the
way pi-ai does (the system block and the last user message); the layout in
`src/agents/pi-embedded-runner/anthropic-payload-cache.ts` then reshapes the
body. The native runtime calls that layout function directly; the vendored
runtime applies it through pi-ai's `onPayload` hook. Either way the wire shape is:

| Position          | Content                                                                                                                                                                                               | Marker                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tools`           | tool definitions **sorted by name** (byte order); deferred ones carry `defer_loading: true`                                                                                                           | on the **last non-deferred** definition, same TTL as the system marker |
| `system[0]`       | stable half of the prompt (above `<!-- BITTERBOT_CACHE_BOUNDARY -->`)                                                                                                                                 | `ephemeral`, `ttl: "1h"` when `cacheRetention: "long"`                 |
| last user message | conversation so far                                                                                                                                                                                   | pi-ai's marker (unchanged)                                             |
| runtime state     | volatile half (hormones, runtime line, scratch notes) as an unmarked `<runtime-state>` block **after** the marked block: a `role: "system"` message on Opus 4.8+/Fable, a user-message tail elsewhere | **none** (plain input; the history prefix stays cached)                |

With subscription (OAuth) auth pi-ai adds a Claude Code identity block in front;
it keeps its marker and the total stays at four. If the system prompt carries
no boundary marker (custom prompt), only the tool sort and the tool marker are
applied. See [System Prompt](/concepts/system-prompt) for what sits on each side
of the boundary.

**1h retention only pays once the stable digest is constant across turns.** A 1h
write costs 2x input (5m: 1.25x); it is strictly worse than 5m on a prefix that
changes every call. Before switching to `long`, enable the cache trace
(`BITTERBOT_CACHE_TRACE=1`, JSONL at `<state>/logs/cache-trace.jsonl`) and check
that `stableDigest` and `toolsDigest` on consecutive `stream:context` events are
identical while `stream:usage` shows `cacheRead` growing. Only then does a longer
TTL turn idle gaps of 5 to 60 minutes into cache reads instead of rewrites.

## Option B: Claude setup-token

**Best for:** using your Claude subscription.

### Where to get a setup-token

Setup-tokens are created by the **Claude Code CLI**, not the Anthropic Console. You can run this on **any machine**:

```bash
claude setup-token
```

Paste the token into Bitterbot (wizard: **Anthropic token (paste setup-token)**), or run it on the gateway host:

```bash
bitterbot models auth setup-token --provider anthropic
```

If you generated the token on a different machine, paste it:

```bash
bitterbot models auth paste-token --provider anthropic
```

### CLI setup (setup-token)

```bash
# Paste a setup-token during onboarding
bitterbot onboard --auth-choice setup-token
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- Generate the setup-token with `claude setup-token` and paste it, or run `bitterbot models auth setup-token` on the gateway host.
- If you see “OAuth token refresh failed …” on a Claude subscription, re-auth with a setup-token. See [/gateway/troubleshooting](/gateway/troubleshooting).
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).

## Troubleshooting

**401 errors / token suddenly invalid**

- Claude subscription auth can expire or be revoked. Re-run `claude setup-token`
  and paste it into the **gateway host**.
- If the Claude CLI login lives on a different machine, use
  `bitterbot models auth paste-token --provider anthropic` on the gateway host.

**No API key found for provider "anthropic"**

- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- Re-run onboarding for that agent, or paste a setup-token / API key on the
  gateway host, then verify with `bitterbot models status`.

**No credentials found for profile `anthropic:default`**

- Run `bitterbot models status` to see which auth profile is active.
- Re-run onboarding, or paste a setup-token / API key for that profile.

**No available auth profile (all in cooldown/unavailable)**

- Check `bitterbot models status --json` for `auth.unusableProfiles`.
- Add another Anthropic profile or wait for cooldown.

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).

### Deferred tools and the cache

A deferred tool never changes the tools array once a session has started: the
API accepts a direct `tool_use` of a deferred tool by name (verified live on
2026-09-20: a never-called deferred tool ran mid-session with 134 cache-write
tokens instead of a ~20k prefix rewrite). Only a real 400 that names a deferred
tool triggers the on-demand rescue, which un-defers that tool for the model for
the rest of the process and is logged as a warning. The debug line
`request: tools=N deferred=M search=...` shows the plan per request, and
`tool search: model issued ...` shows when the model actually searched.
