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

## Boot-health beacon and auto-rollback

Both update paths (CLI and gateway RPC) arm a beacon file before restarting
into a freshly-updated build; the gateway clears it the moment it binds. If
a post-update boot never confirms healthy, the next `bitterbot doctor` run
reports an error-level **Update Health** finding with the exact rollback
command (`git reset --hard <previous-sha> && pnpm build && pnpm start gateway`)
— and, being error-level, blocks further updates until resolved.

On git installs the update flow also spawns a detached **boot watchdog**
that acts on the same beacon: if the fresh build never confirms a healthy
boot before the beacon deadline (default 30 min), the watchdog performs
**one** guarded rollback — clean worktree only, `git reset --hard` to the
pre-update sha, reinstall, rebuild, best-effort restart. Config and
databases are never touched (schema migrations follow an N-1 compatibility
policy, so pre-update code runs against the migrated DB). A once-only latch
guarantees a rollback that itself fails to boot goes loud instead of
looping. A performed rollback shows as a persistent warn-level **Update
Health** finding until the next clean update; a failed rollback attempt is
error-level with the manual recovery command, and clears automatically the
next time a gateway boots healthy (so recovering the node also unblocks the
update gate). State lives in `<stateDir>/rollback-performed.json`; the
watchdog logs to `<stateDir>/boot-watchdog.log`. Disable with
`update.autoRollback.enabled: false`. On systemd nodes the unit needs
`KillMode=process` (current default; doctor's supervisor audit flags and
repairs older units) or the watchdog is killed with the restarting gateway.

## Model round-trip

Doctor performs **one real end-to-end model call** ("Reply with the single
word: OK") through the same clean call path production uses. "Configured"
is not "works": a provider that actively rejects a well-formed request (the
400-param class) is an error-level finding that blocks updates, while
missing credentials, an unresolvable model ref, network failures, and 5xx
responses only warn.

## Agent-turn probe

With the gateway running, doctor also sends **one real agent turn** through
the full production pipeline (RPC ingress → session resolution → embedded
runner → reply) on a throwaway `doctor-probe-*` session that is deleted
afterward (orphans from interrupted runs are swept on the next doctor).
A gateway that answers health checks but cannot run a turn is caught here
and nowhere else. Failures are **warn-level during burn-in** — the probe has
more moving parts than the model check, so it does not block updates. The
pre-restart update gate skips it (the running gateway is still the outgoing
build); the post-restart doctor after `bitterbot update` forces it, so the
freshly installed build gets a real turn through its pipeline.

## Subsystem checks

Doctor opens the agent memory DB read-only and verifies live state:
embedding backlog per perspective, **search-index coverage** (crystals with
embeddings vs rows actually present in `chunks_vec`/`chunks_fts` — a
populated embedding column with an empty index means search finds nothing),
knowledge-graph population, canonical facts ledger, and Circles tables on
the resolved agent DB.

## Retrieval health

The wired-but-dead detector, finally consumed: with the gateway running,
doctor asks the live `memory.retrievalHealth` detector and warns on any
dead retrieval lane (a layer contributing nothing to recall). It also runs
an offline sweep of recent `retrieval_trace` samples — a lane with zero
hits across 20+ sampled retrievals in the last week warns even when the
gateway is down.

## Economy

The money-moving surfaces: bounty settlements parked at `held_review`
(money that does not move until a human reviews it), revenue payments past
their dispute window or failed during payout, the A2A x402 payment gate
(warns when the gate is armed with nowhere to receive payment, or when a
public A2A URL has authentication `none`), and Forage Night Shift posture.

## Long-horizon tasks

The task spine's three stores, which doctor previously never opened:
in-flight tasks in `tasks.sqlite` not seen for >24h **and** holding no
pending cron wakeup (a stale task with a scheduled wakeup is suspended by
design, not orphaned), event-journal growth, and the cron store (enabled
jobs more than 2h past `nextRunAt` while the gateway is running and cron is
not deliberately disabled mean the scheduler is wedged and suspended tasks
are dead; repeated per-job failures are flagged).

## Dream-mode liveness

The Dream Engine section also reports per-mode liveness: an enabled dream
mode (e.g. `harness_evolve`, `relationship_mining`) that has never been
selected across 40+ completed cycles is wired-but-never-scheduled, and its
maintenance work is not happening.

## Artifact liveness

Born from the 2026-08-09 wired-but-dead audit: loops that run on schedule,
throw nothing, and never produce their output artifact. The section asserts
on the artifacts directly, so a silent regression announces itself:
skill crystals born without a `skill_category` (invisible to
`skills.metrics`), an interceptor guard chain that has never written an
intervention record despite tool traffic, peers who have offered many skills
with no accept/reject decision ever recorded (nobody can graduate out of
manual review), curiosity targets that only expire and never resolve,
curiosity progress rows keyed to region ids that no longer exist (region
identity churn resets learning forever), doubled execution telemetry (the
`after_tool_call` double-fire), skills past the publish maturity gate that
were never published, and dream modes selected repeatedly that have never
produced a single insight. All findings are warn/info — a dead loop is
operator-attention state, never an update blocker.

Memory-search (including the sqlite-vec probe) and Security sections are on
the shared contract, so their findings appear in `--json` like everything
else. Deliberate lockdown states (DMs disabled/locked) report as info, not
warnings.

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
