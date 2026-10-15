---
summary: "Install Bitterbot on a laptop with the one-line installer: what it downloads, what it verifies, where it puts things, and how to check it yourself."
read_when:
  - You want Bitterbot on a Linux or macOS laptop without Docker or a source checkout
  - You want to know what install.sh verifies before trusting it
  - You need to update, roll back, pin, or remove an installer-based install
  - You are installing over a git clone or an older Bitterbot that is running
  - You are on Windows and want the WSL2 installer (install.ps1)
title: "Installer (laptops)"
---

# Installer (laptops)

For a laptop or desktop, the installer is the shortest path: it downloads a
prebuilt, signed release for your machine and needs nothing installed first
(no Node, no pnpm, no compiler). For an always-on server, use
[Docker](/platforms/docker) instead. Already running Node 22.12 or newer?
[`npm install -g bitterbot`](/start/npm) works too.

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash
```

The script is the copy attached to the latest release, listed in that
release's signed `checksums.txt` and published only after the release is
approved; it then installs the newest release that is completely published
and signed, and carries the release signing key inside it. Right after a new
release is created there can be a short window where this URL is not
available yet: retry in a few minutes, or use a versioned URL. Every release
attaches its own copy of `install.sh`; use it to pin both the script and the
release:

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/v1.6.0/install.sh | bash -s -- --version 1.6.0
```

Read the script before running it (it is short and commented):

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | less
```

Already installed? Run `bitterbot update` (see [Updating](#updating)), or run
the same one-liner again: it installs the new release next to the old one and
switches a running gateway over (see
[Upgrading from a git clone or an older version](#upgrading-from-a-git-clone-or-an-older-version)).

## Supported machines

| Platform                  | Installer | Otherwise                              |
| ------------------------- | --------- | -------------------------------------- |
| Linux x64 (glibc 2.28+)   | yes       |                                        |
| Linux arm64 (glibc 2.28+) | yes       |                                        |
| macOS, Apple silicon      | yes       |                                        |
| macOS, Intel              | no        | [Docker Desktop](/platforms/docker)    |
| Linux with musl (Alpine)  | no        | [Docker](/platforms/docker)            |
| Windows                   | via WSL2  | [install.ps1](#windows-wsl2) or Docker |

On an unsupported machine the installer stops before downloading anything and
points at Docker. glibc 2.28 is the floor of the bundled Node 22 (Debian 10,
Ubuntu 18.10, RHEL 8 and later). The installer also refuses to run as root:
Bitterbot runs as your user (`--allow-root` overrides this).

## What it does

The installer prints this plan and asks before acting, `Proceed? [Y/n]`
(Enter means yes; `--yes` skips the question):

1. Detects your OS and CPU.
2. Without `--version`, asks the GitHub releases API for the newest release
   that has your platform's tarball, `checksums.txt` and
   `checksums.txt.minisig` (a release still being built is skipped), then
   downloads those three files from `releases/download/v<version>/`.
3. Verifies them (see below). Any failure stops the install with nothing
   changed.
4. Unpacks to `~/.bitterbot/app/<version>/`, points `~/.bitterbot/app/current`
   at it, keeps the version you had before (`~/.bitterbot/app/previous`), and
   removes anything older than that, except a version a running Bitterbot
   still uses (each launch leaves its pid in `<version>/.pids`).
5. Links `~/.local/bin/bitterbot` (the plan says so if it replaces a link to
   something else). If `~/.local/bin` is not on your `PATH`, it prints the line
   to add to your shell profile, and it warns when another `bitterbot` comes
   first on your `PATH`.
6. If an older Bitterbot is running (a git clone started with `pnpm start
   gateway`, an older release) or set up as a background service, shows what
   it found and asks once whether to switch it to the new version (default
   yes). See
   [Upgrading from a git clone or an older version](#upgrading-from-a-git-clone-or-an-older-version).
   On a fresh machine there is no extra question.
7. Runs `bitterbot onboard` (skip with `--no-onboard`). It starts the gateway
   and opens a setup page in your browser
   (`http://127.0.0.1:19001/setup?token=...`, valid 30 minutes); without a
   browser it prints the link. `bitterbot onboard --no-browser` runs the same
   steps in the terminal. When Bitterbot is already set up, it prints the
   Control UI address instead. See [`bitterbot onboard`](/cli/onboard).

