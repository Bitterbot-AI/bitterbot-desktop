---
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: "Models CLI"
---

# Models CLI

See [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, and how that interacts with fallbacks.
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

## How model selection works

Bitterbot selects models in this order:

1. **Primary** model (`agents.defaults.model.primary` or `agents.defaults.model`).
2. **Fallbacks** in `agents.defaults.model.fallbacks` (in order).
3. **Provider auth failover** happens inside a provider before moving to the
   next model.

Related:

- `agents.defaults.models` is the allowlist/catalog of models Bitterbot can use (plus aliases).
- `agents.defaults.imageModel` is used **only when** the primary model can’t accept images.
- Per-agent defaults can override `agents.defaults.model` via `agents.list[].model` plus bindings (see [/concepts/multi-agent](/concepts/multi-agent)).

## Quick model picks (anecdotal)

- **GLM**: a bit better for coding/tool calling.
- **MiniMax**: better for writing and vibes.

## Setup wizard (recommended)

If you don’t want to hand-edit config, run the onboarding wizard:

```bash
bitterbot onboard
```

It can set up model + auth for common providers, including **OpenAI Code (Codex)
subscription** (OAuth) and **Anthropic** (API key recommended; `claude
setup-token` also supported).

## Config keys (overview)

- `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` and `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + aliases + provider params)
- `models.providers` (custom providers written into `models.json`)

Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize
to `zai/*`.

Provider configuration examples (including OpenCode Zen) live in
[/gateway/configuration](/gateway/configuration).

## “Model is not allowed” (and why replies stop)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for
session overrides. When a user selects a model that isn’t in that allowlist,
Bitterbot returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” The fix is to either:

- Add the model to `agents.defaults.models`, or
- Clear the allowlist (remove `agents.defaults.models`), or
- Pick a model from `/model list`.

Example allowlist config:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Switching models in chat (`/model`)

You can switch models for the current session without restarting:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notes:

- `/model` (and `/model list`) is a compact, numbered picker (model family + available providers).
- `/model <#>` selects from that picker.
- `/model status` is the detailed view (auth candidates and, when configured, provider endpoint `baseUrl` + `api` mode).
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
- If the model ID itself contains `/` (OpenRouter-style), you must include the provider prefix (example: `/model openrouter/moonshotai/kimi-k2`).
- If you omit the provider, Bitterbot treats the input as an alias or a model for the **default provider** (only works when there is no `/` in the model ID).

Full command behavior/config: [Slash commands](/tools/slash-commands).

The Control UI offers the same session-scoped switch as a model pill in the chat header (backed by `sessions.patch`), so no chat command or restart is needed.

## Key management over RPC (`models.auth.*`)

The gateway exposes a key-management surface so UIs can manage provider credentials without the CLI wizard (admin scope required):

- `models.auth.list` - per-provider status: auth profiles (with cooldown/disabled state), whether a provider env var is set, whether `models.providers.<id>.apiKey` is set in config, and which source currently wins under the runtime precedence chain (profile, then env, then config). Responses never contain secret material.
- `models.auth.test` - live-probe a credential against the provider's model-listing endpoint before saving. Pass `apiKey` to test a draft key without persisting anything, or omit it to test the stored credential. OAuth/aws-sdk credentials report `unsupported` instead of probing.
- `models.auth.set` - save or rotate a key (`provider`, optional `name`, optional `credentialType: api_key|token`, `value`). Writes through the auth-profiles helpers with input normalization, clears any cooldown/failure state the old key accumulated, and refreshes the model catalog cache so new providers appear in pickers immediately.
- `models.auth.delete` - remove a profile plus its usage stats, rotation-order entries, and last-good pointer.

Secrets are write-only across this surface: keys go in, only redacted status comes out. `models.list` additionally accepts `refresh: true` to bust the process-lifetime catalog cache after out-of-band provider changes, and `models.setDefault` sets `agents.defaults.model.primary` through the same validated path as `bitterbot models set` (restart-free).

The Control UI's **Models & Keys** panel (Settings group) is built on this surface: default-model picker, per-provider status with the winning source, test-before-save key entry, and profile deletion.

## CLI commands

```bash
bitterbot models list
bitterbot models status
bitterbot models set <provider/model>
bitterbot models set-image <provider/model>

bitterbot models aliases list
bitterbot models aliases add <alias> <provider/model>
bitterbot models aliases remove <alias>

bitterbot models fallbacks list
bitterbot models fallbacks add <provider/model>
bitterbot models fallbacks remove <provider/model>
bitterbot models fallbacks clear

bitterbot models image-fallbacks list
bitterbot models image-fallbacks add <provider/model>
bitterbot models image-fallbacks remove <provider/model>
bitterbot models image-fallbacks clear
```

`bitterbot models` (no subcommand) is a shortcut for `models status`.

### `models list`

Shows configured models by default. Useful flags:

- `--all`: full catalog
- `--local`: local providers only
- `--provider <name>`: filter by provider
- `--plain`: one model per line
- `--json`: machine‑readable output

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. It also surfaces OAuth expiry status for profiles found
in the auth store (warns within 24h by default). `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). If a configured
provider has no credentials, `models status` prints a **Missing auth** section.
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider).
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).

Preferred Anthropic auth is the Claude Code CLI setup-token (run anywhere; paste on the gateway host if needed):

```bash
claude setup-token
bitterbot models status
```

## Scanning (OpenRouter free models)

`bitterbot models scan` inspects OpenRouter’s **free model catalog** and can
optionally probe models for tool and image support.

Key flags:

- `--no-probe`: skip live probes (metadata only)
- `--min-params <b>`: minimum parameter size (billions)
- `--max-age-days <days>`: skip older models
- `--provider <name>`: provider prefix filter
- `--max-candidates <n>`: fallback list size
- `--set-default`: set `agents.defaults.model.primary` to the first selection
- `--set-image`: set `agents.defaults.imageModel.primary` to the first image selection

Probing requires an OpenRouter API key (from auth profiles or
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.

Scan results are ranked by:

1. Image support
2. Tool latency
3. Context size
4. Parameter count

Input

- OpenRouter `/models` list (filter `:free`)
- Requires OpenRouter API key from auth profiles or `OPENROUTER_API_KEY` (see [/environment](/help/environment))
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe controls: `--timeout`, `--concurrency`

When run in a TTY, you can select fallbacks interactively. In non‑interactive
mode, pass `--yes` to accept defaults.

## Models registry (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the
agent directory (default `~/.bitterbot/agents/<agentId>/models.json`). This file
is merged by default unless `models.mode` is set to `replace`.

## Live model discovery

The model picker's list starts from the vendored `@mariozechner/pi-ai` catalog,
which goes stale between releases: it can list retired snapshots the provider
now rejects (e.g. `claude-3-5-sonnet-20241022`, `claude-sonnet-4-20250514`) and
omit models shipped after the SDK was published (e.g. the Claude 5 family,
`claude-opus-4-8`). Picking a retired model surfaces as
`LLM request rejected: ... not_found_error`.

To keep the list honest, Bitterbot queries each provider's `/models` endpoint at
catalog-build time and replaces that provider's slice with what it actually
serves right now. Discovery covers providers reachable with a stored key plus a
simple GET:

- **anthropic-messages** family → `GET {baseUrl}/v1/models` (`x-api-key`)
- **openai-completions / openai-responses** → `GET {baseUrl}/models` (`Bearer`)
- **google-generative-ai** → `GET {baseUrl}/models?key=...`

Discovered IDs are the source of truth for _which_ models exist; capability
metadata (context window, image support, reasoning) is joined from the vendored
catalog, and synthesized from the provider's richest known model for IDs the SDK
has never seen. Providers without a listable endpoint (Bedrock via SigV4, Codex
/ Gemini-CLI / Antigravity via OAuth) keep their vendored/curated entries.

Discovery is **safe by construction**: any missing credential, non-200, timeout,
or parse failure falls back to the vendored list for that provider — a failed
probe never removes a working entry. It is skipped under tests.

```jsonc
// bitterbot.json — defaults shown; the whole block is optional
{
  "models": {
    "liveDiscovery": {
      "enabled": true, // set false to use the vendored/curated list only
      "timeoutMs": 6000, // per-provider probe timeout
    },
  },
}
```

The catalog is cached for the gateway process lifetime; `models.list` with
`refresh: true` (and any credential write) re-runs discovery.
