---
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
---

# Gateway troubleshooting

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## Command ladder

Run these first, in this order:

```bash
bitterbot status
bitterbot gateway status
bitterbot logs --follow
bitterbot doctor
bitterbot channels status --probe
```

Expected healthy signals:

- `bitterbot gateway status` shows `Runtime: running` and `RPC probe: ok`.
- `bitterbot doctor` reports no blocking config/service issues.
- `bitterbot channels status --probe` shows connected/ready channels.

## No replies

If channels are up but nothing answers, check routing and policy before reconnecting anything.

```bash
bitterbot status
bitterbot channels status --probe
bitterbot pairing list <channel>
bitterbot config get channels
bitterbot logs --follow
```

Look for:

- Pairing pending for DM senders.
- Group mention gating (`requireMention`, `mentionPatterns`).
- Channel/group allowlist mismatches.

Common signatures:

- `drop guild message (mention required` → group message ignored until mention.
- `pairing request` → sender needs approval.
- `blocked` / `allowlist` → sender/channel was filtered by policy.

Related:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard control ui connectivity

When dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.

```bash
bitterbot gateway status
bitterbot status
bitterbot logs --follow
bitterbot doctor
bitterbot gateway status --json
```

Look for:

- Correct probe URL and dashboard URL.
- Auth mode/token mismatch between client and gateway.
- HTTP usage where device identity is required.

Common signatures:

- `device identity required` → non-secure context or missing device auth.
- `device token mismatch` → stale device pairing token. Fix: delete
  `~/.bitterbot/identity/device-auth.json` and `~/.bitterbot/devices/paired.json`,
  then restart the gateway to trigger re-pairing.
- `unauthorized` / reconnect loop → token/password mismatch.
- `gateway connect failed:` → wrong host/port/url target.

### Periodic disconnects (the UI drops every few minutes, code 1006)

A connection that authenticates fine but then drops at a roughly periodic
interval (logged as `code=1006` abnormal closes, each followed by a fresh
`conn=` id) is almost never an auth or network problem. The client closes the
socket itself with `tick timeout` when the gateway stops sending its keepalive
`tick` for longer than twice the tick interval (default `2 x 30s = 60s`).

The keepalive stalls when the gateway's single Node event loop is blocked by a
long synchronous burst. Two sources have caused this:

1. **Memory maintenance.** The memory subsystem runs in-process; the heaviest
   work is the ~30-minute maintenance cycle (consolidation similarity sweeps,
   curiosity region rebuild) and large file-index passes. These loops yield to
   the event loop cooperatively (see `src/memory/event-loop.ts`).
2. **The dream engine (recall-triggered).** A user recall stimulates the
   hormonal state; a dopamine spike fires an emotional mini-dream
   (`runMiniDream` -> `run({modes:["replay"]})`). Replay applied its per-seed
   importance boosts as one implicit transaction PER ROW; on a large/contended
   memory DB (observed at ~950MB with a ~60MB WAL) each commit stalled on the
   write lock, turning ~20 single-row UPDATEs into a ~90s synchronous loop block
   (2026-06-24). Fixed by batching all seed writes into ONE explicit transaction
   and yielding between dream modes (`src/memory/dream-engine.ts`). If recall
   stalls return, check DB/WAL bloat first (`~/.bitterbot/memory/main.sqlite*`) —
   a `pnpm build` restart or a WAL checkpoint shrinks an oversized WAL.
3. **Interactive RPC handlers.** Some Control-UI-polled RPCs did heavy work on
   the loop with no yielding or caching, and would block it for tens of seconds:
   - `workspace.tree` did a per-file `fs.stat` for sizes. On slow filesystems
     (notably WSL2 `/mnt` drvfs paths, where every syscall crosses the
     Linux↔Windows boundary) a few thousand entries blocked the loop for >60s.
     Sizes are now **off by default** (opt in with `includeSizes: true`) and the
     walk yields every 64 entries.
   - `skills.network` / `skills.networkHistory` run synchronous `node:sqlite`
     aggregation (and `skills.network` also fans out over IPC/HTTP). They are now
     served from short-TTL caches (5s / 10s), so the UI's polling and
     reconnect-driven refetches can no longer re-pay the cost back-to-back. The
     cache also **coalesces concurrent misses** (`TtlCache.getOrCompute`): a
     reconnect fires a burst of identical polls in the same tick, and before this
     each one missed the not-yet-populated cache and independently re-paid the
     IPC fan-out, piling onto the loop at once (the "N requests all resolve at
     the same wall-clock instant with near-identical durations" signature). Now
     the first miss runs the work and the rest await that one in-flight result.
   - `skills.network`'s `getStats()` IPC now uses a 2.5s timeout (not the 10s
     default) so a stuck orchestrator cannot stall the handler.

**Diagnosing it directly.** The gateway samples its own event-loop delay
(`src/gateway/event-loop-monitor.ts`, on by default) and logs a structured WARN
under the `[gateway/event-loop]` subsystem whenever a sampling window's worst
stall crosses the threshold:

```
[gateway/event-loop] event loop stalled: max=812ms p99=300ms mean=4.3ms window=30s
```