Your config, memory database and keys live in `~/.bitterbot` and are never
touched by the installer. It only makes that directory private to you: a
default mode (755, 775 or 777) becomes 700, and any other mode only loses the
"other users" bits, so deliberate group sharing keeps working. Only the
directory itself changes, never the files in it, and never when it is your
home directory, `/`, or owned by someone else. The gateway and
`bitterbot onboard` check the same on start and print one line when they
change something; `bitterbot doctor` flags a state directory other users can
open (not inside Docker, where the data folder is often shared with the host). Set `BITTERBOT_STATE_DIR_PERMS=keep` to leave its permissions alone.

Each tarball contains the built gateway and Control UI, its production
dependencies for that platform, the P2P orchestrator binary, an official
Node.js 22 LTS runtime (used only by Bitterbot), a `bin/bitterbot` launcher,
and a `manifest.json` listing the SHA-256 of every file. Expect a download of
about 390 MB (1.5 GB unpacked). GPU builds of llama.cpp are not included:
local embeddings run on the CPU, which is enough for the small embedding
model.

## Options

```bash
curl -fsSL .../install.sh | bash -s -- --version 1.6.0 --no-onboard
```

- `-s`, `--version X.Y.Z`: install that release instead of the newest
  complete one.
- `--dir PATH`: install root (default `~/.bitterbot/app`; a relative path is
  taken from the current directory).
- `--no-onboard`: skip `bitterbot onboard`.
- `--no-switch`: leave a running older Bitterbot (and its background service)
  alone.
- `-y`, `--yes`: do not ask for confirmation. This also switches a running
  older Bitterbot to the new version without asking.
- `--with-browser`: Linux only; also downloads Playwright's Chromium (about
  170 MB) into `~/.bitterbot/browsers` for the browser tool. On macOS the
  browser tool uses an installed Chrome, Brave or Edge.
- `--require-signature`: refuse to install unless the signature can be checked
  (needs `minisign` or OpenSSL 3).
- `--allow-root`: allow installing as root (not recommended).

## Upgrading from a git clone or an older version

If you already run Bitterbot, run the installer the same way. Your config,
memory and keys in `~/.bitterbot` are shared by every install and stay exactly
as they are; only the code that runs changes.

After installing, the installer checks what runs today and tells you, for
example:

```text
Found Bitterbot 1.5.0 from ~/bitterbot-desktop (git clone) running on port 19001.
This is Bitterbot 1.6.0 (~/.bitterbot/app/1.6.0).
Switch to 1.6.0 now? [Y/n]
```

Answering yes (or passing `--yes`) runs `bitterbot gateway switch`, which:

