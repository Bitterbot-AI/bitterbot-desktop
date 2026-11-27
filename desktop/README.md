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

Nothing to set up: the UI asks the gateway it connects to for the token over a
same-origin loopback endpoint, and falls back to the first-run screen (paste the
token from `~/.bitterbot/bitterbot.json → gateway.auth.token`) for remote
gateways. The old `VITE_GATEWAY_TOKEN` define is gone — the token is never baked
into a build. `desktop/.env` remains only as an optional dev override for
`VITE_GATEWAY_URL` when your dev gateway is not on `ws://localhost:19001`.

## Build

```bash
pnpm build              # production build → dist-renderer/
pnpm preview            # preview the production build locally
```

## Look and feel checks

Two tools keep restyling work honest (PLAN-65).

**Decorative effects.** `node desktop/scripts/check-decorative-effects.mjs` counts gradients, glass blur, coloured glow shadows and bounce or shimmer animations in `renderer/src`. `pnpm lint` runs it with `--max 92`, the count when the check was added, so the number can go down and not up. Lower the limit as views are converted. `--list` prints every hit; `--enforce components/chat,components/layout` fails on any hit under those directories. A line can opt out with a `decorative-ok: <reason>` comment where colour or motion carries meaning.

**Screenshots.** `pnpm ui:screenshots` builds the renderer, serves it from a local stand-in gateway that answers from `desktop/scripts/ui-screenshots/fixtures.mjs`, and captures a fixed set of screens in light and dark into `desktop/.ui-screenshots/` (ignored by git). No real gateway is contacted. Use it for before and after images on a UI pull request; it is not a pixel-diff gate.

```bash
pnpm ui:screenshots                       # build, then capture everything
pnpm ui:screenshots --no-build --only chat-empty,chat-conversation --theme dark
```

It needs a Chromium: set `BITTERBOT_UI_CHROME_PATH`, or run `pnpm exec playwright install chromium`. Methods the fixtures do not answer are refused and listed at the end of the run, so a view that shows "not available" needs a fixture.

## Native Desktop App

See [TAURI.md](TAURI.md) for the Tauri native wrapper (system webview + supervised gateway).
