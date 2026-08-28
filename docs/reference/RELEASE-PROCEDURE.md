---
title: "Release Procedure"
summary: "Top-to-bottom checklist for cutting a Bitterbot release across its three surfaces"
read_when:
  - Cutting a release
  - Verifying a release actually shipped
---

# Release Procedure

Three release surfaces, one order of operations. release-please owns the
version and the changelog; humans own the judgment points. There is no
`npm publish` step in the normal flow (npm is name-claim only until
distribution is a supported surface) and no curl installer — installing
from source is the documented path.

## 1. CI green

The release PR must sit on a green `main`: the full CI run including the
gateway suite and the Docker build + boot smoke job. A red or skipped
docker job means the image release surface is broken — stop here.

## 2. Merge the release PR (human judgment point)

release-please maintains a `chore(main): release X.Y.Z` PR. **Read the
diff before merging**: the version fan-out (root, desktop, extensions,
tauri.conf) and the CHANGELOG section are the release's public claims.
Merging creates the git tag and the GitHub Release, and that event —
not a tag push — triggers the GHCR publish.

## 3. Verify the image

```bash
docker pull ghcr.io/bitterbot-ai/bitterbot-desktop:X.Y.Z
gh attestation verify oci://ghcr.io/bitterbot-ai/bitterbot-desktop:X.Y.Z \
  --repo Bitterbot-AI/bitterbot-desktop
```

Expect the semver tag set (`X.Y.Z`, `X.Y`, `X`, `latest`, `sha-…`) on the
package page and a passing provenance attestation.

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

## 5. Clean-machine smoke

On a machine (or container) that has never seen Bitterbot: follow the
README Quick Start **verbatim** — clone, `setup-deps.sh`, `pnpm install`,
`pnpm bitterbot onboard`. The wizard must finish and the gateway must
serve the Control UI at `http://127.0.0.1:19001/`. Any deviation from the
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
