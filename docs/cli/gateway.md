---
summary: "Bitterbot Gateway CLI (`bitterbot gateway`) — run, query, and manage gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
title: "gateway"
---

# Gateway CLI

The Gateway is Bitterbot’s WebSocket server (channels, nodes, sessions, hooks).

Subcommands in this page live under `bitterbot gateway …`.

Related docs:

- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Run the Gateway

Run a local Gateway process:

```bash
bitterbot gateway
```

Foreground alias:

```bash
bitterbot gateway run
```

Notes:

- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.bitterbot/bitterbot.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
- Binding beyond loopback without auth is blocked (safety guardrail).
- `SIGUSR1` triggers an in-process restart when authorized (enable `commands.restart` or use the gateway tool/config apply/update).
- `SIGINT`/`SIGTERM` handlers stop the gateway process, but they don’t restore any custom terminal state. If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.

### Options

- `--port <port>`: WebSocket port (default comes from config/env; usually `19001`).
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind mode.
- `--auth <token|password>`: auth mode override.
- `--token <token>`: token override (also sets `BITTERBOT_GATEWAY_TOKEN` for the process).
- `--password <password>`: password override (also sets `BITTERBOT_GATEWAY_PASSWORD` for the process).
- `--tailscale <off|serve|funnel>`: expose the Gateway via Tailscale.
- `--tailscale-reset-on-exit`: reset Tailscale serve/funnel config on shutdown.
- `--allow-unconfigured`: allow gateway start without `gateway.mode=local` in config.
- `--dev`: create a dev config + workspace if missing (skips BOOTSTRAP.md).
- `--reset`: reset dev config + credentials + sessions + workspace (requires `--dev`).
- `--force`: kill any existing listener on the selected port before starting.
- `--verbose`: verbose logs.
- `--claude-cli-logs`: only show claude-cli logs in the console (and enable its stdout/stderr).
- `--ws-log <auto|full|compact>`: websocket log style (default `auto`).
- `--compact`: alias for `--ws-log compact`.
- `--raw-stream`: log raw model stream events to jsonl.
- `--raw-stream-path <path>`: raw stream jsonl path.

## Query a running Gateway

All query commands use WebSocket RPC.

Output modes:

- Default: human-readable (colored in TTY).
- `--json`: machine-readable JSON (no styling/spinner).
- `--no-color` (or `NO_COLOR=1`): disable ANSI while keeping human layout.

Shared options (where supported):

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway token.
- `--password <password>`: Gateway password.
- `--timeout <ms>`: timeout/budget (varies per command).
- `--expect-final`: wait for a “final” response (agent calls).

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

### `gateway health`

```bash
bitterbot gateway health --url ws://127.0.0.1:19001
```

### `gateway status`

`gateway status` shows the Gateway service (launchd/systemd/schtasks) plus an optional RPC probe.

```bash
bitterbot gateway status
bitterbot gateway status --json
```

Options:

- `--url <url>`: override the probe URL.
- `--token <token>`: token auth for the probe.
- `--password <password>`: password auth for the probe.
- `--timeout <ms>`: probe timeout (default `10000`).
- `--no-probe`: skip the RPC probe (service-only view).
- `--deep`: scan system-level services too.

### `gateway probe`

`gateway probe` is the “debug everything” command. It always probes:

- your configured remote gateway (if set), and
- localhost (loopback) **even if remote is configured**.

If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.

```bash
bitterbot gateway probe
bitterbot gateway probe --json
```

#### Remote over SSH

A local port-forward makes the remote gateway (which may be bound to loopback only) reachable at `ws://127.0.0.1:<port>`.

CLI equivalent:

```bash
bitterbot gateway probe --ssh user@gateway-host
```

Options:

- `--ssh <target>`: `user@host` or `user@host:port` (port defaults to `22`).
- `--ssh-identity <path>`: identity file.
- `--ssh-auto`: pick the first discovered gateway host as SSH target (LAN/WAB only).

Config (optional, used as defaults):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC helper.

```bash
bitterbot gateway call status
bitterbot gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Manage the Gateway service

```bash
bitterbot gateway install
bitterbot gateway start
bitterbot gateway stop
bitterbot gateway restart
bitterbot gateway uninstall
```

Notes:

- `gateway install` supports `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Lifecycle commands accept `--json` for scripting.

### `gateway switch`

Hands the running gateway and the background service over to the install
you run this command from, for example after installing a release over a git
clone or an older version (the installer runs it for you; see
[Upgrading from a git clone or an older version](/start/install-script#upgrading-from-a-git-clone-or-an-older-version)).

```bash
bitterbot gateway switch --check
bitterbot gateway switch
bitterbot gateway switch --yes --json
```

It finds the installed service and what it runs, and the process on the
gateway port, where it runs from and its version. When that is another
install, it stops the old gateway (through its service manager, or a stop
signal to a process verified to be a Bitterbot gateway), points the service at
this install (as `gateway install --force` does) or starts this install in the
background when there is no service, and waits until this version answers. If
it does not, the old service definition or the old process is put back. Your
config, memory and keys are not changed.

Options: `--check` (alias `--dry-run`) only reports; `-y`, `--yes` switches
without asking; `--port <port>`; `--timeout <ms>` (how long to wait for the
new gateway, default 120000); `--json`.

Exit codes: with `--check`, 0 nothing to switch, 10 a switch is available, 2
something it will not touch is on the port. Otherwise 0 switched (or nothing
to do), 1 not switched but the previous gateway runs as before, 2 not done
(declined, needs `--yes`, or blocked), 3 failed and the previous gateway could
not be restarted (the output says what to run).
