---
summary: "Platform support overview (Gateway)"
read_when:
  - Looking for OS support or install paths
  - Deciding where to run the Gateway
title: "Platforms"
---

# Platforms

Bitterbot core is written in TypeScript. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native companion apps for Windows are planned; the Gateway is recommended via WSL2.
Linux and Windows are fully supported today.

## Choose your OS

- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & hosting

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## Common links

- Install guide: [Getting Started](/start/getting-started)
- Gateway runbook: [Gateway](/gateway)
- Gateway configuration: [Configuration](/gateway/configuration)
- Service status: `bitterbot gateway status`

## Gateway service install (CLI)

Use one of these (all supported):

- Wizard (recommended): `bitterbot onboard --install-daemon`
- Direct: `bitterbot gateway install`
- Configure flow: `bitterbot configure` → select **Gateway service**
- Repair/migrate: `bitterbot doctor` (offers to install or fix the service)

The service target depends on OS:

- Linux/WSL2: systemd user service (`bitterbot-gateway[-<profile>].service`)
