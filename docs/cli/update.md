---
summary: "CLI reference for `bitterbot update` (installer-based installs with snapshot and rollback, npm package installs, containers, source checkouts)"
read_when:
  - You want to update a source checkout safely
  - You want to update or roll back an installer-based install
  - You need to understand `--update` shorthand behavior
title: "update"
---

# `bitterbot update`

Safely update Bitterbot and switch between stable/beta/dev channels.

An install is a **source checkout**, a **container**, an
**installer-based install**, or an **npm package install**
(`npm install -g bitterbot`, see [npm package](/start/npm)). Each updates
its own way; `bitterbot update status` shows which one this is.

| Install                                                               | Update with                                                                               | Safety net                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [Installer](/start/install-script)                                    | `bitterbot update` (or the Control UI's **Update now**), or run the installer again       | signature check, snapshot, automatic rollback           |
| [npm package](/start/npm)                                             | `bitterbot update`, or `npm install -g bitterbot@latest` then `bitterbot gateway restart` | none; go back with `npm install -g bitterbot@<version>` |
| [Docker](/platforms/docker)                                           | `docker compose pull && docker compose up -d` on the Docker host                          | pin the previous image tag in `BITTERBOT_IMAGE`         |
| [Source checkout](/start/getting-started#quick-setup-from-source-cli) | `bitterbot update` (`pnpm bitterbot update`)                                              | clean-tree check, doctor gate, boot watchdog rollback   |

Moving from one kind to another (for example from a git clone to the
installer or npm): install the new one, then `bitterbot gateway switch` (the
installer and `bitterbot onboard` offer it) hands the running gateway and its
background service over, with a snapshot and a rollback if the new version
does not start. See
[Upgrading from a git clone or an older version](/start/install-script#upgrading-from-a-git-clone-or-an-older-version).

In a **container** (the published image sets `BITTERBOT_INSTALL_KIND=container`;
images that do not are detected from `/.dockerenv`, `/run/.containerenv` or the
cgroup, unless the directory is a git checkout), `bitterbot update` and the
Control UI refuse to update in place: the image is the code. `update status`
compares the running version with the newest GitHub release instead of npm.
Update with `docker compose pull && docker compose up -d` on the Docker host
(see [Docker](/platforms/docker)).

For an **installer-based install** (the release tarball from
[`install.sh`](/start/install-script); its launcher sets
`BITTERBOT_INSTALL_KIND=tarball` and the install root carries a
`.bitterbot-install-kind` marker), `bitterbot update` and the Control UI's
Update button update in place: verified download, snapshot of your data,
activation check by the new version, an atomic switch, and an automatic
rollback when the new version does not start. See
[Installer-based installs](#installer-based-installs) below. `update status`
compares the running version with the newest GitHub release that carries a
tarball for your platform. Set `BITTERBOT_INSTALL_KIND=package` if the
detection is wrong.

## Default channel

With `update.channel` unset: `stable` for package installs, containers, installer
(tarball) installs, and git
checkouts sitting on a release tag (`beta` for a `-beta` tag); `dev` only for a
git checkout on a branch. A configured `update.channel` always wins.

## Usage

```bash
bitterbot update
bitterbot update status
bitterbot update wizard
bitterbot update --channel beta
bitterbot update --channel dev
bitterbot update --tag beta
bitterbot update --no-restart
bitterbot update --json
bitterbot update --check
bitterbot update --rollback
bitterbot --update
```

## Options

- `--no-restart`: skip restarting the Gateway service after a successful update.
- `--channel <stable|beta|dev>`: set the update channel (persisted in config).
  Installer-based installs follow `stable` only.
- `--tag <dist-tag|version>`: override the npm dist-tag or version for this
  update only (package installs); for an installer-based install, the release
  version to install (`1.6.0`).
- `--json`: print machine-readable result JSON.
- `--timeout <seconds>`: per-step timeout (default is 1200s).
- `--yes`: skip confirmation prompts (downgrades, rollback).
- `--check`: only report whether an update is available (no changes).
- `--rollback`: installer-based installs only; switch back to the previous
  version.
- `--restore-data`: with `--rollback`, also restore the memory databases from
  the pre-update snapshot (loses everything written since the update). Only
  with no gateway running: an installed service is stopped first, and a
  database is never replaced while the gateway lock is held or the gateway
  port answers.
- `--restore-config`: with `--rollback`, also restore the config file from the
  pre-update snapshot (for an old version that refuses the current config).
  `.env` is never restored by `--rollback`.
- `--reinstall`: installer-based installs only; download and verify the
  current version again and replace its directory (stop the gateway first).

Note: downgrades require confirmation because older versions can break configuration.

## `update status`

Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.
`--json` and `--timeout` work after `status` (`update status --json`).

```bash
bitterbot update status
bitterbot update status --json
bitterbot update status --timeout 10
```

Options:

- `--json`: print machine-readable status JSON.
- `--timeout <seconds>`: timeout for checks (default is 3s).

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the Gateway
after updating (default is to restart). If you select `dev` without a git checkout, it
offers to create one. On an installer-based install it offers: update to the newest
release, only check, or roll back to the previous version.

## Installer-based installs

`bitterbot update` (and the Control UI's **Update now**) on an install from
`install.sh`:

1. Picks the target: the newest release that carries your platform's tarball,
   `checksums.txt` and `checksums.txt.minisig` (the installer's rule), or
   `--tag`. Already current: nothing to do. A downgrade asks first.
2. Verifies `checksums.txt` against the pinned minisign key, requires the
   signed comment `v<version> checksums`, and checks the tarball's SHA-256.
   Any failure stops the update; there is no unsigned fallback.
3. Unpacks into a staging directory next to the install and checks every file
   against `manifest.json`.
4. Runs the new version's own launcher: `--version` must print the target, and
   `update preflight` (it changes no config or data) must accept this machine. It blocks when
   the config file fails the new version's schema, or a memory database has a
   schema newer than the new version knows. Forward migrations are fine.
5. Snapshots config, memory databases, GENOME.md/MEMORY.md and keys into
   `~/.bitterbot/snapshots/<time>-<from>-to-<to>/` (newest three kept; see
   [Snapshots](/start/install-script#snapshots)).
6. Activates: `previous` -> the old version, `current` -> the new one (atomic
   symlink renames), then removes older versions that are not in use.
7. Restarts: an installed gateway service is restarted; a gateway running in a
   terminal or under `nohup` is asked (over RPC) to restart into `current`; with
   no gateway running it prints how to start one. It then waits for the new
   version to confirm a healthy start (at least 5 minutes, or three times the
   last measured start, at most 30; tripled, at most 90, when the new version
   migrates memory databases on its first start). If the new process exits or never
   confirms, the boot watchdog switches `current` back, restores data per the
   [rollback policy](/start/install-script#rollback), starts the old version,
   and `bitterbot update` exits 1 with what happened.

`bitterbot update --rollback` switches back by hand. It keeps the config file
(unless `--restore-config`), `.env` and the databases (unless `--restore-data`),
and cancels the boot check of an update still pending, so that update's
watchdog does not act on the version you switched to. Replaced files are kept
in `~/.bitterbot/update-displaced/` (see
[Rollback](/start/install-script#rollback)). One update runs at a time: a
second `bitterbot update`, or a second Update click in the Control UI, is
refused while one runs. The test-mode variables the
installer CI uses (`BITTERBOT_INSTALL_TEST_MODE`, `BITTERBOT_INSTALL_BASE_URL`,
`BITTERBOT_INSTALL_TEST_PUBKEY`) follow the same rules as in `install.sh` and
only work from the CLI; `update.run` (and so the Control UI) always uses
GitHub Releases and the pinned key.

## What it does

When you switch channels explicitly (`--channel ...`), Bitterbot also keeps the
install method aligned:

- `dev` → ensures a git checkout (default: `~/bitterbot`, override with `BITTERBOT_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable`/`beta` → on a package install, installs from npm using the matching
  dist-tag (`latest` or `beta`). A checkout follows `stable`/`beta` by
  checking out the release tag (below) and stays a checkout.

## npm package installs

Since 1.6.2, `npm install -g bitterbot` installs a small launcher that
downloads the signed release on first run into `~/.bitterbot/app` (see
[npm package](/start/npm)). The app it starts is a release install, so
`bitterbot update` follows the [installer-based](#installer-based-installs)
flow above: verified, snapshotted, rolled back automatically. Updating the
launcher with `npm install -g bitterbot@latest` works too: the next
`bitterbot` run installs that version (the old one is kept as `previous`).
When the app is already newer than the launcher (after `bitterbot update`),
the launcher simply runs it.

For older full-package installs (1.6.0 and 1.6.1, or a pnpm/Bun global
install), `bitterbot update` checks that the running package is the one under
`npm root -g` (likewise `pnpm root -g` or Bun's global directory), then runs
`npm i -g bitterbot@<tag>`: `latest` on `stable`, `beta` on `beta`, or the
version or dist-tag given with `--tag`. A move to an older version asks for
confirmation first. Afterwards it restarts the gateway service if one is
installed; otherwise run `bitterbot gateway restart`. For 1.6.0 and 1.6.1 this
update installs the launcher; a gateway service set up from the old package
keeps working, because the package files it runs now forward to the launcher.

There is no snapshot or automatic rollback on that path; go back with
`npm i -g bitterbot@<previous version>`. Installed with `--prefix <dir>`? Run
the update with `NPM_CONFIG_PREFIX=<dir>` so `npm root -g` finds the install;
otherwise `bitterbot update` reports it cannot detect the package manager and
prints the npm command to run.

## Git checkout flow

Channels:

- `stable`: checkout the latest non-beta tag, then build + doctor.
- `beta`: checkout the latest `-beta` tag, then build + doctor.
- `dev`: checkout `main`, then fetch + rebase.

High-level:

1. Requires a clean worktree (no uncommitted changes).
2. Switches to the selected channel (tag or branch).
3. Fetches upstream (dev only).
4. Dev only: preflight lint + TypeScript build in a temp worktree; if the tip fails, walks back up to 10 commits to find the newest clean build.
5. Rebases onto the selected commit (dev only).
6. Installs deps (pnpm preferred; npm fallback).
7. Builds + builds the Control UI.
8. Runs `bitterbot doctor --non-interactive` as the final “safe update” gate.
   Doctor exits non-zero on any error-level finding, which marks the whole
   update as failed — the gateway is **not** restarted into the new build.
9. Arms a boot-health beacon before restarting and (git installs) spawns a
   detached boot watchdog. The gateway clears the beacon as soon as it
   binds. If the new build never boots before the beacon deadline, the
   watchdog performs one guarded automatic rollback (clean worktree only,
   reset to the pre-update sha, rebuild, restart; config and DB untouched)
   and `bitterbot doctor` reports what happened. Disable with
   `update.autoRollback.enabled: false`.
10. Syncs plugins to the active channel (dev uses bundled extensions; stable/beta uses npm) and updates npm-installed plugins.
11. Nothing else restarts: the gateway serves the Control UI itself, so open
    browser tabs reconnect and reload on their own. `update.uiRestart` (which
    gated a separate UI restarter) has no effect, warns at load, and will be
    removed next release.

## Updating from the Control UI

The Control UI (Overview tab) exposes the same machinery:

- **Node Version card**: current version, branch@sha, and how many commits
  behind upstream the node is ("Check for updates" runs a real `git fetch`).
  "Update now" runs the full safe-update flow above via the `update.run`
  gateway RPC, then the gateway restarts itself; the UI reconnects when the
  node is back.
- **Stale page prompt**: a Control UI tab left open across an update
  reconnects to the new gateway but keeps running the old page. When the
  gateway reports a different version than the page was built with, the UI
  shows a dismissible "Reload" banner.
- **Staleness prompt**: the gateway re-checks for drift at boot and every
  6 hours and broadcasts the result (`update` gateway event). Once a git
  node falls `update.promptBehindCommits` commits behind upstream
  (default 20), the UI shows a dismissible update banner. Set
  `update.checkOnStart: false` to disable automatic checks, or tune the
  threshold:

```json
{
  "update": {
    "channel": "dev",
    "checkOnStart": true,
    "promptBehindCommits": 20
  }
}
```

RPCs: `update.check` (status + staleness verdict, no side effects) and
`update.run` (the update itself). Both require the `operator.admin` scope.

The Overview tab also has **Restart gateway** and **Shut down** controls
(`system.restart` / `system.shutdown`, both `operator.admin`). Restart
self-heals through the same in-process SIGUSR1 path an update uses. Shut
down is a deliberate one-way SIGTERM: the Control UI cannot bring the
gateway back, so relaunch it with `pnpm start gateway` or by reopening the
app. After a successful in-UI update, the page reloads itself once the
gateway reconnects so the browser isn't left on the pre-update bundle.
A skipped or failed `update.run` (dirty tree, no upstream, preflight found
no good commit) does **not** restart the gateway; only a successful update
restarts.

Known limitation: drift counting works on the `dev` channel (a tracked
`main` checkout). `stable`/`beta` git checkouts sit on detached tags, so
"commits behind" is unknown there and the card shows "drift unknown".

## `--update` shorthand

`bitterbot --update` rewrites to `bitterbot update` (useful for shells and launcher scripts).

## See also

- `bitterbot doctor` (offers to run update first on git checkouts; checks the
  links, manifest and snapshots of an installer-based install)
- [Install script](/start/install-script)
- [Docker](/platforms/docker)
- [CLI reference](/cli)
