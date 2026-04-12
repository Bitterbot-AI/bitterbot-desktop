# Bitterbot Desktop — Tauri Shell

The Bitterbot desktop app uses [Tauri 2](https://v2.tauri.app/) to wrap the Control UI (Vite + React) in a native system-webview window and manage the gateway as a supervised child process. The result is one click → one window → the agent is running.

## Architecture

```
Tauri shell (Rust)
  ├─ system webview → Control UI (React SPA)
  └─ child process → node scripts/run-node.mjs gateway
                          └─ child process → bitterbot-orchestrator (P2P)
```

The Tauri shell does NOT embed the orchestrator as a Rust crate (yet). It spawns `node ... gateway` as a standard child process, and the gateway's `OrchestratorBridge` spawns the orchestrator in turn. The shell:

- Starts the gateway on launch, kills it on close
- Falls back gracefully if the gateway fails to start (the FirstRun / Disconnected UI still renders)
- On Unix, sends SIGINT for graceful gateway shutdown before SIGKILL
- On Windows, calls `kill()` directly (no SIGINT on Windows child processes)

## Prerequisites

### System-level (one time per machine)

**Rust toolchain** — same requirement as the orchestrator. Rust ≥ 1.88.

**Tauri system deps** — Tauri uses the OS system webview. Each platform needs different packages.

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  libglib2.0-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

**macOS:** Xcode Command Line Tools (`xcode-select --install`). No extra packages.

**Windows:** Install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). Most Windows 10/11 machines already have it.

### Node-level

```bash
cd desktop
pnpm install   # pulls @tauri-apps/cli as a devDep
```

## Development

```bash
# From the desktop/ directory:
pnpm tauri:dev
```

This does three things:
1. Starts the Vite dev server on `:5173` (same as `pnpm dev`)
2. Builds the Tauri shell Rust code (`cargo build` inside `src-tauri/`)
3. Opens the native window pointed at `http://localhost:5173`

The gateway starts automatically as a child process of the Tauri shell. Hot reload works for the React UI (Vite HMR). Changes to the Rust shell require a restart of `pnpm tauri:dev`.

First-time build takes ~3-5 min (Tauri Rust deps + system webview linking). Subsequent builds are incremental and fast.

## Production build

```bash
pnpm tauri:build
```

Produces platform-specific bundles in `src-tauri/target/release/bundle/`:
- **Linux:** `.AppImage` + `.deb`
- **macOS:** `.app` + `.dmg`
- **Windows:** `.msi` + `.exe`

### Current limitation: Node required at runtime

The MVP gateway sidecar spawns `node scripts/run-node.mjs gateway`, which requires Node ≥ 22 to be installed on the end-user's machine. This is acceptable for the current developer/power-user audience, but for true "click an icon, it just works" distribution, the gateway needs to be compiled into a standalone executable.

**Planned path:** Use `bun build --compile` to produce a single-file gateway binary, then ship it as a Tauri sidecar via `bundle.externalBin` in `tauri.conf.json`. This removes the Node dependency for end users entirely. Not yet implemented.

## Project structure

```
desktop/
├── src-tauri/
│   ├── Cargo.toml          ← Rust deps (tauri 2, tauri-plugin-shell, libc)
│   ├── build.rs            ← Standard Tauri build hook
│   ├── tauri.conf.json     ← App config (window size, dev URL, bundle ID)
│   ├── icons/              ← App icons (placeholder — replace with real ones)
│   └── src/
│       └── main.rs         ← Entry: spawns gateway child, manages lifecycle
├── renderer/               ← React SPA (existing Control UI)
├── package.json            ← @tauri-apps/cli in devDeps, tauri:dev/tauri:build scripts
└── TAURI.md                ← This file
```

## What's NOT in this MVP

- **Bun-compiled gateway sidecar** — gateway still requires system Node
- **Orchestrator as embedded Rust crate** — still spawned externally; merging it would save a process but is architecturally complex
- **Auto-updater** — Tauri has a built-in updater; needs a release server (GitHub Releases works)
- **Code signing** — macOS notarization requires an Apple Developer account ($99/yr), Windows SmartScreen requires an EV cert ($300/yr). Both deferred until traction warrants it.
- **CI cross-platform Tauri builds** — new workflow needed (`.github/workflows/desktop-release.yml`). Same pattern as the orchestrator release workflow but with Tauri-specific matrix config.
- **App icons** — the `icons/` directory has a placeholder. Replace with real app icons before any public distribution.
- **Tray icon / background mode** — possible with Tauri but not wired yet
