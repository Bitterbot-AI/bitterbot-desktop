---
summary: "Advanced setup and development workflows for Bitterbot"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
title: "Setup"
---

# Setup

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For wizard details, see [Onboarding Wizard](/start/wizard).
</Note>

Last updated: 2026-01-01

## TL;DR

- **Tailoring lives outside the repo:** `~/.bitterbot/workspace` (workspace) + `~/.bitterbot/bitterbot.json` (config).
- **Stable workflow:** install via npm and use the onboarding wizard; let the service run the Gateway.
- **Bleeding edge workflow:** run the Gateway yourself via `pnpm gateway:watch`.

## Prereqs (from source)

- Node `>=22`
- `pnpm`
- Docker (optional; only for containerized setup/e2e — see [Docker](/install/docker))

## Tailoring strategy (so updates don’t hurt)

If you want “100% tailored to me” _and_ easy updates, keep your customization in:

- **Config:** `~/.bitterbot/bitterbot.json` (JSON/JSON5-ish)
- **Workspace:** `~/.bitterbot/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap once:

```bash
bitterbot setup
```

From inside this repo, use the local CLI entry:

```bash
bitterbot setup
```

If you don’t have a global install yet, run it via `pnpm bitterbot setup`.

## Run the Gateway from this repo

After `pnpm build`, you can run the packaged CLI directly:

```bash
node bitterbot.mjs gateway --port 19001 --verbose
```

## Stable workflow

1. Install Bitterbot via npm: `npm install -g bitterbot@latest`
2. Run the onboarding wizard: `bitterbot onboard --install-daemon`
3. Link surfaces (example: WhatsApp):

```bash
bitterbot channels login
```

4. Sanity check:

```bash
bitterbot health
```

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway with hot reload.

### 1) Start the dev Gateway

```bash
pnpm install && pnpm build
```

Then start the gateway and Control UI in two terminals:

```bash
# Terminal 1 — Gateway (auto-rebuilds on TS changes)
pnpm gateway:watch

# Terminal 2 — Control UI
cd desktop && pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) for the Bitterbot dashboard. The gateway runs on port 19001.

### 2) Verify

Via CLI:

```bash
bitterbot health
```

### Common footguns

- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:19001`; keep app + CLI on the same port.
- **Where state lives:**
  - Credentials: `~/.bitterbot/credentials/`
  - Sessions: `~/.bitterbot/agents/<agentId>/sessions/`
  - Logs: `/tmp/bitterbot/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.bitterbot/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file not yet supported)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.bitterbot/credentials/<channel>-allowFrom.json`
- **Model auth profiles**: `~/.bitterbot/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth import**: `~/.bitterbot/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.bitterbot/workspace` and `~/.bitterbot/` as “your stuff”; don’t put personal prompts/config into the `bitterbot` repo.
- Updating source: `git pull` + `pnpm install` (when lockfile changed) + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [Bitterbot assistant setup](/start/bitterbot)
