---
title: "npm Publishing"
summary: "How the bitterbot npm package (a launcher for the signed release tarball) is published: trusted publishing from GitHub Actions, the asset wait, the approval gate, and the one-time npmjs.com setup"
read_when:
  - Setting up or changing npm trusted publishing for the bitterbot package
  - Publishing a release to npm by hand
  - An npm publish run failed or was skipped
---

# npm Publishing

The `bitterbot` package on npm is published by GitHub Actions with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).
No npm token exists anywhere: npm accepts a publish only from the trusted
workflow, and the workflow publishes only after a maintainer approves it.

Since 1.6.2 the package is a launcher, not the app: one bundled file
(`bitterbot.mjs`, built from `src/launcher/` with only `node:` imports), two
compatibility shims, the README and the license, with no dependencies and
no scripts. On first run it installs the release's signed per-platform
tarball (the one `install.sh` installs) and runs it. npm 12 blocks install
scripts on global installs and a package cannot approve its own, and the
full 1.6.0/1.6.1 package (about 1,500 packages, 2.3 GB) took half an hour to
install with dozens of warnings; the launcher installs in seconds with none.

## Pieces

| Piece                | Value               |
| -------------------- | ------------------- |
| npm package          | `bitterbot`         |
| Publisher            | GitHub Actions      |
| Organization or user | `Bitterbot-AI`      |
| Repository           | `bitterbot-desktop` |
| Workflow filename    | `npm-publish.yml`   |
| Environment          | `npm`               |

The workflow is `.github/workflows/npm-publish.yml`. Its triggers:

- `release: types: [published]`: a release published by hand. Only `vX.Y.Z`
  tags publish; `orchestrator-v*` and `desktop-v*` releases are skipped.
- `workflow_dispatch` with a `tag` input (for example `v1.6.2`): publish an
  existing release. `release-please.yml` dispatches this for every release it
  creates, after its `release-tarball` job has uploaded the signed assets and
  published the release, because a release created with the default
  `GITHUB_TOKEN` never fires `release` events (a dispatch is the exception).
  The dispatch keeps `npm-publish.yml` as the workflow npm sees, so one
  trusted publisher entry covers both paths.

## One-time setup

1. **GitHub environment.** Repository Settings, Environments, New
   environment named `npm`. Add yourself (and any other maintainer) under
   Required reviewers. Optionally limit deployments to the `main` branch and
   `v*` tags (a dispatch runs from `main`, a release event from its tag). No
   secrets go in it.
2. **npm trusted publisher.** On npmjs.com, package `bitterbot`, Settings,
   Trusted publishing, GitHub Actions. Fill in exactly the values in the
   table above: organization `Bitterbot-AI`, repository `bitterbot-desktop`,
   workflow filename `npm-publish.yml`, environment `npm`. Save.
3. **Lock token publishing (after the first trusted publish works).** In the
   same Settings page, under Publishing access, choose "Require two-factor
   authentication and disallow tokens", so only the trusted workflow can
   publish. Revoke any old automation tokens.

Renaming the workflow file or the environment breaks publishing until the
npm settings are changed to match; `src/infra/npm-package.test.ts` fails if
either name changes in the repo.

## What a publish run does

The `assets` job (no approval needed) resolves the tag and waits, for up to
two hours, until every platform's tarball, `checksums.txt` and
`checksums.txt.minisig` answer on the public
`releases/download/v<version>/` URLs the launcher downloads from (a draft
release does not). A launcher must never reach npm before the release it
installs. It then builds the launcher from the tag and runs it in
production mode (GitHub Releases, the pinned key, no overrides) on a clean
`HOME`: it must install the public linux-x64 release and print the version.

The `publish` job checks out the release tag and then:

1. Checks that `package.json` `version` equals the tag.
2. Upgrades npm to 11.x and checks it is at least 11.5.1 (trusted
   publishing needs it; Node 22 ships npm 10).
3. Skips cleanly (green, nothing published) when that version is already on
   npm, so re-running or double-triggering is safe.
4. `pnpm install --frozen-lockfile` (for esbuild and tsx only; the app itself
   is not built here, it ships in the release tarball).
5. `node --import tsx scripts/npm-package.ts prepare --out <dir>`, which
   writes the launcher package into its own directory (below).
6. `pnpm release:check --npm-publish --dir <dir>`: exactly the expected
   files, no dependencies, no scripts, a bundle that imports only `node:`
   built-ins, under 512 KB.
7. Waits for the `npm` environment approval (the job starts only after it).
8. `npm publish --provenance --access public --ignore-scripts` from that
   directory, then waits until the registry serves the new version (polls
   every 30 seconds for up to 15 minutes). If that wait runs out, the publish
   itself still happened: do not publish again. Once
   `npm view bitterbot@<version> version` answers, a re-run skips the
   publish (step 3) and goes green.

The CI job "npm package install" (`.github/workflows/ci.yml`, every push and
pull request) builds and gates the same package, installs it with npm 12
into a clean prefix and `HOME`, and fails on any `npm warn`, deprecation,
install-script or allow-scripts line, or any installed dependency. Then it
runs the installed launcher against a fixture release signed with a
throwaway key (test mode, which only accepts a loopback or `file://` URL):
`bitterbot --version`, and the same through the `dist/index.js` and
`dist/entry.js` shims. The "Release tarball + install.sh" job runs the
launcher against the real linux-x64 tarball it builds.

## The launcher package

`scripts/npm-package.ts prepare --out <dir>` leaves the repo's
`package.json` alone (it stays the source and release-tarball manifest, with
the pnpm-only `preinstall` and `postinstall` hooks) and writes:

- `package.json`: name, version (the release the launcher installs), `bin`,
  `engines.node` `>=18` (the launcher only downloads; the app brings its own
  Node), `type: module`, and nothing that makes npm install or run anything.
- `bitterbot.mjs`: the launcher, bundled by esbuild with the version built
  in.
- `dist/index.js` and `dist/entry.js`: compatibility shims. A gateway
  service installed from the 1.6.0 or 1.6.1 package runs
  `node <package>/dist/index.js gateway ...`, and the 1.6.x updater runs
  `node <package>/dist/entry.js doctor` right after `npm i -g`. After that
  update both paths forward to the launcher, which installs the release and
  runs it.
- `README.md` and `LICENSE`.

The launcher verifies exactly like `install.sh` and `bitterbot update`, with
the same code (`src/infra/tarball-release.ts`, `tarball-install.ts`,
`tarball-lock.ts`): minisign over `checksums.txt` with the pinned key, the
exact `v<version> checksums` trusted comment, then the tarball's SHA-256.

## Publishing an existing release by hand

```bash
gh workflow run npm-publish.yml --repo Bitterbot-AI/bitterbot-desktop -f tag=v1.6.2
```

Then approve the run under Actions (the `npm` environment). The tag must
contain the launcher (`scripts/npm-package.ts prepare --out`), so releases
older than 1.6.2 cannot be published this way.

## Install hooks

The published launcher has none. The repo's `preinstall`
(`scripts/preinstall-check.mjs`) and `postinstall`
(`scripts/fetch-orchestrator.mjs`) run only for pnpm source installs (the
release tarball build skips them by environment). `pnpm release:check`
still checks the app file list the release tarball copies: it fails when a
hook runs a file that is not in it, imports one that is not, or needs pnpm
or tsx.
