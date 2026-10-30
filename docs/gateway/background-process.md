---
summary: "Background exec execution and process management"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
  - Running the gateway on WSL2 without systemd (autostart, crash supervision)
title: "Background Exec and Process Tool"
---

# Background Exec + Process Tool

Bitterbot runs shell commands through the `exec` tool and keeps long‑running tasks in memory. The `process` tool manages those background sessions.

## exec tool

Key parameters:

- `command` (required)
- `yieldMs` (default 10000): auto‑background after this delay
- `background` (bool): background immediately
- `timeout` (seconds, default 1800): kill the process after this timeout
- `elevated` (bool): run on host if elevated mode is enabled/allowed
- Need a real TTY? Set `pty: true`.
- `workdir`, `env`

Behavior:

- Foreground runs return output directly.
- When backgrounded (explicit or timeout), the tool returns `status: "running"` + `sessionId` and a short tail.
- Output is kept in memory until the session is polled or cleared.
- If the `process` tool is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.

## Child process bridging

When spawning long-running child processes outside the exec/process tools (for example, CLI respawns or gateway helpers), attach the child-process bridge helper so termination signals are forwarded and listeners are detached on exit/error. This avoids orphaned processes on systemd and keeps shutdown behavior consistent across platforms.

Environment overrides:

- `PI_BASH_YIELD_MS`: default yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: in‑memory output cap (chars)
- `BITTERBOT_BASH_PENDING_MAX_OUTPUT_CHARS`: pending stdout/stderr cap per stream (chars)
- `PI_BASH_JOB_TTL_MS`: TTL for finished sessions (ms, bounded to 1m–3h)

Config (preferred):

- `tools.exec.backgroundMs` (default 10000)
- `tools.exec.timeoutSec` (default 1800)
- `tools.exec.cleanupMs` (default 1800000)
- `tools.exec.notifyOnExit` (default true): enqueue a system event + request heartbeat when a backgrounded exec exits.
- `tools.exec.notifyOnExitEmptySuccess` (default false): when true, also enqueue completion events for successful backgrounded runs that produced no output.

## process tool

Actions:

- `list`: running + finished sessions
- `poll`: drain new output for a session (also reports exit status)
- `log`: read the aggregated output (supports `offset` + `limit`)
- `write`: send stdin (`data`, optional `eof`)
- `kill`: terminate a background session
- `clear`: remove a finished session from memory
- `remove`: kill if running, otherwise clear if finished

Notes:

- Only backgrounded sessions are listed/persisted in memory.
- Sessions are lost on process restart (no disk persistence).
- Session logs are only saved to chat history if you run `process poll/log` and the tool result is recorded.
- `process` is scoped per agent; it only sees sessions started by that agent.
- `process list` includes a derived `name` (command verb + target) for quick scans.
- `process log` uses line-based `offset`/`limit`.
- When both `offset` and `limit` are omitted, it returns the last 200 lines and includes a paging hint.
- When `offset` is provided and `limit` is omitted, it returns from `offset` to the end (not capped to 200).

## Examples

