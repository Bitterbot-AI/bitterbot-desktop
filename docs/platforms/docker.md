---
summary: "Run Bitterbot always on: the container image, Docker Compose, Fly.io and a plain VPS"
read_when:
  - You want the agent running when your computer is off
  - Deploying Bitterbot to a server or Fly.io
  - Updating or rolling back a container install
title: "Docker and always-on hosting"
---

# Docker and always-on hosting

An agent that runs on your laptop sleeps when the laptop does: no schedules, no
monitors, no dreaming. Run it on a server instead and it keeps working. Every
option here uses the same container image and keeps all state on a volume.

## The image

`ghcr.io/bitterbot-ai/bitterbot-desktop` is published for `linux/amd64` and
`linux/arm64` on every release, tagged `latest`, the full version (`1.2.0`),
`1.2` and `1`. Pin a full version for predictable updates.

| Path in the container   | What it holds                                         |
| ----------------------- | ----------------------------------------------------- |
| `/home/node/.bitterbot` | Config, memory, sessions, keys. Put this on a volume. |
| Port `19001`            | Gateway API and the Control UI                        |
| Port `9100`             | P2P mesh (optional)                                   |

The image runs as the `node` user (uid 1000). The gateway reads its token from
`BITTERBOT_GATEWAY_TOKEN`.

## First run, from the browser

1. Open the Control UI at your server's address and paste the gateway token.
2. The first browser that connects with the token is paired automatically, so
   you do not need the CLI. This happens once, only while no device is paired,
   and only for the Control UI. The Fly and VPS templates turn it on with
   `BITTERBOT_BOOTSTRAP_PAIRING=1`; elsewhere set
   `gateway.controlUi.bootstrapPairing: true`. Every browser after that asks for
   approval, which you give from an already-paired one or with
   `bitterbot devices approve`.
3. Add a model key under **Models & Keys**, then start chatting. Connect chat
   apps under **Channels**.

## Docker Compose

The repository's `docker-compose.yml` runs the gateway and a CLI container:

```bash
export BITTERBOT_CONFIG_DIR=~/.bitterbot BITTERBOT_WORKSPACE_DIR=~/.bitterbot/workspace
export BITTERBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
docker compose up -d bitterbot-gateway
```

The Control UI is on `http://127.0.0.1:19001`. To serve your network, set
`BITTERBOT_BIND_HOST=0.0.0.0` (with a strong token).

## Fly.io

`deploy/fly/` holds a Fly app: an always-on machine, a volume for state, HTTPS on
`<app>.fly.dev`, and the P2P port.

```bash
cd deploy/fly
fly launch --copy-config --no-deploy --name <your-app>
fly volumes create bitterbot_data --size 3
fly secrets set BITTERBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

Keep the token you set: it is how you sign in. Machines do not auto-stop, since
a stopped agent cannot run its schedules.

## A plain VPS

`deploy/vps/cloud-init.yaml` sets up an Ubuntu or Debian server: Docker, the
gateway as a systemd service, a generated token in `/root/bitterbot-token.txt`,
and an update script. Paste it as the server's user data when you create it.

- With a domain: set `BITTERBOT_DOMAIN` in `/opt/bitterbot/settings.env` (before
  first boot, or later followed by `systemctl restart bitterbot`) to a name that
  points at the server. Caddy serves the Control UI on that name over HTTPS.
- Without one: the gateway listens on `127.0.0.1` only. Reach it through SSH:
  `ssh -L 19001:127.0.0.1:19001 root@<server>`, then open
  `http://127.0.0.1:19001`.

## Updates and rollback

The Control UI's update button does not update a container (the image is the
code, so the next restart would bring the old one back); it tells you to pull a
newer image instead:

- **VPS:** `/opt/bitterbot/update.sh` pulls the image, restarts, and waits for the
  gateway to answer. If it does not, it switches back to the previous image.
  `/opt/bitterbot/update.sh rollback` goes back by hand.
- **Fly.io:** `fly deploy` builds on the newest image. `fly releases` lists past
  releases; `fly deploy --image <previous image>` goes back to one.
- **Compose:** `docker compose pull && docker compose up -d`. To go back, set
  `BITTERBOT_IMAGE` to the previous version tag and run `up -d` again.

State lives on the volume, so updating or rolling back the image keeps memory,
sessions and settings.

## Network notes

- Port 9100 (P2P) is published on all interfaces in the templates and the
  Compose file. Docker publishes ports past host firewalls such as ufw; delete
  the port line if you want the agent off the mesh.
- Behind Caddy or the Fly proxy, every connection reaches the gateway from the
  proxy. Set `gateway.trustedProxies` to the proxy's address so rate limits and
  device records see the real client.
