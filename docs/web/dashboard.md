---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
---

# Dashboard (Control UI)

The Gateway dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):

- [http://localhost:5173](http://localhost:5173) (start gateway + `cd desktop && pnpm dev`)

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, exec approvals).
Do not expose it publicly. The UI stores the token in `localStorage` after first load.
Prefer localhost, Tailscale Serve, or an SSH tunnel.

## Fast path (recommended)

- After onboarding, the CLI auto-opens the dashboard and prints a clean (non-tokenized) link.
- Re-open anytime: `bitterbot dashboard` (copies link, opens browser if possible, shows SSH hint if headless).
- If the UI prompts for auth, paste the token from `gateway.auth.token` (or `BITTERBOT_GATEWAY_TOKEN`) into Control UI settings.

## Token basics (local vs remote)

- **Localhost**: open `http://localhost:5173` (start both: gateway + `cd desktop && pnpm dev`).
- **Token source**: `gateway.auth.token` (or `BITTERBOT_GATEWAY_TOKEN`); the UI stores a copy in localStorage after you connect.
- **Not localhost**: use Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet bind with a token, or an SSH tunnel. See [Web surfaces](/web).

## If you see “unauthorized” / 1008

- Ensure the gateway is reachable (local: `bitterbot status`; remote: SSH tunnel `ssh -N -L 19001:127.0.0.1:19001 user@host` then open `http://localhost:5173` (start both: gateway + `cd desktop && pnpm dev`)).
- Retrieve the token from the gateway host: `bitterbot config get gateway.auth.token` (or generate one: `bitterbot doctor --generate-gateway-token`).
- In the dashboard settings, paste the token into the auth field, then connect.
