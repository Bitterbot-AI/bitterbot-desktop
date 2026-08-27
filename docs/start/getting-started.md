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

## Prereqs

- Node 22 or newer
- pnpm — ships with Node via corepack: `corepack enable pnpm || npm install -g pnpm`

<Tip>
Check your Node version with `node --version` if you are unsure.
</Tip>

## Quick setup (CLI)

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
    There is no npm package or hosted installer yet — installing from source is
    the supported path today. On Windows, use WSL2 and keep the checkout on the
    Linux filesystem (`~`), not `/mnt/c` — boot is dramatically faster there.
    </Note>

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    pnpm bitterbot onboard --install-daemon
    ```

    The wizard configures auth, gateway settings, and optional channels.
    See [Onboarding Wizard](/start/wizard) for details.

  </Step>
  <Step title="Check the Gateway">
    If you installed the service, it should already be running:

    ```bash
    bitterbot gateway status
    ```

  </Step>
  <Step title="Open the Control UI">
    ```bash
    bitterbot dashboard
    ```
  </Step>
</Steps>

<Check>
If the Control UI loads, your Gateway is ready for use.
</Check>

## Run the Control UI

Bitterbot requires two processes: the gateway (backend) and the Control UI (frontend).

```bash
# Terminal 1 — Gateway
pnpm gateway:watch

# Terminal 2 — Control UI
cd desktop && pnpm dev
```

Open [http://127.0.0.1:19001](http://127.0.0.1:19001) in your browser to chat, view dreams, manage skills, and monitor the agent. The gateway serves the Control UI directly — one process, one port.

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
