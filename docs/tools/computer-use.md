---
summary: "OS-level computer control (screenshot, mouse, keyboard) via the orchestrator daemon"
read_when:
  - Adding agent-driven OS control
  - Setting up headless / kiosk-style automation
  - Reasoning about when computer_use refuses to act
title: "Computer use (OS control)"
---

# Computer use

The `computer_use` tool lets agents take screenshots and synthesize mouse and
keyboard input on the host OS. It is the **OS-level counterpart** to the
`browser` tool: where `browser` automates a managed Chrome profile,
`computer_use` automates the actual desktop.

This is a privileged capability. By design it is **off in every default
build and every default runtime** — both a build-time flag and a
runtime env var must be set before the tool will move a single pixel.

## When to use it (and when not to)

Use `computer_use` for:

- Driving a non-browser desktop app the agent needs to fill in a form on.
- Headless workflows where the agent is the only user (kiosk, CI worker,
  air-gapped environment).
- Demos where the agent needs to demonstrate visible cause-and-effect
  on screen.

**Do not** reach for `computer_use` when `browser` would do — `browser` is
isolated, deterministic, and observable. `computer_use` is shared with
the human's keyboard and mouse, so it can interrupt them and be
interrupted by them.

## Two-stage gating

For `computer_use` to actually act, **both** gates must be open:

### 1. Build-time: `--features=computer-use`

The orchestrator default build does **not** link `xcap` (screen capture)
or `enigo` (input synthesis). To enable:

```bash
cargo build --release --manifest-path orchestrator/Cargo.toml --features=computer-use
```

On Linux, `enigo` needs `libxdo-dev` (or `libxtst-dev` on some distros)
installed at runtime. On macOS and Windows the deps come from the OS
itself — no extra packages.

A binary built without the feature still understands the IPC commands;
it returns `{ ok: false, error: "computer-use feature not enabled in
this orchestrator build" }` so callers see a clear cause.

### 2. Runtime: `BITTERBOT_COMPUTER_USE=1`

Even on a feature-built binary, the operator must opt in per process:

```bash
BITTERBOT_COMPUTER_USE=1 ./bitterbot-orchestrator ...
```

Without it, every command returns `{ ok: false, error: "computer use
disabled at runtime — set BITTERBOT_COMPUTER_USE=1" }`.

Why two gates? Build-time keeps X11 deps off the relay fleet entirely.
Runtime keeps a misconfigured node from clicking the moment the binary
starts.

## Actions

The tool exposes one entry point with an `action` discriminator:

| Action        | Required args                                             | Returns                                            |
| ------------- | --------------------------------------------------------- | -------------------------------------------------- |
| `screenshot`  | `monitorIndex?` (default 0)                               | `{ ok, png_base64, width, height, monitor_index }` |
| `screen_size` | `monitorIndex?`                                           | `{ ok, width, height, monitor_index }`             |
| `mouse_move`  | `x`, `y`                                                  | `{ ok, x, y }`                                     |
| `mouse_click` | `button?` (`left` \| `right` \| `middle`, default `left`) | `{ ok, button }`                                   |
| `type`        | `text`                                                    | `{ ok, typed }` (`typed` is the character count)   |
| `key`         | `key` (e.g. `Return`, `Tab`, `Escape`, `a`)               | `{ ok, key }`                                      |

Errors always come back as `{ ok: false, error }`. The agent should
branch on `ok` rather than wrap the call in `try/catch` — exceptions
indicate a transport-level problem, not a tool-level refusal.

### Recognized key names

`Return`, `Enter`, `Tab`, `Escape`, `Esc`, `Backspace`, `Delete`, `Up`,
`Down`, `Left`, `Right` (and the `Arrow*` variants), `Space`, `Home`,
`End`, `PageUp`, `PageDown`. Any single Unicode character also works
(`a`, `7`, `é`).

## How agents call it

The tool registers as `computer_use` in the gateway's tool list. From
an agent's perspective it's a normal JSON-args tool:

```json
{ "action": "screenshot", "monitorIndex": 0 }
{ "action": "mouse_move", "x": 800, "y": 400 }
{ "action": "type", "text": "Hello, world" }
{ "action": "key", "key": "Return" }
```

Screenshots return base64-encoded PNG so the agent can reason about
the visual result of the previous action without a round-trip through
the filesystem.

## What happens under the hood

1. Agent invokes the `computer_use` tool with an action.
2. The tool reaches into the gateway's active `OrchestratorBridge` and
   sends a JSON-line IPC command (`computer_screenshot`,
   `computer_mouse_move`, etc.) over the Unix domain socket at
   `/tmp/bitterbot-orchestrator.sock`.
3. The orchestrator's `computer.rs` module either invokes `xcap` /
   `enigo` (feature on, env on) or returns the gating error envelope.
4. The response flows back up the same channel and the agent gets a
   normalized `ComputerUseResult`.

Because the path goes **agent → gateway → orchestrator daemon → OS**,
the tool works without a desktop window — the orchestrator is a
headless process, not a Tauri app. (There is also an in-process Tauri
implementation at `desktop/src-tauri/src/computer_use.rs` for the
desktop UI's own use; the agent tool does not depend on it.)

## Failure modes

| Symptom                                                       | Cause                             | Fix                                                                                  |
| ------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `computer_use unavailable: orchestrator daemon not connected` | P2P disabled or orchestrator died | Enable `p2p` in `bitterbot.json`; check `bitterbot doctor`                           |
| `computer-use feature not enabled in this orchestrator build` | Default-build orchestrator        | Rebuild with `--features=computer-use`                                               |
| `computer use disabled at runtime`                            | `BITTERBOT_COMPUTER_USE` unset    | Restart orchestrator with the env var                                                |
| `enigo init failed` (Linux)                                   | Missing `libxdo` / no display     | `apt install libxdo-dev libxtst-dev`; ensure `$DISPLAY` or `$WAYLAND_DISPLAY` is set |
| `monitor enumeration failed`                                  | Headless box with no Xvfb         | Start an Xvfb session: `Xvfb :99 -screen 0 1920x1080x24` and export `DISPLAY=:99`    |

## Safety notes

- The orchestrator runs as the same OS user as the gateway, so
  `computer_use` has the **full permission set of that user** —
  including any open SSH agents, browser sessions, or password
  managers visible on the desktop.
- Never expose the orchestrator's IPC socket beyond loopback. The
  default Unix socket path (`/tmp/bitterbot-orchestrator.sock`) is
  user-private; do not symlink or proxy it.
- For multi-tenant or shared-host deployments, run the orchestrator as
  a dedicated unprivileged user with no access to the operator's
  personal data.
- The `BITTERBOT_COMPUTER_USE=1` gate is a **process-level** flag.
  Restarting the orchestrator without it will refuse all commands
  cleanly — there is no in-process toggle, by design.