Line that up against the `res ✓ <method> <ms>` line for the handler running at
that time to pin the culprit, instead of reverse-engineering the block from
timestamps. When OTel is enabled it also emits a `gateway.event_loop_delay`
span. Tune or disable via env: `BITTERBOT_EVENT_LOOP_MONITOR=0` (off),
`BITTERBOT_EVENT_LOOP_SAMPLE_MS` (window, default 30000),
`BITTERBOT_EVENT_LOOP_WARN_MS` (threshold, default 250).

A healthy build should not exhibit this. If it reappears:

- Watch for RPC durations ballooning in the logs (e.g. `skills.network` taking
  tens of seconds when it normally takes <200ms) — that is either a regressed
  handler or queueing delay behind a blocked loop.
- Confirm the gateway process is not pinned in `D` (uninterruptible I/O) state
  from SQLite WAL pressure; a `pnpm build` restart checkpoints oversized WAL
  files (`~/.bitterbot/*.sqlite-wal`).
- A new heavy synchronous loop (memory engine **or** RPC handler) is the usual
  regression; it must `await yieldToEventLoop()` (or `makeYieldEvery`)
  periodically, cache its result, or move the work off the main thread.

Related:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway service not running

Use this when service is installed but process does not stay up.

```bash
bitterbot gateway status
bitterbot status
bitterbot logs --follow
bitterbot doctor
bitterbot gateway status --deep
```

Look for:

- `Runtime: stopped` with exit hints.
- Service config mismatch (`Config (cli)` vs `Config (service)`).
- Port/listener conflicts.

Common signatures:

- `Gateway start blocked: set gateway.mode=local` → local gateway mode is not enabled. Fix: set `gateway.mode="local"` in your config (or run `bitterbot configure`). If you are running Bitterbot via Podman using the dedicated `bitterbot` user, the config lives at `~bitterbot/.bitterbot/bitterbot.json`.
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → port conflict.

Related:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Channel connected messages not flowing

If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.

```bash
bitterbot channels status --probe
bitterbot pairing list <channel>
bitterbot status --deep
bitterbot logs --follow
bitterbot config get channels
```

Look for:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist and mention requirements.
- Missing channel API permissions/scopes.

Common signatures:

- `mention required` → message ignored by group mention policy.
- `pairing` / pending approval traces → sender is not approved.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.

Related:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron and heartbeat delivery

If cron or heartbeat did not run or did not deliver, verify scheduler state first, then delivery target.

```bash
bitterbot cron status
bitterbot cron list
bitterbot cron runs --id <jobId> --limit 20
bitterbot system heartbeat last
bitterbot logs --follow
```

Look for:

- Cron enabled and next wake present.
- Job run history status (`ok`, `skipped`, `error`).
- Heartbeat skip reasons (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Common signatures:

- `cron: scheduler disabled; jobs will not run automatically` → cron disabled.
- `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.
- `heartbeat skipped` with `reason=quiet-hours` → outside active hours window.
- `heartbeat: unknown accountId` → invalid account id for heartbeat delivery target.

Related:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Node paired tool fails

If a node is paired but tools fail, isolate foreground, permission, and approval state.

```bash
bitterbot nodes status
bitterbot nodes describe --node <idOrNameOrIp>
bitterbot approvals get --node <idOrNameOrIp>
bitterbot logs --follow
bitterbot status
```

Look for:

- Node online with expected capabilities.
- OS permission grants for camera/mic/location/screen.
- Exec approvals and allowlist state.

Common signatures:

- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.

Related:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser tool fails

Use this when browser tool actions fail even though the gateway itself is healthy.

```bash
bitterbot browser status
bitterbot browser start --browser-profile bitterbot
bitterbot browser profiles
bitterbot logs --follow
bitterbot doctor
```

Look for:

- Valid browser executable path.
- CDP profile reachability.
- Extension relay tab attachment for `profile="chrome"`.

Common signatures:

- `Failed to start Chrome CDP on port` → browser process failed to launch.
- `browser.executablePath not found` → configured path is invalid.
- `Chrome extension relay is running, but no tab is connected` → extension relay not attached.
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.

Related:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## If you upgraded and something suddenly broke

Most post-upgrade breakage is config drift or stricter defaults now being enforced.

### 1) Auth and URL override behavior changed

```bash
bitterbot gateway status
bitterbot config get gateway.mode
bitterbot config get gateway.remote.url
bitterbot config get gateway.auth.mode
```

What to check:

- If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.
- Explicit `--url` calls do not fall back to stored credentials.

Common signatures:

- `gateway connect failed:` → wrong URL target.
- `unauthorized` → endpoint reachable but wrong auth.

### 2) Bind and auth guardrails are stricter

```bash
bitterbot config get gateway.bind
bitterbot config get gateway.auth.token
bitterbot gateway status
bitterbot logs --follow
```

What to check:

- Non-loopback binds (`lan`, `tailnet`, `custom`) need auth configured.
- Old keys like `gateway.token` do not replace `gateway.auth.token`.

Common signatures:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- `RPC probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.

### 3) Pairing and device identity state changed

```bash
bitterbot devices list
bitterbot pairing list <channel>
bitterbot logs --follow
bitterbot doctor
```

What to check:

- Pending device approvals for dashboard/nodes.
- Pending DM pairing approvals after policy or identity changes.

Common signatures:

- `device identity required` → device auth not satisfied.
- `pairing required` → sender/device must be approved.

If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:

```bash
bitterbot gateway install --force
bitterbot gateway restart
```

Related:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
