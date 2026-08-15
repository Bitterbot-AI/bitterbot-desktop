# Relay release signing — activation runbook

The fleet updater (`scripts/update-orchestrator.sh`) refuses to install an
orchestrator binary unless `checksums.txt` carries a valid **minisign**
signature from the fleet key, verified against a public key embedded in the
script. This closes the unsigned-updater supply-chain hole (security pass C1):
a pushed tag or a swapped release asset can no longer reach the relays.

Until the steps below are done, the updater **fails closed** — it installs
nothing (the embedded key is a placeholder), and fresh droplets fall back to a
from-source build. Do these once to activate.

## One-time setup (maintainer)

### 1. Generate the fleet signing keypair

```bash
minisign -G -W -p relay.pub -s relay.key      # -W = no password (for CI)
```

- `relay.pub` is public. Its **last line** is the raw public key.
- `relay.key` is the secret — never commit it; store it in a password manager.

### 2. Embed the public key in the updater

In `scripts/update-orchestrator.sh`, replace the `MINISIGN_PUBKEY` placeholder
with the last line of `relay.pub`. Commit that (public keys are public).

### 3. Add the CI secrets (repo → Settings → Secrets and variables → Actions)

- `MINISIGN_SECRET_KEY` — the **full contents** of `relay.key`.
- `MINISIGN_PUBLIC_KEY` — the last line of `relay.pub` (optional; enables the
  CI self-verify sanity check).

### 4. Create the protected `release` environment (blocks the tag-push vector)

Repo → Settings → Environments → **New environment** named `release`:

- **Required reviewers**: yourself (and/or a co-maintainer).
- The `release` job in `orchestrator-release.yml` already declares
  `environment: release`, so publishing now pauses for your approval. A
  malicious pushed tag builds but cannot be signed/published without your click.

### 5. Cut the first signed release

Bump `orchestrator/Cargo.toml`, push an `orchestrator-v*` tag, approve the
release job. The release now carries `checksums.txt.minisig`.

### 6. Provision minisign + the new updater on the 3 live relays

The updated `cloud-init.yaml` handles fresh droplets. For the existing relays
(46.101.181.98 / 142.93.113.64 / 139.59.233.83, `root@` + `~/.ssh/bitterbot-relay`):

```bash
for ip in 46.101.181.98 142.93.113.64 139.59.233.83; do
  ssh -i ~/.ssh/bitterbot-relay root@$ip \
    "apt-get update && apt-get install -y minisign"
  scp -i ~/.ssh/bitterbot-relay scripts/update-orchestrator.sh \
    root@$ip:/usr/local/sbin/bitterbot-orchestrator-update.sh
  ssh -i ~/.ssh/bitterbot-relay root@$ip \
    "chmod 755 /usr/local/sbin/bitterbot-orchestrator-update.sh && \
     echo '<installed-version>' > /var/lib/bitterbot/orchestrator.version && \
     /usr/local/sbin/bitterbot-orchestrator-update.sh"
done
```

Set `<installed-version>` to the version each relay currently runs (e.g.
`0.2.2`) so the semver floor knows the baseline. From then on the daily
staggered timer keeps them converged onto signed releases with an auto-revert
canary.

## Key rotation

Generate a new keypair, embed the new public key, update `MINISIGN_SECRET_KEY`,
sign the next release, and roll the embedded key to the relays (over SSH, same
as step 6) BEFORE the next release so verification does not break. Keep the old
public key acceptable for one release cycle if you want zero-downtime rotation
(the updater currently trusts a single key — multi-key trust is a follow-up).