1. Takes a safety snapshot of your settings and memory first, the same one
   `bitterbot update` takes (see [Snapshots](#snapshots)). If that is not
   possible (for example the disk is full), nothing is changed.
2. Stops the old gateway: through its service manager when the background
   service runs it, otherwise with a normal stop signal to that process. It
   only ever stops a process that is a Bitterbot gateway (and checks it is
   still the same process right before); anything else on the port is
   reported and left alone. It waits until the port is free and the P2P
   orchestrator has exited.
3. If the old gateway ran from a git clone with its own `.env` file, copies
   the keys that `~/.bitterbot/.env` does not have yet into it. Existing keys
   are never changed, the clone's file is only read, `~/.bitterbot/.env` is
   backed up first (`.env.bak-<time>`), and only key names are printed:

   ```text
   Will copy 9 keys from ~/bitterbot-desktop/.env into ~/.bitterbot/.env (existing keys are kept; a backup is made first): OPENAI_API_KEY, ...
   ```

   Settings the old gateway had only in its shell environment are named in a
   warning so you can add them.

4. Points the background service at the new version (the same as
   `bitterbot gateway install --force`, keeping the old service's environment
   and its `EnvironmentFile=` lines) and starts it. Without a background
   service, it installs one (systemd user service, macOS LaunchAgent or
   Windows scheduled task), so Bitterbot keeps running and starts on login.
   Where no service manager exists (for example WSL without systemd), or the
   service manager refuses a new service, the new gateway is started in the
   background instead, logging to `~/.bitterbot/logs/gateway-switch.log`;
   run `bitterbot gateway install` later to have it start on login.
5. Waits until the new version answers on the gateway port and stays up. A
   first start can take a few minutes while memory is upgraded: it prints
   progress, and keeps waiting as long as the new gateway is alive (it asks
   in a terminal after 5 minutes, and gives up after 20 minutes otherwise).
6. If the new version exits or never answers, puts the old one back: the old
   service file exactly as it was, or the old gateway restarted from where it
   ran before once it has fully stopped (for a release-to-release switch,
   `~/.bitterbot/app/current` points back at the old version too, and
   `previous` and older versions are left as they were). Memory databases the
   new version upgraded past what the old one reads are restored from the
   snapshot. The `.env` keys copied in step 3 stay (they only add settings).
   The installer then exits with an error and says what is running.

A stopped background service that runs another install is left stopped; the
installer says how to point it at the new version (`bitterbot gateway install
--force`). If the old gateway uses a different state directory, profile or
port than the new one would, nothing is switched and the installer says why.

When it is done:

```text
Done. Bitterbot 1.6.0 is running on port 19001. Your settings and memory are unchanged.
Your git clone at ~/bitterbot-desktop is no longer used. You can delete it once you are happy with 1.6.0 (nothing was deleted).
```

The clone is never deleted for you. Without a terminal to ask on (and without
`--yes`), nothing is stopped and the installer prints the command to run.
`--no-switch` skips the check entirely. With a remote gateway
(`gateway.mode` is `remote`) there is nothing to switch; when another program
uses the gateway port, the installer says so and leaves it alone.

You can run the same check and switch yourself at any time:

```bash
bitterbot gateway switch --check   # report only (exit 10 when a switch is available)
bitterbot gateway switch           # asks once, then switches
bitterbot gateway switch --yes     # no question (scripts)
```

`bitterbot onboard` and the setup page do the same check: `onboard` never
links to a gateway from another install (it offers the switch instead), and
the setup page's **Keep running** step offers **Use this version for the
background service** when the installed service still runs another install.

A foreground gateway whose origin cannot be determined is not stopped (it
could not be restarted if the switch failed). Stop it yourself (Ctrl+C in its
terminal), then run `bitterbot gateway switch`.

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

In the last case the installer ends with "Checked against checksums.txt from
the same server (no signature)" instead of "Verified".

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
V=1.6.0
B=https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/v$V
curl -fsSLO $B/checksums.txt -O $B/checksums.txt.minisig -O $B/bitterbot-$V-linux-x64.tar.gz
minisign -Vm checksums.txt -P RWTU9k8zQeEQA5GbldCYMA7kgR3nwoLbtjhw5FWMGiwu+h72OMk2Ne04
sha256sum -c --ignore-missing checksums.txt     # macOS: shasum -a 256 -c --ignore-missing
gh attestation verify bitterbot-$V-linux-x64.tar.gz --repo Bitterbot-AI/bitterbot-desktop
```

`minisign` prints the trusted comment; it must be `v1.6.0 checksums` for
1.6.0.

## Updating

```bash
bitterbot update            # newest complete release
bitterbot update --check    # only say whether a newer release exists
bitterbot update --tag 1.6.0
```

The Control UI's **Update now** button does the same. Updates follow the
stable channel (published, non-prerelease releases). Step by step:

1. **Pick the target**: the newest release that has your platform's tarball,
   `checksums.txt` and its signature (the rule the installer uses), or the
   version you pinned. Already on it: nothing happens. A downgrade asks first
   (`--yes` confirms).
2. **Verify**: `checksums.txt.minisig` must verify against the pinned key,
   its signed comment must read `v<version> checksums`, and the tarball's
   SHA-256 must match. Unlike the installer there is no "SHA-256 only" level:
   Bitterbot checks the signature itself (Node.js has Ed25519), so the update
   stops on any failure.
3. **Stage**: unpack into a temporary directory next to the install, then
   check every file against `manifest.json`.
4. **Check the new version** with its own launcher: `bin/bitterbot --version`
   must print the target version, and `bin/bitterbot update preflight` (it
   changes no config or data) must accept this machine. It refuses when your config file fails the
   new version's schema, or when a memory database carries a newer schema than
   the new version knows (a downgrade past a migration). Databases that only
   need forward migrations are fine: the new version migrates them on start.
5. **Snapshot** your data (below).
6. **Activate**: move the new version to `~/.bitterbot/app/<version>`, point
   `previous` at the version you had and `current` at the new one (each switch
   is one atomic rename of a symlink), and remove older versions except one a
   running Bitterbot still uses.
7. **Restart and watch**: with a gateway service installed, the service is
   restarted; with a gateway running in a terminal (or under `nohup`), it is
   asked to restart itself into the new version; with no gateway running,
   `bitterbot update` says how to start it. The update then waits until the new
   version confirms a healthy start. If it does not (the process exits, or
   nothing confirms within five minutes or three times the last measured
   start, whichever is longer, at most 30 minutes; three times that, at most
   90 minutes, when the new version migrates memory databases on its first
   start), a watchdog switches back automatically.

Nothing is activated if any step before 6 fails, and the version you were
running stays in `~/.bitterbot/app/previous` until the next update.

### Snapshots

Before switching, the update copies into
`~/.bitterbot/snapshots/<time>-<from>-to-<to>/` (with a `manifest.json`
listing every file and its SHA-256):

- your config file and `~/.bitterbot/.env`
- every memory database in `~/.bitterbot/memory/` (copied with SQLite's
  `VACUUM INTO`, so a database in use is copied consistently)
- `GENOME.md` and `MEMORY.md` of your default agent
- your P2P identity (`node.key`, `node.pub` and the files beside them). These
  are copied, never moved.

The app directory is never part of a snapshot. Bitterbot keeps the newest
three snapshots and removes older ones. The update stops before changing
anything if the disk does not have room for the snapshot. Snapshots contain
your keys and secrets, so the directory is readable only by you.

### Rollback

Switch back to the previous version by hand:

```bash
bitterbot update --rollback
```

The automatic rollback after a failed start, and `--rollback`, restore data
narrowly, because restoring a file throws away everything changed in it
since the update:

| What                 | Automatic rollback (new version never started)                         | `bitterbot update --rollback`        |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Config file          | restored if it changed since the snapshot                              | kept; `--restore-config` restores it |
| `.env`               | restored if it changed since the snapshot                              | kept (never restored by hand)        |
| Memory databases     | restored only if the new version migrated them past what the old knows | kept; `--restore-data` restores them |
| GENOME.md, MEMORY.md | kept                                                                   | kept                                 |
| Keys                 | kept                                                                   | kept                                 |

Why: database migrations are forward only, and each release keeps the
previous release able to read the migrated schema, so the old version works
with your current memories. After a failed start the config file is restored
because the old version validates it strictly and would refuse a key the new
version wrote, and nobody has edited it since. A manual rollback can come
weeks after the update, when changes to the config and `.env` are most likely
yours: pass `--restore-config` only if the old version refuses the current
config. `.env` holds your API keys and is never restored by hand; its
pre-update copy stays in the snapshot.

Every file that is replaced is first moved to
`~/.bitterbot/update-displaced/<time>-<from>-to-<to>/`, never deleted. That
folder is outside the snapshots, so removing old snapshots never touches it;
`bitterbot doctor` lists it with its size, and only you delete it.

A database is replaced only when no gateway can still be writing to it: the
gateway lock must be free and nothing may answer on the gateway port (the
automatic rollback also checks the process group of the gateway it started).
`--rollback --restore-data` stops an installed service itself and refuses to
start while a gateway it does not manage is running. If a gateway cannot be
confirmed gone, the version still switches, the databases are left as they
are, and the command says so and exits 1; copy the files from the snapshot's
`memory/` folder by hand once every gateway is stopped. GENOME.md, MEMORY.md
and keys are not changed by an update; restore them from the snapshot by hand
if you ever need to.

A manual rollback also cancels the boot check of an update that is still
pending, so its watchdog does not act on the version you switched to.

`bitterbot doctor` reports an automatic rollback (which versions, what was
restored) until the next clean update. Set `update.autoRollback.enabled` to
`false` to turn the automatic switch off; a failed start is then only
reported.

Re-running the installer also updates. It verifies the download as described
in [What gets verified](#what-gets-verified) (including the SHA-256-only
fallback that `bitterbot update` does not have), and when an older gateway is
running it switches it over with a snapshot and a rollback on failure (see
[Upgrading from a git clone or an older version](#upgrading-from-a-git-clone-or-an-older-version)).
With no gateway running it only installs and links the new version.
`bitterbot update` is the preferred path: it refuses unsigned downloads and
checks the new version against your config and data before switching.

## Uninstall

```bash
rm -rf ~/.bitterbot/app ~/.local/bin/bitterbot
```

This leaves your data in `~/.bitterbot`; remove that directory too only if you
want to delete your config, memory and keys.

## Windows (WSL2)

Bitterbot's release tarballs are built for Linux and macOS. On Windows,
`install.ps1` runs the Linux installer inside WSL2:

```powershell
irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex
```

It downloads `install.sh` from the latest release as well, finds your default WSL2
distribution, prints its plan, and runs that installer inside it, so Bitterbot lives in your Linux home
(`~/.bitterbot`, on the Linux ext4 filesystem). It changes nothing on Windows
and needs no administrator rights. Without WSL2 it prints how to enable it
(`wsl --install`, which does need an administrator and a restart) and the
[Docker Desktop](/platforms/docker) alternative, then exits with code 2.
Piped into `iex` it leaves your PowerShell session as it was: it never closes
the window or ends a script that runs it, keeps its functions and settings
(`$ErrorActionPreference`, strict mode) to itself, and reports its exit code
in `$LASTEXITCODE`.

To pass options, save the script and run it:

```powershell
.\install.ps1 -Version 1.6.0 -NoOnboard   # also -Distro <name>, -Yes, -NoSwitch
.\install.ps1 -WhatIf                     # print the plan, run nothing
```

Inside WSL the Linux installer offers the
[switch](#upgrading-from-a-git-clone-or-an-older-version) from an older
Bitterbot running there; `-Yes` switches without asking and `-NoSwitch`
leaves it alone. A gateway you installed natively on Windows from a git clone
(the `Bitterbot Gateway` scheduled task) keeps the gateway port on the Windows
side: `install.ps1` reports it and prints the commands to stop it
(`Stop-ScheduledTask` and `Disable-ScheduledTask`), but never changes it.

If you also clone the source, clone it into your Linux home, not under
`/mnt/c`. A native Windows install is not available yet; see
[Windows](/platforms/windows).

## Troubleshooting

- `no published release carries a signed tarball`, or a pinned
  `--version` that fails with `could not download .../checksums.txt`: that
  release's tarballs are not attached yet. They are built after the release
  appears and are signed only after a maintainer approves the signing step,
  which can take hours; until then the installer (without `--version`) keeps
  installing the previous complete release.
- `the GitHub releases API refused the request`: unauthenticated API calls are
  limited to 60 per hour per IP. Wait, or pin a release with `--version`.
- `signature is INVALID`, `signature check FAILED` or `SHA-256 mismatch`
  (installer or `bitterbot update`): do not work around it. Report it with the
  full output at
  [GitHub issues](https://github.com/Bitterbot-AI/bitterbot-desktop/issues).
- `bitterbot update` says `refuses this machine's data`: the new version would
  not start with your config, or your memory was written by a newer release.
  Run `bitterbot doctor --fix`, or pin the release you are on.
- A damaged installation (`bitterbot doctor` reports files that do not match
  `manifest.json`): stop the gateway, then `bitterbot update --reinstall`
  downloads and verifies the same version again.
- `bitterbot: command not found`: add `~/.local/bin` to your `PATH` (the
  installer printed the line), or run `~/.bitterbot/app/current/bin/bitterbot`.
