---
title: "Release Procedure"
summary: "Top-to-bottom checklist for cutting a Bitterbot release across its three surfaces"
read_when:
  - Cutting a release
  - Verifying a release actually shipped
---

# Release Procedure

The release surfaces (the image, the installer tarballs, the npm package,
and the orchestrator when it changed) share one order of operations.
release-please owns the version and the changelog; humans own the judgment
points, including one approval each for the tarball signing (`release`
environment) and the npm publish (`npm` environment).

## 1. CI green

The release PR must sit on a green `main`: the full CI run including the
gateway suite and the Docker build + boot smoke job. A red or skipped
docker job means the image release surface is broken — stop here.

## 2. Merge the release PR (human judgment point)

release-please maintains a `chore(main): release X.Y.Z` PR. **Read the
diff before merging**: the version fan-out (root, desktop, extensions,
tauri.conf) and the CHANGELOG section are the release's public claims.
Merging creates the git tag and the GitHub Release as a **draft**, and
release-please's `release_created` output (not a tag push) starts the GHCR
publish, the installer tarballs and the npm publish.

The draft stays hidden, and `releases/latest` keeps pointing at the previous
release, until you approve the `release` environment for the tarball publish.
That job uploads the signed tarballs and `install.sh`, then publishes the
release and marks it latest, so the installer one-liner never resolves to a
release that is still missing its files. If the publish job fails after the
upload, publish the draft by hand on the Releases page.

## 3. Verify the image

```bash
docker pull ghcr.io/bitterbot-ai/bitterbot-desktop:X.Y.Z
gh attestation verify oci://ghcr.io/bitterbot-ai/bitterbot-desktop:X.Y.Z \
  --repo Bitterbot-AI/bitterbot-desktop
```

Expect the semver tag set (`X.Y.Z`, `X.Y`, `X`, `latest`, `sha-…`) on the
package page and a passing provenance attestation.

## 3b. Approve and verify the npm publish

release-please dispatches `npm-publish.yml` for the new tag. Approve the run
in the `npm` environment, then check the package and its provenance:

```bash
npm view bitterbot@X.Y.Z version dist.attestations.url
npm install -g bitterbot@X.Y.Z && bitterbot --version
```

Setup, the publish steps and the manual dispatch are in
[npm Publishing](/reference/npm-publishing).

## 4. Orchestrator (only when it changed)

Bump `orchestrator/Cargo.toml`, commit, push an `orchestrator-v<version>`
tag, and approve the protected `release` environment when the workflow
asks. Confirm the release carries all 5 platform binaries plus
`checksums.txt` and `checksums.txt.minisig`, then verify one binary:

```bash
gh attestation verify bitterbot-orchestrator-linux-x64 \
  --repo Bitterbot-AI/bitterbot-desktop
minisign -Vm checksums.txt -P <fleet pubkey> && sha256sum -c checksums.txt
```

The fleet public key (the base64 line of the minisign `.pub` file, the same
value as the `MINISIGN_PUBLIC_KEY` repo secret) is pinned as
`ORCHESTRATOR_MINISIGN_PUBKEY` in `scripts/orchestrator-signature.mjs`
(pinned 2026-10-11). A missing, bad or replayed `checksums.txt.minisig` makes
the fetch refuse the binary; there is no SHA-256-only fallback while a key is
pinned, and the environment override `BITTERBOT_ORCHESTRATOR_MINISIGN_PUBKEY`
is ignored once the repo pins one. Rotating the key means changing the
constant in the same PR that changes the repo secrets.

## 5. Clean-machine smoke

On a machine (or container) that has never seen Bitterbot, run each install
path from [Getting Started](/start/getting-started) **verbatim**: the Docker
compose download and `docker compose up -d`, the `install.sh` one-liner,
`npm install -g bitterbot` then `bitterbot onboard`, and the source path (clone, `setup-deps.sh`, `pnpm install`,
`pnpm bitterbot onboard`). Each must end with the gateway serving the Control
UI at `http://127.0.0.1:19001/`. Any deviation from the
documented text is a release blocker, not a doc bug to fix later.

## 6. Live-agent drive

Per the standing post-deploy rule: drive the real agent (send a message
via the Control UI or `bitterbot agent --to … --message …`), watch it
complete a tool call, and check `bitterbot doctor` comes back clean on
the upgraded node before announcing anything.

## 7. Announce

Release notes are the generated changelog section — link the GitHub
Release, do not restate it. Update any pinned install instructions only
if step 5 forced a change.
