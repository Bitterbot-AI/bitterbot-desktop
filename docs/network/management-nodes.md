---
title: "Management Nodes"
summary: "Identity model, setup, and signing flow for management-tier P2P nodes"
---

# Management Nodes

Management nodes have network-wide authority: they issue signed bans, publish weather/bounty broadcasts, run census intervals, and surface anomaly alerts to operators. Edge nodes trust management nodes via a **genesis trust list** — a file of base64 Ed25519 pubkeys distributed out-of-band.

## Identity Model

**One key per node, owned by the orchestrator.** The Rust orchestrator's libp2p Ed25519 keypair (`keys/node.{key,pub}`) serves three roles with a single identity:

1. **libp2p peer identity** — the key Noise handshakes with peers and derives the PeerId
2. **Management broadcast signer** — signs bans, bounties, weather envelopes over Gossipsub
3. **Trust list entry** — the pubkey placed in genesis trust list files

The TypeScript gateway does not hold the private key. `ManagementKeyAuth` (`src/memory/management-key-auth.ts`) fetches the orchestrator's pubkey over IPC at startup, verifies it against the trust list, and exposes it as a read-only identity handle. All signing flows through the orchestrator via IPC (`sign_as_management`, `propagate_ban`, etc.).

## Setup

### 1. Build the orchestrator

```bash
cargo build --release --manifest-path orchestrator/Cargo.toml
```

### 2. Start it once to generate a keypair

```bash
./orchestrator/target/release/bitterbot-orchestrator --key-dir ./keys
# Ctrl+C after "Local peer ID: ..." appears
```

Creates `keys/node.key` (32-byte Ed25519 seed) and `keys/node.pub` (32-byte raw pubkey).

### 3. Get your pubkey

```bash
npx tsx scripts/management-keygen.ts
# or:
npx tsx scripts/management-keygen.ts --trust-list-file ~/.bitterbot/genesis-trust.txt
```

This prints the base64-encoded pubkey and (optionally) appends it to the trust list.

### 4. Distribute the trust list

Every node that should trust your management node must have your pubkey in its genesis trust list. Typical distribution:

- **Self-managed network:** commit a `genesis-trust.txt` to your ops repo; operators place it at `~/.bitterbot/genesis-trust.txt`
- **Public network:** publish via a signed DNS TXT record or a pinned GitHub release

### 5. Configure the node as management tier

Edit `~/.bitterbot/bitterbot.json` (or equivalent config):

```json
{
  "p2p": {
    "enabled": true,
    "nodeTier": "management",
    "genesisTrustListPath": "/home/you/.bitterbot/genesis-trust.txt"
  }
}
```

Or inline:

```json
{
  "p2p": {
    "nodeTier": "management",
    "genesisTrustList": ["2BLU9jCligwwhECA91nrOyTfcJ5B5TI1C6UU8b/abQA="]
  }
}
```

### 6. Restart the gateway

```bash
pnpm gateway:watch
```

On startup the orchestrator will:

1. Load its keypair from `keys/`
2. Verify its pubkey is in the trust list (aborts startup if not)
3. Activate management-tier behaviors: census collection, anomaly detection, relay-server mode
4. Accept `sign_as_management`, `propagate_ban`, etc. IPC commands from the gateway

The gateway's `ManagementKeyAuth.init` will fetch the pubkey over IPC, re-verify against the trust list, and start `ManagementNodeService`.

## Verification

```bash
bitterbot doctor
```

Look for the P2P Network section — management-tier nodes report additional status (census, anomaly alert counts). In the Control UI, the management dashboard populates with peer counts and tier distribution within ~60 seconds (the census interval).

## Migration from the old env-var model

Older builds used a `BITTERBOT_MANAGEMENT_KEY` env var and a separate TypeScript-side Ed25519 keypair that was distinct from the orchestrator's libp2p key. That model has been unified.

If you have an existing management node:

1. Note your orchestrator's pubkey: `npx tsx scripts/management-keygen.ts`
2. Ensure that pubkey is in your genesis trust list (the old TS-side pubkey is no longer the management identity)
3. Remove `BITTERBOT_MANAGEMENT_KEY` from your environment (it is ignored now)
4. The previously-trusted TS-side pubkey entry in your trust list can be removed once all peers have updated

## Key Rotation

To rotate a management node's key:

1. Stop the gateway
2. Delete `keys/node.key` and `keys/node.pub`
3. Start the orchestrator once (generates a new keypair)
4. Add the new pubkey to all trust lists; remove the old one
5. Restart the gateway

Rotation is a coordinated operation — peers that haven't received the updated trust list will reject broadcasts from the rotated key until they update.

## Security Notes

- `keys/node.key` is the management node's only secret. Back it up securely. Anyone with this file can impersonate the node.
- Set restrictive permissions: `chmod 600 keys/node.key`
- Do not commit `keys/` to version control (ensure it is in `.gitignore`)
- Trust list distribution is the critical trust anchor. Use out-of-band verification (signed commits, pinned releases, DNS TXT with DNSSEC) rather than fetching over plaintext HTTP
