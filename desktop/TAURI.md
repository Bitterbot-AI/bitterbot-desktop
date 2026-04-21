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

### Gateway sidecar: Node SEA (Phase 1)

The gateway is compiled into a single-executable Node.js binary via
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
(stable since Node 22). The resulting binary is ~90 MB per platform, has no
runtime dependency on a system Node install, and is shipped as a Tauri
sidecar via `bundle.externalBin` in `tauri.conf.json`.

Build the sidecar locally:

```bash
node scripts/build-sea.mjs --target x86_64-unknown-linux-gnu
# or: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc
```

Output lands at `desktop/src-tauri/binaries/bitterbot-gateway-<target>[.exe]`,
which is the filename Tauri's sidecar resolver expects.

**Why SEA and not `bun --compile`?** `better-sqlite3` is a C++ N-API addon
resolved at runtime via `node-gyp-build`/`bindings`. Bun's bundler can't
follow that resolution; attempting to embed it silently drops the `.node`
file, and Bun's JSC-based Node shim has had regressions with `better-sqlite3`
tracked in [oven-sh/bun#4619](https://github.com/oven-sh/bun/issues/4619).
Node SEA keeps the persistence layer intact. See
`research/TAURI-PRODUCTION-PLAN.md` §2 for the full decision.

During development (`pnpm tauri:dev`), `src-tauri/src/main.rs` still spawns
the gateway via `node scripts/run-node.mjs` to avoid the SEA rebuild on every
code change. The swap to the sidecar API (`app.shell().sidecar(...)`) is
guarded by a TODO in `spawn_gateway()` and happens in Phase 2 once the
dev-loop is sorted.

## Auto-updater

Wired via `tauri-plugin-updater` and `tauri-plugin-process`. The update
manifest is hosted at
`https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json`,
which GitHub auto-redirects to the newest non-prerelease release. The
`desktop-release.yml` workflow generates and signs the manifest via
`tauri-action` with `includeUpdaterJson: true`.

The renderer calls into `desktop/renderer/src/lib/updater.ts`, which:

- Checks on app launch (30s delay) and every 4 hours thereafter
- Surfaces update status via a subscribable `UpdateStatus` store
- No-ops gracefully when running in a plain browser (dev)

**Setup required before the first release:**

1. `cd desktop && pnpm tauri signer generate -w ~/.tauri/bitterbot-updater.key`
2. Paste the public key contents into `tauri.conf.json` `plugins.updater.pubkey`
3. Add GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` (private key contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
4. Back up the private key offline. Losing it means no future updates can be
   signed for the current public key.

## Release pipeline

`/.github/workflows/desktop-release.yml` triggers on `desktop-v*` tag push.
Matrix builds on `macos-14` (arm64), `macos-13` (x64), `ubuntu-22.04`, and
`windows-2022`. Produces `.dmg`, `.app.tar.gz`, `.AppImage`, `.deb`, and NSIS
`.exe` plus signed `latest.json`. Draft-then-publish pattern gates publish
on all legs green.

Estimated CI: ~93 billed minutes per release (free on public repos).

## Tray and close-to-tray behavior

The main window closes to the tray instead of quitting the process, so the
gateway and memory state stay warm. Right-click the tray icon for Show/Quit,
left-click to raise the window. See `main.rs` setup closure.

`macOSPrivateApi: true` in `tauri.conf.json` keeps the app alive on macOS
when the window is closed (otherwise the OS kills the process). To switch to
a true menubar-only mode (no dock icon), set `LSUIElement = true` in the
bundled `Info.plist`.

## Project structure

```
desktop/
├── src-tauri/
│   ├── Cargo.toml              ← Rust deps (tauri 2 + plugins)
│   ├── build.rs                ← Standard Tauri build hook
│   ├── tauri.conf.json         ← App config (window, bundle, updater, entitlements)
│   ├── Entitlements.plist      ← macOS hardened-runtime entitlements
│   ├── capabilities/default.json ← Tauri 2 permission set
│   ├── icons/                  ← App icons (populate before first bundle)
│   ├── binaries/               ← SEA gateway sidecar (produced by build-sea.mjs; gitignored)
│   ├── resources/              ← Native module addons (better_sqlite3.node, etc.)
│   └── src/
│       └── main.rs             ← Entry: spawns gateway, tray, updater wiring
├── renderer/
│   └── src/lib/updater.ts      ← Renderer-side updater hook
├── package.json                ← @tauri-apps/cli in devDeps, tauri:dev/tauri:build scripts
└── TAURI.md                    ← This file
```

## Phase 1 status (see research/TAURI-PHASE-1-STATUS.md)

Wired and ready for testing:

- Cross-platform release workflow (unsigned Tier 0)
- SEA sidecar build script
- Auto-updater plugins + renderer hook
- Tray icon + close-to-tray
- macOS entitlements for signed gateway sidecar
- `externalBin` + capability permissions

Still to do:

- Real app icons (run `pnpm tauri icon path/to/source.png` once the designed PNG exists)
- Generate the Tauri updater minisign key pair and back it up offline
- Add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, `@tauri-apps/api` to `desktop/package.json`
- First end-to-end test of `pnpm tauri:build` with the SEA sidecar populated
- Apple Developer enrollment ($99/yr) for Tier 1 macOS signing

## What's NOT in Phase 1 (deferred)

- **Orchestrator as embedded Rust crate.** Keeping the 3-process topology for libp2p crash isolation. Revisit if bundle size becomes a distribution blocker. See `research/TAURI-PRODUCTION-PLAN.md` §11.
- **Windows code signing.** Tier 2; apply to SignPath Foundation (free for OSS) or use Azure Artifact Signing ($10/mo).
- **Mac App Store, Microsoft Store, Flathub, Snap.** Out of scope.
- **Launch on boot.** Ship `tauri-plugin-autostart` later if users ask.
- **Crash reporting / telemetry.** Not planned.
