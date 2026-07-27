---
summary: "CLI reference for `bitterbot doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
---

# `bitterbot doctor`

Health checks + quick fixes for the gateway and channels.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Examples

```bash
bitterbot doctor
bitterbot doctor --repair
bitterbot doctor --deep
bitterbot doctor --json
```

Notes:

- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.bitterbot/bitterbot.json.bak` and drops unknown config keys, listing each removal.

## Exit code and the update gate

Doctor exits **non-zero when any check reports an error-level finding**.
Severity is the gate: `error` means "this node is broken enough that an
update must not hand off to it" (corrupt memory DB, missing core tables, a
provider actively rejecting well-formed model calls, invalid config,
unsupported Node). Degraded-but-usable states (missing credentials, an
unreachable relay, an embedding backlog) stay warnings and never fail the
process.

The update flow (`bitterbot update` and the `update.run` gateway RPC) runs
`bitterbot doctor --non-interactive` after building and only restarts into
the new build when doctor exits 0 — a failing doctor keeps the old process
running.

## `--json`

`bitterbot doctor --json` (implies `--non-interactive`) emits a
machine-readable report as the **last line of stdout**:

```json
{
  "schema": 1,
  "version": "…",
  "worstLevel": "warn",
  "hasError": false,
  "blocksUpdate": false,
  "errors": [],
  "findings": [{ "section": "Runtime", "level": "ok", "message": "Node v22…" }],
  "checkedAt": 1750000000000
}
```

Sections on the shared check contract suppress their human output in JSON
mode; a few legacy sections still print prose first, so consumers should
parse the final stdout line rather than the whole stream. `worstLevel` is
the max severity across all findings; `hasError`/`blocksUpdate` are true
exactly when `worstLevel` is `"error"`.

## Boot-health beacon

Both update paths (CLI and gateway RPC) arm a beacon file before restarting
into a freshly-updated build; the gateway clears it the moment it binds. If
a post-update boot never confirms healthy, the next `bitterbot doctor` run
reports an error-level **Update Health** finding with the exact rollback
command (`git reset --hard <previous-sha> && pnpm build && pnpm start gateway`)
— and, being error-level, blocks further updates until resolved.

## Model round-trip

Doctor performs **one real end-to-end model call** ("Reply with the single
word: OK") through the same clean call path production uses. "Configured"
is not "works": a provider that actively rejects a well-formed request (the
400-param class) is an error-level finding that blocks updates, while
missing credentials, an unresolvable model ref, network failures, and 5xx
responses only warn.

## Subsystem checks

Doctor opens the agent memory DB read-only and verifies live state:
embedding backlog per perspective, **search-index coverage** (crystals with
embeddings vs rows actually present in `chunks_vec`/`chunks_fts` — a
populated embedding column with an empty index means search finds nothing),
knowledge-graph population, canonical facts ledger, and Circles tables on
the resolved agent DB.

## Agent runtime section

Doctor includes an "Agent runtime" section that surfaces:

- **Considerations log** — today's `~/.bitterbot/heartbeat/considerations-YYYY-MM-DD.ndjson` row count, total bytes, top decisions, and top categories. File-based, available even when the gateway is offline.
- **Prompt cache hit ratios** — per-session lifetime + recent hit ratios and bust counts, ordered by turn count. Live state via the `agent.runtime.health` RPC; needs the gateway running.
- **Compaction breaker state** — any session whose breaker is not `closed`, with consecutive-failure count and last reason. Same RPC.

When the gateway is unreachable, doctor falls back quietly with a note
that the live block is unavailable. The considerations log section
still shows.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv BITTERBOT_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent “unauthorized” errors.

```bash
launchctl getenv BITTERBOT_GATEWAY_TOKEN
launchctl getenv BITTERBOT_GATEWAY_PASSWORD

launchctl unsetenv BITTERBOT_GATEWAY_TOKEN
launchctl unsetenv BITTERBOT_GATEWAY_PASSWORD
```