Run a long task and poll later:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Start immediately in background:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```

## WSL2 without systemd

A WSL2 distro whose PID 1 is `init` (not systemd) has no user bus: `systemctl --user` fails with `Failed to connect to bus`, and the systemd backend cannot install anything. On such a host `bitterbot gateway install` selects the `wsl-supervisor` backend instead (Linux keeps systemd whenever the user bus works; non-WSL Linux without systemd keeps the systemd backend and its hints). Nothing it installs is root-owned, so it needs no sudo and no `/etc/wsl.conf` change.

```bash
bitterbot gateway install            # record, logon task, supervisor started now
bitterbot gateway install --dry-run  # print the task XML and the commands only
bitterbot gateway status             # supervisor pid, gateway pid, port, task, last exits
bitterbot gateway stop               # stops the supervisor, which stops the gateway
bitterbot gateway restart            # stop + start the supervisor
bitterbot gateway uninstall          # removes the task, the lock and the record
```

### What gets installed

- `~/.bitterbot/run/gateway-supervisor.json`: the recorded command (program arguments, working directory, environment), what `bitterbot gateway status` shows as the service command.
- A Windows scheduled task named `Bitterbot Gateway (WSL <distro>)` for the current Windows user (logon trigger). Its action is `C:\Windows\System32\wsl.exe -d <distro> -u <linux user> -- <launcher> gateway supervise`, where the launcher is `~/.bitterbot/app/current/bin/bitterbot` on a release install. It is registered through `schtasks.exe /Create /XML` from a UTF-16 file written to the Windows temp dir and deleted afterwards, because only the XML form can set `ExecutionTimeLimit` to `PT0S` (the `/SC ONLOGON` flags leave the default 72 hour limit, which would kill the supervisor after three days). The task also sets `MultipleInstancesPolicy` IgnoreNew, `StartWhenAvailable` true and `DisallowStartIfOnBatteries` false.
- The supervisor process, started detached right away. It adopts a gateway that is already running (see below), so the install does not restart the gateway.

If Windows interop (`schtasks.exe`, `wsl.exe` under `/mnt/c/Windows/System32`) is not reachable, the install still writes the record and starts the supervisor, and says plainly that no boot trigger was registered and how to enable interop. The supervisor then runs until the next Windows reboot; `bitterbot gateway start` brings it back.

The task runs `wsl.exe` in the interactive session, so a console window belongs to the supervisor after logon. Closing that window kills the supervisor and the gateway; use `bitterbot gateway stop` instead.

### `bitterbot gateway supervise`

This is what the task runs; you do not type it. The supervisor:

- Spawns the recorded command (the launcher is re-resolved from `BITTERBOT_INSTALL_ROOT` when the recorded path is gone, falling back to this Node and the CLI entry), with the recorded working directory and environment.
- Writes the gateway's stdout and stderr to `~/.bitterbot/logs/gateway-<YYYYMMDD>.log` (a new file per calendar day, the newest 14 kept) and one line per gateway exit to `~/.bitterbot/logs/gateway-exits.log`: ISO time, pid, exit code or signal, uptime in seconds, and the relaunch decision.
- Holds a single-instance lock at `~/.bitterbot/run/gateway-supervisor.lock` (pid inside; a lock whose owner is dead is taken over) and writes `gateway-supervisor.pid` next to it.
- Removes a leftover `/tmp/bitterbot-orchestrator.sock` before each spawn, only when no process answers on it.

### Relaunch policy

- Any non-zero exit or signal: relaunch after a backoff of 5 s that doubles per consecutive failure and caps at 60 s. Ten minutes of healthy uptime reset the backoff.
- Exit code 0 is an intentional stop or a SIGUSR1 full-process restart (the old gateway spawns the new one detached, hands it the lock and exits 0 while the child keeps running). The supervisor does not relaunch on exit 0. It waits 20 s, then checks the gateway lock and the port: a gateway holding the lock or answering on the port is the restart child, and the supervisor adopts it. Nothing running after the grace means a stop nobody asked the supervisor for, so it relaunches once and logs why. A second exit 0 that again leaves nothing running (before the ten-minute reset) means the gateway is being stopped on purpose; the supervisor logs that and exits.
- SIGTERM or SIGINT to the supervisor (what `bitterbot gateway stop` sends) forwards a graceful stop to the gateway, waits for it (SIGKILL after 45 s), and exits without relaunching.

### Adoption

When the supervisor starts and a gateway already holds the gateway lock or answers on the configured port (a gateway started by hand, or the child of a restart handoff), it does not spawn a second one. It logs `waiting on an externally started gateway (pid ...)`, polls every 5 s, and takes over only when that gateway exits. This is how a by-hand gateway becomes supervised without a restart: run `bitterbot gateway install` while it runs.

### Logs and status

`bitterbot gateway status` shows the supervisor pid, the gateway pid (from the gateway lock), whether the port listens, the scheduled task state (`schtasks /Query`), and the last three lines of `gateway-exits.log`. `bitterbot doctor` on a WSL2 host without systemd reports a missing supervisor as a finding, with `bitterbot gateway install` as the fix.
