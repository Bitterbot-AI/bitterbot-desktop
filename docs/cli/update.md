---
summary: "CLI reference for `bitterbot update` (safe-ish source update + gateway auto-restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: "update"
---

# `bitterbot update`

Safely update Bitterbot and switch between stable/beta/dev channels.

If you installed via **npm/pnpm** (global install, no git metadata), updates happen via the package manager flow in [Updating](/install/updating).

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
bitterbot --update
```

## Options

- `--no-restart`: skip restarting the Gateway service after a successful update.
- `--channel <stable|beta|dev>`: set the update channel (git + npm; persisted in config).
- `--tag <dist-tag|version>`: override the npm dist-tag or version for this update only.
- `--json`: print machine-readable `UpdateRunResult` JSON.
- `--timeout <seconds>`: per-step timeout (default is 1200s).

Note: downgrades require confirmation because older versions can break configuration.

## `update status`

Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.

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
offers to create one.

## What it does

When you switch channels explicitly (`--channel ...`), Bitterbot also keeps the
install method aligned:

- `dev` → ensures a git checkout (default: `~/bitterbot`, override with `BITTERBOT_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable`/`beta` → installs from npm using the matching dist-tag.

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
9. Arms a boot-health beacon before restarting. The gateway clears it as
   soon as it binds; if the new build never boots, the next `bitterbot doctor`
   goes loud with the exact rollback command.
10. Syncs plugins to the active channel (dev uses bundled extensions; stable/beta uses npm) and updates npm-installed plugins.

## Updating from the Control UI

The Control UI (Overview tab) exposes the same machinery:

- **Node Version card**: current version, branch@sha, and how many commits
  behind upstream the node is ("Check for updates" runs a real `git fetch`).
  "Update now" runs the full safe-update flow above via the `update.run`
  gateway RPC, then the gateway restarts itself; the UI reconnects when the
  node is back.
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

- `bitterbot doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
