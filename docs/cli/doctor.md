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
```

Notes:

- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.bitterbot/bitterbot.json.bak` and drops unknown config keys, listing each removal.

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
