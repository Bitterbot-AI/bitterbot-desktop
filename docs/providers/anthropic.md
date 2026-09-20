---
summary: "Use Anthropic Claude via API keys or setup-token in Bitterbot"
read_when:
  - You want to use Anthropic models in Bitterbot
  - You want setup-token instead of API keys
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
markers are allowed per request. Vendored pi-ai places two (the system block and
the last user message). Bitterbot reshapes the payload before it leaves the
process (`onPayload` hook, `src/agents/pi-embedded-runner/anthropic-payload-cache.ts`):

| Position          | Content                                                                                                                 | Marker                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `tools`           | tool definitions **sorted by name** (byte order)                                                                        | on the **last** definition, same TTL as the system marker |
| `system[0]`       | stable half of the prompt (above `<!-- BITTERBOT_CACHE_BOUNDARY -->`)                                                   | `ephemeral`, `ttl: "1h"` when `cacheRetention: "long"`    |
| last user message | conversation so far                                                                                                     | pi-ai's marker (unchanged)                                |
| user-message tail | volatile half (hormones, runtime line, scratch notes) as an unmarked `<runtime-state>` block **after** the marked block | **none** (plain input; the history prefix stays cached)   |

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
