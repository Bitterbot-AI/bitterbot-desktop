# Bitterbot P2P Bootstrap Node

Lightweight always-on libp2p node for P2P network bootstrap and circuit relay.
No agent, no gateway, no Node — just the Rust orchestrator daemon (~20–30 MB RAM idle).

## What this gives you

- A publicly reachable peer on the `_dnsaddr.p2p.bitterbot.ai` bootstrap set
- Kademlia DHT participation for peer discovery
- Gossipsub mesh membership on all five topics (`skills`, `telemetry`, `weather`, `bounties`, `queries`)
- Circuit Relay v2 **server** mode — NAT'd edge nodes reserve slots on this node to reach the mesh, and DCUtR attempts hole-punching for direct connections

One bootnode is enough to smoke-test. For production resilience, run **three** in different Railway regions (us-east / us-west / eu) so losing one doesn't blind fresh nodes trying to join.

## Prerequisites

- A Railway account (https://railway.app)
- DNS control over a domain matching `bootstrapDns` in your gateway config (default: `p2p.bitterbot.ai`)
- Optional: [Railway CLI](https://docs.railway.app/develop/cli) for the CLI-heavy portions. You can run it without a global install via `pnpm dlx @railway/cli@latest <command>`.
- Optional: a **project-scoped** Railway token for scripted work — see *Using a project token* below.

## Deploy

The flow splits into **Git-based steps** (CLI-friendly) and **dashboard-only steps** (volume + TCP proxy). Railway project tokens cannot provision storage or networking resources via API — that authority lives only at the workspace level — so a handful of clicks are unavoidable for the one-time setup.

### 1. Create the Railway project and an empty service

```bash
railway login                    # browser handshake, one time
railway init                     # create a new empty project, e.g. "bitterbot-p2p-mainnet"
railway add --service bootnode   # create an empty service named "bootnode"
```

Or do the same in the dashboard: **New Project → Empty Project**, then **+ Service → Empty Service**. Either path lands you with a service that has no source configured.

### 2. Link the service to this repository (dashboard only)

CLI cannot configure a GitHub-backed source on a service. This step is required — without it, deploys via `railway up` snapshot upload get stuck in `INITIALIZING` with no build logs because Railway's default RAILPACK builder is confused by the repo's Node.js workspace layout.

1. Open the `bootnode` service → **Settings → Source → Connect Repo**
2. Authorize the Railway GitHub app if prompted (workspace-level, one time)
3. Pick the `bitterbot-desktop` repo (or your fork)
4. Branch: `main`
5. **Root Directory**: leave blank (`/`). The Docker build context must be the repo root so the Dockerfile can `COPY orchestrator/` — that directory lives above `deploy/bootnode/`, outside what would be reachable if you set Root Directory to the bootnode subfolder.
6. **Config as Code → Config Path**: `deploy/bootnode/railway.toml`

Once the Config Path is saved, Railway reads `deploy/bootnode/railway.toml`, picks up `deploy/bootnode/Dockerfile`, and auto-deploys on every `git push` to `main`.

### 3. Create the persistent volume (dashboard only)

This is the easiest step to miss, and if you miss it the Ed25519 keypair regenerates on every redeploy, the peer ID changes, and your DNS record goes stale within minutes.

**Important**: the `[[deploy.volumes]]` stanza in `railway.toml` does **not** actually create the volume. It only *binds* an existing volume by name at deploy time. You must create the volume separately.

1. From the project canvas (the main view with the service tile), click **+ New**
2. Select **Volume**
3. Attach it to the `bootnode` service
4. **Mount path**: `/data/keys`
5. Name it something like `bootnode-keys`
6. Create

Railway auto-triggers a redeploy once the volume is attached. On that deploy, the orchestrator logs `Generated new Ed25519 keypair in "/data/keys"` — that keypair now lives on persistent storage and the peer ID derived from it is **permanent** as long as the volume survives.

### 4. Create the TCP proxy (dashboard only)

libp2p speaks raw TCP, not HTTP. Railway's HTTP domain feature — which looks more prominent in the Networking panel — will silently break the libp2p handshake. You need a **TCP Proxy** specifically.

1. `bootnode` service → **Settings → Network**
2. Under **Public Networking**, click **+ TCP Proxy**
3. **Target Port**: `9100` (the internal port the orchestrator listens on — *not* the external port Railway assigns)
4. Confirm

Railway assigns a public hostname + external port, something like `metro.proxy.rlwy.net:12838`, and automatically injects three env vars into the service: `RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT`, `RAILWAY_TCP_APPLICATION_PORT`. Read them via CLI:

```bash
railway variable list -s bootnode -e <env-id> | grep RAILWAY_TCP
```

### 5. Capture the peer ID

Tail the runtime logs after the volume-triggered redeploy:

```bash
railway logs -d -s bootnode -e <env-id> -n 40
```

Look for:

```
INFO bitterbot_orchestrator::crypto: Generated new Ed25519 keypair in "/data/keys"
INFO bitterbot_orchestrator: Local peer ID: 12D3KooW...
INFO bitterbot_orchestrator::swarm: Swarm initialized for peer 12D3KooW... on /ip4/0.0.0.0/tcp/9100
INFO bitterbot_orchestrator::ipc: IPC listening on "/tmp/bitterbot-orchestrator.sock"
INFO bitterbot_orchestrator: Orchestrator daemon running
```

Copy the full peer ID. You'll also see `WARN libp2p_kad::behaviour: Failed to trigger bootstrap: No known peers.` — expected before the DNS record is published; goes away as peers connect.

### 6. Publish to DNS

Compose the multiaddr using the Railway proxy hostname, proxy port, and peer ID:

```
/dns4/<railway-proxy-domain>/tcp/<railway-proxy-port>/p2p/<peer-id>
```

Use `/dns4/` **not** `/ip4/`. Railway's proxy IP rotates; the hostname is stable. libp2p resolves DNS natively.

In Cloudflare (or whichever registrar holds `bitterbot.ai`), open the zone and **add a record**:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name | `_dnsaddr.p2p` *(Cloudflare auto-appends the zone, final: `_dnsaddr.p2p.bitterbot.ai`)* |
| Content | `dnsaddr=/dns4/metro.proxy.rlwy.net/tcp/12838/p2p/12D3KooW...` |
| TTL | `Auto` or `5 min` |
| Proxy status | **DNS only** (grey cloud) — orange cloud proxies HTTP and will mangle multiaddr lookups |

**Append, don't replace.** `_dnsaddr.<zone>` supports multiple TXT records at the same name — one per bootstrap peer. libp2p's DNS resolver reads all of them and tries each in turn. If you're adding a second or third bootnode, create a *new* record alongside the existing ones; don't overwrite.

### 7. Verify from outside Railway

From any machine (including the operator's dev host):

```bash
# Read the TXT records that were just published
node -e "require('dns').resolveTxt('_dnsaddr.p2p.bitterbot.ai', (e,r) => console.log(r))"

# Prove TCP reachability (raw handshake — doesn't test full libp2p)
timeout 8 bash -c '</dev/tcp/metro.proxy.rlwy.net/12838' && echo OK
```

A successful TCP handshake means the proxy is up and port-forwarding correctly. It does **not** prove the libp2p handshake works — for that, start a full Bitterbot gateway elsewhere and watch its orchestrator logs for `peer_connected` events referencing this bootnode's peer ID.

## Architecture

```
Internet → Railway TCP proxy → container :9100 (libp2p)
                               └─ /data/keys/ → Ed25519 identity (persistent volume)

Internal only (not exposed):   127.0.0.1:9847 (HTTP dashboard)
                               /tmp/bitterbot-orchestrator.sock (IPC)
```

The bootnode runs `--relay-mode server`:

- Participates in Kademlia DHT for peer discovery
- Subscribes to the full gossipsub mesh (skills, telemetry, weather, bounties, queries)
- Accepts Circuit Relay v2 reservations from NAT'd edge nodes
- NAT'd peers attempt DCUtR hole-punching; if that fails, traffic relays through transparently

## Running multiple bootnodes

For decentralization, run at least **three** bootnodes across different Railway regions:

| Role | Region suggestion |
|---|---|
| Primary North America | `us-east` |
| Geographic fallback | `us-west` or `eu-west` |
| Redundancy | whichever region the first two aren't in |

Repeat the full deploy flow for each. Each node needs its own volume (so it gets a distinct Ed25519 identity and peer ID), its own TCP proxy, and its own TXT record on `_dnsaddr.p2p.bitterbot.ai`. When all three are live, the TXT record set has three entries, and fresh nodes bootstrapping from DNS will try each in turn until one answers.

## Using a project token

For scripted operation, create a **project-scoped** Railway token:

1. Project → **Settings → Tokens → Create Token**
2. Name it (e.g. `ops-bootnode`)
3. Copy the token — Railway shows it exactly once

Export as `RAILWAY_TOKEN` before running the CLI:

```bash
export RAILWAY_TOKEN=<token>
railway status
railway logs -d -s bootnode -e <env-id>
```

**Scope caveats:**

- ✅ Project tokens can: deploy, read status, tail logs, set/delete environment variables, redeploy, read the deployment list
- ❌ Project tokens **cannot**: create/attach volumes, create TCP proxies, modify source connections, run `railway link`

The dashboard-only steps (source, volume, TCP proxy) are one-time setup, so this split is tolerable.

## Troubleshooting

### Build fails with `feature 'edition2024' is required`
The `time` crate (transitive dep via libp2p) needs Rust ≥ 1.85 for `edition2024`. The Dockerfile pins `rust:1.88-slim-bookworm`. If you bumped it back to 1.82 for any reason, undo that — 1.85 is the floor, 1.88 is known-good.

### Deploy sits in `INITIALIZING` forever with no build logs
The service doesn't have Config Path set. Railway's default RAILPACK builder is silently confused by the repo's Node.js workspace. Set **Settings → Config as Code → Config Path → `deploy/bootnode/railway.toml`** and redeploy.

### Orchestrator crashes with `ParsingError(ParseIntError { kind: InvalidDigit })`
Something is passing `${PORT:-9100}` to `--listen-addr` as a literal string. Railway's `startCommand` in `railway.toml` is passed to the process as raw argv, not through a shell — variable expansion does not happen. Hardcode `9100` in the listen address and let the TCP proxy handle external port mapping.

### Peer ID changes on every deploy
The volume isn't attached. Check:

```bash
railway deployment list -s bootnode -e <env-id> --json | head -30
```

If `volumeMounts: []`, the volume wasn't created or wasn't attached to the service. Re-do step 3.

### `WARN libp2p_kad::behaviour: Failed to trigger bootstrap: No known peers.`
Expected for a brand-new standalone bootnode before any peers have connected. Clears as real edge nodes come online and reach it via DNS or hardcoded multiaddrs. Not an error.

### TCP handshake succeeds but no libp2p peers connect
Raw TCP working doesn't prove the libp2p layer works. Check that the orchestrator's `--http-addr` is `127.0.0.1:9847` not `0.0.0.0:9847` (the dashboard should never be publicly exposed). Verify the peer ID in the DNS record exactly matches `Local peer ID:` in the logs — a typo here is silent and fatal.

## Persistent Keys

The `/data/keys` volume stores the Ed25519 keypair. This is **critical** — the peer ID is derived from the keypair. If you lose the keys, the peer ID changes and you must update every TXT record that references it plus every `bootstrapPeers` entry in gateway configs that hardcode the old multiaddr. Back up the keypair file if you want insurance.

## Resource Usage

- **CPU**: ~1% idle, brief spikes on peer connections and gossipsub activity
- **Memory**: ~20–30 MB steady
- **Disk**: < 1 MB (keypair + minor state)
- **Network**: minimal in normal operation; bursts during DHT walks and skill propagation

---

## Releasing new orchestrator binaries

End users get the orchestrator via a `postinstall` script that downloads prebuilt binaries from GitHub Releases, so they never need a Rust toolchain. Releases are triggered by pushing a version tag. Workflow lives at `.github/workflows/orchestrator-release.yml`.

### 1. Bump the version

The source of truth for the orchestrator version is `orchestrator/Cargo.toml`:

```toml
[package]
name = "bitterbot-orchestrator"
version = "0.1.1"   # ← bump this
```

No second manifest, no duplicate `VERSION` file. The postinstall script reads `Cargo.toml` directly with a regex, and the CI workflow derives the tag from the pushed ref.

### 2. Tag and push

```bash
git add orchestrator/Cargo.toml
git commit -m "orchestrator: bump to 0.1.1"
git tag orchestrator-v0.1.1
git push origin main
git push origin orchestrator-v0.1.1
```

The tag push triggers the release workflow. It builds on 5 native runners in parallel:

| Target | Runner |
|---|---|
| `linux-x64` | `ubuntu-latest` |
| `linux-arm64` | `ubuntu-22.04-arm` (native, no cross-compile) |
| `darwin-x64` | `macos-13` |
| `darwin-arm64` | `macos-14` (native Apple Silicon) |
| `win32-x64` | `windows-latest` |

Each job installs Rust 1.88.0, restores the cargo cache via `Swatinem/rust-cache`, builds with `RUSTFLAGS="-C strip=symbols"`, and uploads its binary as a workflow artifact. A final `release` job flattens all artifacts, generates a `checksums.txt` via `sha256sum`, and publishes a GitHub Release keyed by the tag with the binaries plus the checksums file attached.

First-time cold build is ~15–20 min end to end because of libp2p's dep tree. Subsequent builds hit the cache and land in 3–5 min.

### 3. What end users see

On `pnpm install`, the root `postinstall` script runs `node scripts/fetch-orchestrator.mjs`, which:

1. Reads the target version from `orchestrator/Cargo.toml`
2. Detects `process.platform` + `process.arch` → target string
3. Fetches `checksums.txt` from `https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v<version>/checksums.txt`
4. Fetches the matching binary from the same release
5. Verifies SHA-256 against the checksums manifest
6. Drops the verified binary at `~/.bitterbot/bin/bitterbot-orchestrator[.exe]`
7. Idempotent: skips the download if the existing binary's hash already matches

The script is **non-fatal**. Any failure (offline, release not yet published, flaky network, hash mismatch) logs a clear `[orchestrator-fetch]` warning and exits 0, so `pnpm install` always succeeds. If the binary really is missing when the gateway starts, the existing Tier 0 error path in `OrchestratorBridge.resolveBinary()` surfaces a clear remediation message at that point.

### 4. Developer override

Binary resolution order at gateway start (`src/infra/orchestrator-bridge.ts:resolveBinary`):

1. `p2p.orchestratorBinary` in the gateway config — explicit operator override
2. `orchestrator/target/release/bitterbot-orchestrator` — local cargo release build
3. `orchestrator/target/debug/bitterbot-orchestrator` — local cargo debug build (with a warning)
4. `~/.bitterbot/bin/bitterbot-orchestrator` — the postinstall-downloaded prebuilt

**Developer iteration always wins.** If you have a local cargo build, it takes precedence over the downloaded prebuilt — no risk of a stale prebuilt silently shadowing your in-progress changes. Run `cargo build --release --manifest-path orchestrator/Cargo.toml` and your new binary is what the gateway spawns next start.

To force-use the prebuilt for testing, either delete your local target/ or set `p2p.orchestratorBinary` explicitly in your gateway config.

### 5. Manual workflow dispatch

The release workflow also accepts a manual trigger via GitHub's "Run workflow" button with a `tag` input. Useful for re-running a failed build against an existing tag without bumping and re-tagging.

### 6. Skipping the postinstall download

For airgapped installs or CI environments where you don't want the network call, set `BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD=1` before `pnpm install`. The script will log the skip and exit 0. The orchestrator release workflow itself also auto-detects and skips to avoid self-referential downloads during its own build.
