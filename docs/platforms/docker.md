---
summary: "Install and run Bitterbot with Docker Compose in one command, then Fly.io and a plain VPS for always-on hosting"
read_when:
  - First install, the recommended path
  - You want the agent running when your computer is off
  - Deploying Bitterbot to a server or Fly.io
  - Updating or rolling back a container install
title: "Docker (recommended install)"
---

# Docker (recommended install)

Docker is the recommended way to install Bitterbot: one command, no Node
toolchain, and every update is a `pull`. Run it on your own machine to try it,
or on a server so the agent keeps working (schedules, monitors, dreaming) while
your laptop sleeps.

## Start in one command

You need Docker with Compose v2 (Docker Desktop on macOS and Windows, or Docker
Engine on Linux). Download the compose file of the latest release into an empty
folder and start it:

```bash
mkdir bitterbot && cd bitterbot
curl -fsSLO https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/docker-compose.yml
docker compose up -d
```

<Note>
The compose file is attached to each release once that release's image is on
GHCR, starting with the first release after 1.4.0 (1.5.0). It needs image
1.5.0 or later. Until that release exists, clone the repository at a release
tag (`git clone --branch vX.Y.Z https://github.com/Bitterbot-AI/bitterbot-desktop.git`)
and use the [`docker run` form](#without-compose); do not take the compose file
from the `main` branch.
</Note>

Nothing needs editing. On first boot the gateway generates a gateway token,
saves it, and prints it once in its log together with a one-time setup link:

```bash
docker compose logs bitterbot-gateway
```

Look for the block that starts with `Bitterbot generated a gateway token`.

1. Open the setup link from that block
   (`http://127.0.0.1:19001/setup?token=...`; use your host port if you mapped
   a different one). It works once, for 30 minutes, only for setup, and only
   through the loopback port compose publishes. Setup asks for a model key
   (keys passed to the container's environment are offered by name and last
   four characters, never shown), the model, memory, web search, channels and
   P2P, then shows a first reply from your agent with its latency and a
   doctor summary. Same steps as `bitterbot onboard --no-browser`.
2. Link expired, or you came back later? Get a fresh one:

   ```bash
   docker compose exec -u node bitterbot-gateway node bitterbot.mjs onboard
   ```

3. Open the Control UI at [http://127.0.0.1:19001/](http://127.0.0.1:19001/)
   and paste the token. The first browser that signs in with the token is
   paired automatically (once, only while no device is paired, only for the
   Control UI). Every browser after that asks for approval from an
   already-paired one. Connect chat apps under **Channels**.

Lost the token? Print it again at any time:

```bash
docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token
```

(or use the value of `BITTERBOT_GATEWAY_TOKEN` if you set one: then no token is
generated and the command above prints nothing).

Run other CLI commands the same way. `-u node` is the only supported form: the
compose file starts the container as root (so the entrypoint can fix file
ownership), which makes a plain `docker compose exec` run as root too. Files a
root `exec` leaves in the data folder are handed back to `node` on the next
start. A one-off container works as well:
`docker compose run --rm bitterbot-cli doctor`.

## What the defaults are

| Setting                            | Default                                                        | Change it with                                  |
| ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Image                              | `ghcr.io/bitterbot-ai/bitterbot-desktop:1` (every 1.x release) | `BITTERBOT_IMAGE`                               |
| Data folder (config, memory, keys) | `./bitterbot-data` next to the compose file                    | `BITTERBOT_CONFIG_DIR`                          |
| Agent workspace                    | `<data folder>/workspace`                                      | `BITTERBOT_WORKSPACE_DIR`                       |
| Gateway token                      | generated on first boot, saved as `gateway.auth.token`         | `BITTERBOT_GATEWAY_TOKEN`                       |
| Control UI and API port            | `127.0.0.1:19001` (this machine only)                          | `BITTERBOT_BIND_HOST`, `BITTERBOT_GATEWAY_PORT` |
| P2P port                           | `127.0.0.1:9100` (see below)                                   | `BITTERBOT_P2P_BIND_HOST`, `BITTERBOT_P2P_PORT` |
| Restart policy                     | `unless-stopped`                                               | edit the file                                   |
| Healthcheck                        | the gateway answers on its own port                            | edit the file                                   |

Put overrides in a `.env` file next to `docker-compose.yml`; Compose reads it
automatically. For example, to keep using the data of an existing source
install:

```bash
# .env
BITTERBOT_CONFIG_DIR=/home/you/.bitterbot
```

Then `docker compose up -d` again. The gateway runs as uid 1000; a data folder
owned by another user must be readable and writable by uid 1000. On every start
the entrypoint hands **root-owned** entries in the data folder and the workspace
to uid 1000 (a folder Docker created for you, or files a root `exec` left
behind). Entries owned by any other uid, and other mounts inside the data
folder, are never touched. If that fails (a read-only, NFS `root_squash` or
Windows-shared folder) it prints a warning and starts anyway.

Once a token has been generated it lives in `bitterbot.json` and takes
precedence over `BITTERBOT_GATEWAY_TOKEN` (for the gateway and for CLI commands
run inside the container); the gateway logs a warning when the two differ. To
change it later, run `config set gateway.auth.token <new>` through the exec
command above and restart.

### Rootless Docker and Podman

Under rootless Docker or Podman, root inside the container is your own
unprivileged host user. The entrypoint detects the user namespace (a uid map
other than `0 0 4294967295`), changes no file ownership at all, and says so in
the log. It still drops to uid 1000 if that user can write the data folder;
otherwise it keeps running as the container's root, which is your host user,
so the files stay yours.

## Where your data lives, and backups

Everything the agent knows is in the data folder (`./bitterbot-data` unless you
changed it): `bitterbot.json` (settings, gateway token, keys you added),
`memory/*.sqlite` (long-term memory), the agent workspace (`MEMORY.md`,
`GENOME.md`, skills), sessions, and the P2P identity key. It is a plain folder on
your disk, so a backup is a copy of it. For a consistent copy of the SQLite
files, stop the gateway first:

```bash
docker compose stop
tar czf bitterbot-backup-$(date +%F).tgz bitterbot-data
docker compose start
```

The data folder holds secrets (the gateway token, model keys, the node's private
key). Keep backups private, and never commit the folder to git (the repository
ignores `bitterbot-data/`).

## Updating

```bash
docker compose pull && docker compose up -d
```

The `:1` tag moves to each new 1.x release; a new major version needs a
deliberate change of `BITTERBOT_IMAGE` after reading its release notes. The
Control UI's **Node Version** card checks GitHub for the newest release and
shows "image X.Y.Z available; pull to update" with this command; it cannot
update a container itself (the image is the code, so the next restart would
bring the old one back). Your data folder is untouched by updates.

To go back, set `BITTERBOT_IMAGE` to the previous version tag (for example
`ghcr.io/bitterbot-ai/bitterbot-desktop:1.5.0`) and run `docker compose up -d`.
The version must be 1.5.0 or later: older images have no entrypoint, and the
compose file names it explicitly so such an image fails to start instead of
running the gateway as root. To go further back, use the `docker run` form.

Do not use Watchtower or other auto-updaters: Watchtower is archived, and an
unattended update cannot roll back if the new image fails to start.

## Reaching it from other devices

The default binds the Control UI to `127.0.0.1`, so only this machine can open
it. Safer ways to reach it from elsewhere, in order:

1. **SSH tunnel:** `ssh -L 19001:127.0.0.1:19001 you@server`, then open
   `http://127.0.0.1:19001/` locally. Nothing new is exposed.
2. **Tailscale** or another private network, or a reverse proxy with HTTPS
   (Caddy, as in the VPS template below). Set `gateway.trustedProxies` to the
   proxy's address.
3. **Your LAN directly:** set `BITTERBOT_BIND_HOST=0.0.0.0` in `.env`. First
   make sure the token is long and random (the generated one is 48 hex
   characters; `openssl rand -hex 32` makes a new one). Anyone who can reach
   the port and has the token controls the agent, and Docker publishes ports
   past host firewalls such as ufw. Never publish the port to the internet
   without HTTPS in front of it.

## The P2P port

By default the P2P port is published on `127.0.0.1` only. The node still joins
the mesh: it dials out to the bootstrap and relay peers, and when nobody can
dial it directly it reserves a relay circuit, so other peers reach it through a
relay (and may upgrade to a direct connection by hole punching). What you lose
is direct inbound dials: peers that cannot use a relay, and the extra capacity
a directly reachable node adds. On a machine behind a home router that is
usually nothing, because the port was not reachable from outside anyway.

On a server with a public IP, or with a port forward to 9100, set
`BITTERBOT_P2P_BIND_HOST=0.0.0.0` in `.env` to accept direct inbound peers. To
leave the mesh entirely, set `p2p.enabled: false` in `bitterbot.json` (or
Settings → P2P). Every connection the node makes is listed in
[What this node connects to](/network/egress).

## The image

`ghcr.io/bitterbot-ai/bitterbot-desktop` is published for `linux/amd64` and
`linux/arm64` on every release, tagged `latest`, the full version (`X.Y.Z`),
`X.Y`, `X` and `sha-<commit>`.

| Path in the container   | What it holds                             |
| ----------------------- | ----------------------------------------- |
| `/home/node/.bitterbot` | Config, memory, sessions, keys. Mount it. |
| Port `19001`            | Gateway API and the Control UI            |
| Port `9100`             | P2P mesh                                  |

The image runs as the `node` user (uid 1000) and sets
`BITTERBOT_INSTALL_KIND=container`, which tells the gateway to look for new
images on GitHub instead of updating itself. A gateway started without any
config file uses the same defaults as an empty one (P2P on, circles on).

What is in the image, and what is not:

- The P2P orchestrator binary ships inside the image (fetched at build time
  from the matching `orchestrator-v*` release, SHA-256 checked, and
  signature-verified once the release key is pinned; see
  [LIMITATIONS.md](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/LIMITATIONS.md)),
  so the node joins the mesh without a Rust toolchain. Images 1.0.0 through
  1.4.0 did not carry it and ran isolated.
- Chromium is **not** in the image (the Playwright package is, without
  browser binaries). The `browser` tool is unavailable in a container; use
  the sandboxed browser image
  (`scripts/sandbox-browser-setup.sh`, see [Sandboxing](/gateway/sandboxing))
  or run the browser tool from a source install.

### Without Compose

The same image with `docker run` and explicit settings, for scripts and other
orchestrators:

```bash
export BITTERBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
docker run -d --name bitterbot --restart unless-stopped \
  -p 127.0.0.1:19001:19001 -p 127.0.0.1:9100:9100 \
  -v "$HOME/.bitterbot:/home/node/.bitterbot" \
  -e BITTERBOT_GATEWAY_TOKEN -e BITTERBOT_BOOTSTRAP_PAIRING=1 \
  ghcr.io/bitterbot-ai/bitterbot-desktop:1 \
  node bitterbot.mjs gateway --allow-unconfigured --bind lan --port 19001
```

Create the folder first (`mkdir -p ~/.bitterbot`) so Docker does not create it
owned by root; on Linux it must be writable by uid 1000, the container user.

### Build the image locally

`docker-setup.sh` in the repository root builds a local image
(`bitterbot:local`) from your checkout, writes a `.env` that points the compose
file at it (and at `~/.bitterbot`), runs the terminal onboarding wizard in the
CLI container, and starts the gateway with Compose. Use it to run unreleased
changes; for a release, use the published image above.

## Fly.io

`deploy/fly/` holds a Fly app: an always-on machine, a volume for state, HTTPS on
`<app>.fly.dev`, and the P2P port published publicly (a Fly machine has a
public address, so direct inbound peers work).

```bash
cd deploy/fly
fly launch --copy-config --no-deploy --name <your-app>
fly volumes create bitterbot_data --size 3
fly secrets set BITTERBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

Keep the token you set: it is how you sign in (the template sets it as a
secret, so no token is generated). Machines do not auto-stop, since a stopped
agent cannot run its schedules.

## A plain VPS

`deploy/vps/cloud-init.yaml` sets up an Ubuntu or Debian server: Docker, the
gateway as a systemd service, a generated token in `/root/bitterbot-token.txt`,
and an update script. Paste it as the server's user data when you create it.
Unlike the compose file above, it publishes the P2P port on all interfaces,
because a VPS has a public IP.

- With a domain: set `BITTERBOT_DOMAIN` in `/opt/bitterbot/settings.env` (before
  first boot, or later followed by `systemctl restart bitterbot`) to a name that
  points at the server. Caddy serves the Control UI on that name over HTTPS.
- Without one: the gateway listens on `127.0.0.1` only. Reach it through SSH:
  `ssh -L 19001:127.0.0.1:19001 root@<server>`, then open
  `http://127.0.0.1:19001`.

## Updates and rollback on Fly and VPS

- **VPS:** `/opt/bitterbot/update.sh` pulls the image, restarts, and waits for the
  gateway to answer. If it does not, it switches back to the previous image.
  `/opt/bitterbot/update.sh rollback` goes back by hand.
- **Fly.io:** `fly deploy` rebuilds on `latest`; a cached builder can reuse an
  older `latest`, so pin a version with
  `fly deploy --build-arg BITTERBOT_IMAGE=ghcr.io/bitterbot-ai/bitterbot-desktop:X.Y.Z`
  (or add `--no-cache`). `fly releases` lists past
  releases; `fly deploy --image <previous image>` goes back to one.

State lives on the volume, so updating or rolling back the image keeps memory,
sessions and settings.

## Upgrading from the older compose file

The compose file shipped in the repository with 1.4.x and earlier required `BITTERBOT_CONFIG_DIR`,
`BITTERBOT_WORKSPACE_DIR` and `BITTERBOT_GATEWAY_TOKEN`. If you set them, they
still win, so nothing moves. Two defaults changed:

- The P2P port is now published on `127.0.0.1` instead of all interfaces. If
  your host has a public IP or a port forward to 9100, add
  `BITTERBOT_P2P_BIND_HOST=0.0.0.0` to `.env` to keep accepting direct inbound
  peers.
- The default image tag is `:1` instead of `:latest`, and the file needs image
  1.5.0 or later (it starts the container as root and names the image's
  entrypoint, which drops to uid 1000; an older image refuses to start).
- `docker compose exec` now runs as root unless you pass `-u node`; always pass
  it.
