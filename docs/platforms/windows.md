---
summary: "Windows (WSL2) support + companion app status"
read_when:
  - Installing Bitterbot on Windows
  - Looking for Windows companion app status
title: "Windows (WSL2)"
---

# Windows (WSL2)

Bitterbot on Windows runs **inside WSL2** (Ubuntu recommended). The CLI and
the Gateway run in Linux, which keeps the runtime consistent and the tooling
compatible (Node, Linux binaries, skills). WSL2 itself is one command:
`wsl --install`. Without WSL2, use the [Docker](/platforms/docker) image with
Docker Desktop.

A native Windows install (and a Scheduled Task to run the gateway without
WSL) is not available yet; native companion apps are planned.

## Install with install.ps1 (WSL2)

In PowerShell (no administrator needed):

```powershell
irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex
```

The script finds your default WSL2 distribution, prints its plan, and runs the
[Linux installer](/start/install-script) inside it. Bitterbot then lives in
your Linux home (`~/.bitterbot`, on the ext4 filesystem); nothing on Windows
changes. Updates afterwards are `bitterbot update` inside WSL.

- No WSL distribution, or only WSL1: it prints how to enable WSL2
  (`wsl --install`, or `wsl --set-version <name> 2`) and the Docker Desktop
  alternative, and exits with code 2.
- Options need the saved script: `.\install.ps1 -Version 1.6.0 -NoOnboard`,
  `-Distro <name>`, `-Yes`, and `-WhatIf` to print the plan without running
  anything (piped into `iex`, set `$env:BITTERBOT_INSTALL_DRY_RUN = '1'`).
- Keep your files on the Linux side: clone a source checkout into your Linux
  home, not under `/mnt/c` (much slower, and file watching breaks).

More:

- [Getting Started](/start/getting-started) (use inside WSL)
- Official WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Inside WSL2:

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

## Advanced: expose WSL services over LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Example (PowerShell **as Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Allow the port through Windows Firewall (one-time):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Refresh the portproxy after WSL restarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notes:

- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use
  `bitterbot status --all` to confirm.
- Use `listenaddress=0.0.0.0` for LAN access; `127.0.0.1` keeps it local only.
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

## Step-by-step WSL2 install

### 1) Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### 2) Enable systemd (required for gateway install)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### 3) Install Bitterbot (inside WSL)

WSL is Linux, so the Linux paths work inside it. The
[installer](/start/install-script) (1.5.0 and later) is the short one; run it
inside WSL, or run `install.ps1` from PowerShell (above), which does the same:

```bash
curl -fsSL https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh | bash
```

For development, use a source checkout instead (in your Linux home):

```bash
cd ~
git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git
cd bitterbot-desktop
bash scripts/setup-deps.sh
pnpm install
pnpm build
pnpm bitterbot onboard --install-daemon
```

Without WSL, run the [Docker](/platforms/docker) image with Docker Desktop.

Full guide: [Getting Started](/start/getting-started)

## Windows companion app

We do not have a Windows companion app yet. Contributions are welcome if you want
contributions to make it happen.
