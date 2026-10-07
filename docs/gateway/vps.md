---
summary: "VPS hosting hub for Bitterbot (Fly/Hetzner/GCP/exe.dev)"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: "VPS Hosting"
---

# VPS hosting

This hub links to the supported VPS/hosting guides and explains how cloud
deployments work at a high level.

## Pick a provider

Two setups ship with the repository; both are covered in
[Docker and always-on hosting](/platforms/docker):

- **Fly.io**: `deploy/fly/` (always-on machine, volume, HTTPS).
- **Any Ubuntu or Debian VPS** (Hetzner, DigitalOcean, AWS, GCP and so on):
  `deploy/vps/cloud-init.yaml` (Docker, systemd service, optional HTTPS through
  Caddy, update with rollback).

Other hosts that run a container image (`ghcr.io/bitterbot-ai/bitterbot-desktop`)
work too, but have no template.

## How cloud setups work

- The **Gateway runs on the VPS** and owns state + workspace.
- You connect from your laptop/phone via the **Control UI** or **Tailscale/SSH**.
- Treat the VPS as the source of truth and **back up** the state + workspace.
- Secure default: keep the Gateway on loopback and access it via SSH tunnel or Tailscale Serve.
  If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Remote access: [Gateway remote](/gateway/remote)  
Platforms hub: [Platforms](/platforms)

## Using nodes with a VPS

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
