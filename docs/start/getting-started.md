---
summary: "Get Bitterbot installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting Started"
---

# Getting Started

Goal: go from zero to a first working chat with minimal setup.

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `bitterbot dashboard`
and chat in the browser, or open `http://127.0.0.1:19001/` on the
<Tooltip headline="Gateway host" tip="The machine running the Bitterbot gateway service.">gateway host</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## Pick a path

1. **Docker (recommended for servers):** one command, nothing to install but
   Docker, updates are a `pull`. Follow [Docker (recommended install)](/platforms/docker).
2. **Installer (laptops):** a signed, prebuilt release for Linux x64/arm64 and
   Apple-silicon macOS, with its own Node runtime, from release 1.5.0 on.
   See [Installer (laptops)](/start/install-script) for what it verifies.
3. **From source (below):** for developing Bitterbot, or when you need the
   browser tool in a container setup (the image ships without Chromium).
4. **npm:** not yet. There is no npm package today.

With Docker, the whole install is:

```bash
mkdir bitterbot && cd bitterbot
curl -fsSLO https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/docker-compose.yml
docker compose up -d
docker compose logs bitterbot-gateway   # shows a one-time setup link and the token
```

Open the setup link from the log (`http://127.0.0.1:19001/setup?token=...`,
valid 30 minutes, works once) and finish setup in the browser: model key,
model, memory, web search, channels, P2P, then a first reply from your agent
with its latency. Link expired? Get a new one with
`docker compose exec -u node bitterbot-gateway node bitterbot.mjs onboard`.
Afterwards the Control UI is `http://127.0.0.1:19001/`; it asks for the token
printed in the same log. The token is printed once; read it again any time with
`docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token`
(or use the value of `BITTERBOT_GATEWAY_TOKEN` if you set one). (The compose file is
attached to releases from 1.5.0 on; before that, follow the `docker run` form
on the [Docker page](/platforms/docker#without-compose).)

With the installer, the whole install is:

```bash
curl -fsSL https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh | bash
```

It prints its plan, verifies the release's minisign signature (with
`minisign` or OpenSSL 3; otherwise it says it checked SHA-256 only), unpacks
to `~/.bitterbot/app/<version>`, links `~/.local/bin/bitterbot`, and runs
`bitterbot onboard`, which starts the gateway and opens a one-time setup page
in your browser (`--no-browser` keeps setup in the terminal). To check a download by hand: `minisign -Vm checksums.txt`
with the key on the [installer page](/start/install-script#verify-a-download-yourself),
or `gh attestation verify <tarball> --repo Bitterbot-AI/bitterbot-desktop`.
Later, `bitterbot update` updates it in place (verified, with a snapshot of
your data and an automatic rollback; see
[Updating](/start/install-script#updating)). On Windows, `install.ps1` runs the
same installer inside WSL2 ([Windows](/start/install-script#windows-wsl2)).

## Prereqs (source install)

- Node 22.12 or newer
- pnpm — ships with Node via corepack: `corepack enable pnpm || npm install -g pnpm`

<Tip>
Check your Node version with `node --version` if you are unsure.
</Tip>

## Quick setup from source (CLI)

<Steps>
  <Step title="Install Bitterbot (from source)">
    No pnpm yet? It ships with Node via corepack:
    `corepack enable pnpm || npm install -g pnpm`

    ```bash
    git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git
    cd bitterbot-desktop
    bash scripts/setup-deps.sh   # system deps: ffmpeg, ripgrep, ...
    pnpm install
    pnpm exec playwright install --with-deps chromium   # browser automation
    ```

    <Note>
    There is no npm package yet. Without a source checkout, use the
    [installer](/start/install-script) on a laptop or the container image on a
    server (see [Docker (recommended install)](/platforms/docker)).
    On Windows, use Docker Desktop, or WSL2 with the checkout on the Linux
    filesystem (`~`), not `/mnt/c`; boot is dramatically faster there.
    </Note>

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    pnpm bitterbot onboard --install-daemon
    ```

    The wizard configures auth, gateway settings, and optional channels, and
    installs the gateway service. Without `--install-daemon`,
    `pnpm bitterbot onboard` starts the gateway and finishes setup on a
    one-time page in your browser instead. See
    [Onboarding Wizard](/start/wizard) for details.

  </Step>
  <Step title="Check the Gateway">
    If you installed the service, it should already be running:

    ```bash
    pnpm bitterbot gateway status
    ```

    (All `bitterbot` commands run as `pnpm bitterbot …` from the repo; run
    `pnpm link --global` once if you want a bare `bitterbot` on your PATH.)

  </Step>
  <Step title="Open the Control UI">
    ```bash
    pnpm bitterbot dashboard
    ```
  </Step>
</Steps>

<Check>
If the Control UI loads, your Gateway is ready for use.
</Check>

## Run the Control UI

The gateway serves the Control UI itself: one process, one port. Start it the
way your install starts it: `docker compose up -d` (Docker), `bitterbot gateway`
(installer), or from a source checkout:

```bash
pnpm start gateway
```

Open [http://127.0.0.1:19001](http://127.0.0.1:19001) in your browser to chat, view dreams, manage skills, and monitor the agent. (Developing the UI itself? `pnpm dev:all` runs the gateway plus a hot-reload Vite server on 5173 — dev only.)

## Optional extras

<AccordionGroup>
  <Accordion title="Send a test message">
    Requires a configured channel.

    ```bash
    bitterbot message send --target +15555550123 --message "Hello from Bitterbot"
    ```

  </Accordion>
</AccordionGroup>

## P2P network

Bitterbot joins a decentralized P2P mesh for skill trading, reputation, and bounties. The orchestrator listens on **TCP port 9100** by default.

<Tip>
Port 9100 open (inbound TCP) gives the best P2P performance, but is **not required**. Nodes behind NAT or firewalls automatically use circuit relay through the bootstrap node — no manual configuration needed.
</Tip>

See [P2P configuration](/gateway/configuration-reference#p2p-network) for relay mode, security, and advanced options.

## Useful environment variables

If you run Bitterbot as a service account or want custom config/state locations:

- `BITTERBOT_HOME` sets the home directory used for internal path resolution.
- `BITTERBOT_STATE_DIR` overrides the state directory.
- `BITTERBOT_CONFIG_PATH` overrides the config file path.

Full environment variable reference: [Environment vars](/help/environment).

## Go deeper

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Full CLI wizard reference and advanced options.
  </Card>
</Columns>

## What you will have

- A running Gateway
- Auth configured
- Control UI access or a connected channel

## Next steps

- DM safety and approvals: [Pairing](/channels/pairing)
- Connect more channels: [Channels](/channels)
- Advanced workflows and from source: [Setup](/start/setup)
