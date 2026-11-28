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

## Navigation

`renderer/src/nav-manifest.ts` is the single list of views and decides where each one lives (PLAN-65).

- **Sidebar** (`place: "sidebar"`): New chat, Search, then Memory, Automations, Files and Circles, then recent conversations grouped Today / Previous 7 days / Older. A conversation's menu has Rename and Delete.
- **Control Center** (`place: "control"`): every view used to operate the agent, grouped by `section` (Agent, Models & usage, Channels & network, Money, Safety, System). One sidebar row opens it and returns to the last view used.
- **Search** (Ctrl/Cmd+K) finds a conversation by title, jumps to any view the gateway offers, and switches appearance. It does not search conversation contents yet.

To add a view: add it to the manifest with a place (and a section if it is a Control Center view) and to `VIEW_MAP` in `components/layout/AppShell.tsx`. `nav-manifest.test.ts` fails if a view has no place.

The conversation list has one owner, `stores/sessions-store.ts`, kept fresh by `hooks/useSessionsSync.ts`. Read it from there; do not fetch `sessions.list` in a component.

## Theme and tokens

The palette lives in `renderer/src/styles/globals.css` as paired light and dark values (PLAN-65).

- **Surfaces are neutral and flat:** `canvas` (chat and pages), `sidebar`, `raised` (composer, menus), `subtle`, `hover`, `selected`. Text is `ink`, `ink-secondary`, `ink-muted`. Borders are `line`, or `control` where an outline has to identify a control.
- **Primary buttons are neutral** (`button` / `on-button`).
- **One accent.** `brand` is a muted purple for the active destination, the focus ring, a toggle that is on. Keep it to small details. `wordmark` is the logo's own brighter purple and is for the wordmark only.
- **Status colours** (`success`, `warning`, `danger`, each with a `-soft` background and a `-foreground` for solid fills) are for an actual status with a text label.
- The shadcn names (`background`, `card`, `primary`, `muted`, `border`, ...) are mapped onto the same values, so existing components follow without edits. On a solid fill use the matching `-foreground` class, never `text-white`: the dark theme's fills are light.

Radii: controls 8 px (`rounded-md`), menus and cards 12 px (`rounded-lg`), composer 24 px (`rounded-composer`). Shadows: `shadow-menu` and `shadow-composer` only.

The theme follows the operating system on a new profile. A stored Light or Dark choice is kept. `index.html` applies it before first paint and `stores/ui-store.ts` keeps it in step; change both together.

`renderer/src/styles/tokens.test.ts` holds the palette to its contract: surfaces stay neutral, every text pair is at least 4.5:1, controls and focus at least 3:1.

## Look and feel checks

Two tools keep restyling work honest (PLAN-65).

**Decorative effects.** `node desktop/scripts/check-decorative-effects.mjs` counts gradients, glass blur, coloured glow shadows and bounce or shimmer animations in `renderer/src`. `pnpm lint` runs it with `--max` set to the current count (87; it was 92 when the check was added), so the number can go down and not up. Lower the limit as views are converted. `--list` prints every hit; `--enforce components/chat,components/layout` fails on any hit under those directories. A line can opt out with a `decorative-ok: <reason>` comment where colour or motion carries meaning.

**Screenshots.** `pnpm ui:screenshots` builds the renderer, serves it from a local stand-in gateway that answers from `desktop/scripts/ui-screenshots/fixtures.mjs`, and captures a fixed set of screens in light and dark into `desktop/.ui-screenshots/` (ignored by git). No real gateway is contacted. Use it for before and after images on a UI pull request; it is not a pixel-diff gate.

```bash
pnpm ui:screenshots                       # build, then capture everything
pnpm ui:screenshots --no-build --only chat-empty,chat-conversation --theme dark
```

It needs a Chromium: set `BITTERBOT_UI_CHROME_PATH`, or run `pnpm exec playwright install chromium`. Methods the fixtures do not answer are refused and listed at the end of the run, so a view that shows "not available" needs a fixture.

## Native Desktop App

See [TAURI.md](TAURI.md) for the Tauri native wrapper (system webview + supervised gateway).
