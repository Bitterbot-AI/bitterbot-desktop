# Bitterbot Control UI

Browser-based dashboard for the Bitterbot gateway. Built with Vite + React.

## Dev Server

```bash
pnpm dev
```

Opens on [http://localhost:5173](http://localhost:5173). Connects to the gateway on `ws://127.0.0.1:19001` automatically.

**The gateway must be running first.** From the repo root:

```bash
pnpm gateway:watch      # dev mode (auto-rebuild on TS changes)
# — or —
pnpm dev:all            # starts both gateway + this UI in one terminal
```

## Auth Setup

The onboarding wizard (`pnpm bitterbot onboard`) auto-generates `desktop/.env` with your gateway token and URL. If you skipped the wizard or need to set it up manually:

```bash
cp .env.example .env
```

Then paste your gateway token from `~/.bitterbot/bitterbot.json` (`gateway.auth.token`) into `VITE_GATEWAY_TOKEN`.

## Build

```bash
pnpm build              # production build → dist-renderer/
pnpm preview            # preview the production build locally
```

## Native Desktop App

See [TAURI.md](TAURI.md) for the Tauri native wrapper (system webview + supervised gateway).
