# Bitterbot Control UI

Browser-based dashboard for the Bitterbot gateway. Built with Vite + React.

## Dev Server

```bash
pnpm dev
```

Dev server opens on [http://localhost:5173](http://localhost:5173) with hot reload and connects to the gateway on `ws://127.0.0.1:19001`. In production the gateway serves the built UI itself at `http://127.0.0.1:19001/`; `pnpm ui:build` builds and stages it.

**The gateway does not have to be running first.** If it's down, the Overview
tab shows a **Start gateway** button that launches it (the dev server exposes
`POST /__gateway/start`, authenticated with the gateway token, which spawns
`pnpm start gateway` detached; spawn output lands in
`~/.bitterbot/logs/gateway-ui-launch.log`). The endpoint only exists on the
Vite dev server — in a packaged build the button falls back to telling you to
start it from a terminal. To start it yourself from the repo root:

```bash
pnpm start gateway      # production config
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
