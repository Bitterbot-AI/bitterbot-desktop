---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

The Gateway is fully supported on Linux. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native Linux companion apps are planned. Contributions are welcome if you want to help build one.

## Beginner quick path (VPS)

1. Install Docker with the compose plugin
2. `mkdir bitterbot && cd bitterbot && curl -fsSLO https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/docker-compose.yml && docker compose up -d`
   (see [Docker](/platforms/docker); update later with `docker compose pull && docker compose up -d`)
3. Read the token: `docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token`
   (or use the value of `BITTERBOT_GATEWAY_TOKEN` if you set one)
4. From your laptop: `ssh -N -L 19001:127.0.0.1:19001 <user>@<host>`
5. Open `http://127.0.0.1:19001/` and paste your token

On a Linux laptop or desktop (x64 or arm64, glibc), the
[installer](/start/install-script) is the shorter path (update with
`bitterbot update`); with Node 18 or newer, `npm install -g bitterbot`
works too (see [npm package](/start/npm)). A source checkout
(`git clone`, `bash scripts/setup-deps.sh`, `pnpm install`,
`pnpm bitterbot onboard --install-daemon`) is for development.

Step-by-step VPS guide: see the [VPS hosting hub](/gateway/vps).

## Install

- [Getting Started](/start/getting-started)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
bitterbot onboard --install-daemon
```

Or:

```
bitterbot gateway install
```

Or:

```
bitterbot configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
bitterbot doctor
```

## System control (systemd user unit)

Bitterbot installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/bitterbot-gateway[-<profile>].service`:

```
[Unit]
Description=Bitterbot Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/bitterbot gateway --port 19001
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now bitterbot-gateway[-<profile>].service
```
