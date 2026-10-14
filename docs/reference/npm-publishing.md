---
title: "npm Publishing"
summary: "How the bitterbot npm package is published: trusted publishing from GitHub Actions, the approval gate, the publish-time manifest and shrinkwrap, and the one-time npmjs.com setup"
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
- `workflow_dispatch` with a `tag` input (for example `v1.6.0`): publish an
  existing release. `release-please.yml` dispatches this for every release it
  creates, because a release created with the default `GITHUB_TOKEN` never
  fires `release` events (a dispatch is the exception). The dispatch keeps
  `npm-publish.yml` as the workflow npm sees, so one trusted publisher entry
  covers both paths.

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

The job checks out the release tag, so the package is built from the
released code, and then:

1. Checks that `package.json` `version` equals the tag.
2. Upgrades npm to 11.x and checks it is at least 11.5.1 (trusted
   publishing needs it; Node 22 ships npm 10).
3. Skips cleanly (green, nothing published) when that version is already on
   npm, so re-running or double-triggering is safe.
4. `pnpm install --frozen-lockfile` and `pnpm build`.
5. `node --import tsx scripts/npm-package.ts prepare`, which rewrites
   `package.json` for npm and writes `npm-shrinkwrap.json` (below).
6. `pnpm release:check --npm-publish`: the pack-content gate, plus the npm
   manifest and shrinkwrap checks.
7. Waits for the `npm` environment approval (the job starts only after it).
8. `npm publish --provenance --access public --ignore-scripts`, then waits
   until the registry serves the new version.

The CI job "npm package install" (`.github/workflows/ci.yml`, every push and
pull request) runs steps 4 to 6, packs, installs the tarball with plain
`npm install -g` into a clean prefix and `HOME`, and boots the installed
copy: `--version`, `doctor`, `update status`, and a gateway that serves the
Control UI and starts the orchestrator the postinstall downloaded.

## The publish-time manifest

`scripts/npm-package.ts prepare` changes two things that cannot live in the
committed `package.json`:

- **Optional native peers.** `node-llama-cpp` and `@napi-rs/canvas` are
  marked optional in `peerDependenciesMeta`, so npm does not download them
  (node-llama-cpp is about 700 MB of GPU builds on Linux x64). The committed
  file cannot say this: pnpm's `autoInstallPeers` skips optional peers, which
  would drop node-llama-cpp from source checkouts, the Docker image and the
  release tarball.
- **npm-shrinkwrap.json.** npm reads `overrides` only from the root project,
  and for `npm install -g bitterbot` the root is npm's global prefix, so the
  committed `overrides` field protects nobody who installs from the
  registry. The shrinkwrap is resolved with the overrides applied, checked
  so every copy of an overridden package has the pinned version, and
  published inside the package, where npm honours it.

The security overrides are kept in two places, `pnpm-workspace.yaml`
(pnpm) and `package.json` `overrides` (npm); `src/infra/npm-package.test.ts`
fails when they drift. For a package that is also a direct dependency npm
requires the `"$name"` form, which resolves to the direct dependency's
exact version; the test requires that version to be at or above the pnpm
pin.

## Publishing an existing release by hand

```bash
gh workflow run npm-publish.yml --repo Bitterbot-AI/bitterbot-desktop -f tag=v1.6.0
```

Then approve the run under Actions (the `npm` environment). The tag must
contain `scripts/npm-package.ts`, so releases older than 1.6.0 cannot be
published this way.

## Install hooks

`preinstall` (`scripts/preinstall-check.mjs`) and `postinstall`
(`scripts/fetch-orchestrator.mjs`, which imports
`scripts/orchestrator-signature.mjs` and reads `orchestrator/Cargo.toml`)
run on every user's machine, so those files are in `files`.
`pnpm release:check` fails the pack when an install hook runs a file that is
not packed, imports one that is not packed, or needs pnpm or tsx.
