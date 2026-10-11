---
summary: "Install Bitterbot on a laptop with the one-line installer: what it downloads, what it verifies, where it puts things, and how to check it yourself."
read_when:
  - You want Bitterbot on a Linux or macOS laptop without Docker or a source checkout
  - You want to know what install.sh verifies before trusting it
  - You need to update, pin, or remove an installer-based install
title: "Installer (laptops)"
---

# Installer (laptops)

For a laptop or desktop, the installer is the shortest path: it downloads a
prebuilt, signed release for your machine and needs nothing installed first
(no Node, no pnpm, no compiler). For an always-on server, use
[Docker](/platforms/docker) instead.

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash
```

<Note>
Release tarballs and `install.sh` are attached to releases from **1.5.0** on.
Until that release is out, the URL above returns 404; use
[Docker](/platforms/docker) or a [source install](/start/getting-started#quick-setup-from-source-cli).
</Note>

Read the script before running it (it is short and commented):

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | less
```

## Supported machines

| Platform                 | Installer | Otherwise                                    |
| ------------------------ | --------- | -------------------------------------------- |
| Linux x64 (glibc)        | yes       |                                              |
| Linux arm64 (glibc)      | yes       |                                              |
| macOS, Apple silicon     | yes       |                                              |
| macOS, Intel             | no        | [Docker Desktop](/platforms/docker)          |
| Linux with musl (Alpine) | no        | [Docker](/platforms/docker)                  |
| Windows                  | no        | [Docker Desktop or WSL2](/platforms/windows) |

On an unsupported machine the installer stops before downloading anything and
points at Docker.

## What it does

The installer prints this plan and asks before acting (`--yes` skips the
question):

1. Detects your OS and CPU.
2. Downloads `checksums.txt`, `checksums.txt.minisig` and
   `bitterbot-<version>-<os>-<arch>.tar.gz` from the GitHub release.
3. Verifies them (see below). Any failure stops the install with nothing
   changed.
4. Unpacks to `~/.bitterbot/app/<version>/`, points `~/.bitterbot/app/current`
   at it, keeps the version you had before (`~/.bitterbot/app/previous`), and
   removes anything older than that.
5. Links `~/.local/bin/bitterbot`. If `~/.local/bin` is not on your `PATH`, it
   prints the line to add to your shell profile.
6. Runs `bitterbot onboard` (skip with `--no-onboard`).

Your config, memory database and keys live in `~/.bitterbot` and are never
touched by the installer.

Each tarball contains the built gateway and Control UI, its production
dependencies for that platform, the P2P orchestrator binary, an official
Node.js 22 LTS runtime (used only by Bitterbot), a `bin/bitterbot` launcher,
and a `manifest.json` listing the SHA-256 of every file.

## Options

```bash
curl -fsSL .../install.sh | bash -s -- --version 1.5.0 --no-onboard
```

- `-s`, `--version X.Y.Z`: install that release instead of the latest.
- `--dir PATH`: install root (default `~/.bitterbot/app`).
- `--no-onboard`: skip `bitterbot onboard`.
- `-y`, `--yes`: do not ask for confirmation.
- `--with-browser`: Linux only; also downloads Playwright's Chromium (about
  170 MB) into `~/.bitterbot/browsers` for the browser tool. On macOS the
  browser tool uses an installed Chrome, Brave or Edge.
- `--require-signature`: refuse to install unless the signature can be checked
  (needs `minisign` or OpenSSL 3).

## What gets verified

Every release's `checksums.txt` lists the SHA-256 of each tarball, each
manifest and `install.sh`, and is signed with minisign. The public key is
written into the installer (the same key that signs the orchestrator
releases):

```text
RWTU9k8zQeEQA5GbldCYMA7kgR3nwoLbtjhw5FWMGiwu+h72OMk2Ne04
```

The installer picks the strongest check your machine can do and prints which
one it used:

| Your machine has                     | What is checked                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `minisign`                           | minisign signature against the pinned key, then the tarball's SHA-256               |
| OpenSSL 3 (most current Linux)       | the same minisign signature, checked with OpenSSL, then SHA-256                     |
| neither (stock macOS ships LibreSSL) | SHA-256 only, from `checksums.txt` fetched over HTTPS; the signature is NOT checked |

In the first two cases the signed comment must read `v<version> checksums`
for the exact version being installed, so a signature copied from another
release is refused. A missing `.minisig` is always a refusal. If `gh` is
installed and logged in, the installer also runs
`gh attestation verify` on the tarball (GitHub's build-provenance record of the
workflow run that built it).

For signature verification on a Mac, install minisign first
(`brew install minisign`), or pass `--require-signature` so the installer
stops instead of falling back to SHA-256 only.

## Verify a download yourself

```bash
V=1.5.0
B=https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/v$V
curl -fsSLO $B/checksums.txt -O $B/checksums.txt.minisig -O $B/bitterbot-$V-linux-x64.tar.gz
minisign -Vm checksums.txt -P RWTU9k8zQeEQA5GbldCYMA7kgR3nwoLbtjhw5FWMGiwu+h72OMk2Ne04
sha256sum -c --ignore-missing checksums.txt     # macOS: shasum -a 256 -c --ignore-missing
gh attestation verify bitterbot-$V-linux-x64.tar.gz --repo Bitterbot-AI/bitterbot-desktop
```

`minisign` prints the trusted comment; it must be `v1.5.0 checksums` for
1.5.0.

## Updating

Re-run the installer. It installs the new version next to the current one,
switches `current` over, and keeps the old version in
`~/.bitterbot/app/previous`. `bitterbot update status` and the Control UI's
Update card tell you when a newer release exists (they check GitHub releases,
not npm); `bitterbot update` and the UI's update button do not update an
installer-based install in place yet, and say so. Restart the gateway after
updating (`bitterbot gateway restart`, or stop and start it).

To go back one version by hand:

```bash
cd ~/.bitterbot/app && ln -sfn "$(readlink previous)" current
```

## Uninstall

```bash
rm -rf ~/.bitterbot/app ~/.local/bin/bitterbot
```

This leaves your data in `~/.bitterbot`; remove that directory too only if you
want to delete your config, memory and keys.

## Troubleshooting

- `could not download .../checksums.txt`: the release is still being
  published (the tarballs are attached a few minutes after the release
  appears). Wait, or pin the previous release with `--version`.
- `signature is INVALID` or `SHA-256 mismatch`: do not work around it. Report
  it with the full output at
  [GitHub issues](https://github.com/Bitterbot-AI/bitterbot-desktop/issues).
- `bitterbot: command not found`: add `~/.local/bin` to your `PATH` (the
  installer printed the line), or run `~/.bitterbot/app/current/bin/bitterbot`.
