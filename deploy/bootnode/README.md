# Bitterbot P2P Bootstrap Node

Lightweight, always-on libp2p node for P2P network bootstrap.
No agent, no gateway, no Node.js — just the Rust orchestrator for DHT peer discovery.

## Deploy to Railway

### 1. Create the service

```bash
# From the repo root
railway login
railway init    # or link to existing project
railway up --service bootnode
```

### 2. Configure networking

In the Railway dashboard:
- Go to **Settings** → **Networking**
- Add a **TCP proxy** on port `9100` (this is the libp2p port)
- Note the public hostname and port Railway assigns (e.g., `roundhouse.proxy.rlwy.net:12345`)

### 3. Get the peer ID

After first deploy, check the logs:
```
Local peer ID: 12D3KooW...
```

Or SSH in and check `/data/keys/`.

### 4. Update DNS

Add (or update) the TXT record in Cloudflare:

| Field | Value |
|-------|-------|
| Type | `TXT` |
| Name | `_dnsaddr.p2p` |
| Content | `dnsaddr=/dns4/roundhouse.proxy.rlwy.net/tcp/12345/p2p/12D3KooW...` |

Note: use `/dns4/` instead of `/ip4/` for Railway since the IP can change — libp2p resolves DNS hostnames natively.

### 5. Verify

```bash
# From any machine
node -e "require('dns').resolveTxt('_dnsaddr.p2p.bitterbot.ai', (e,r) => console.log(r))"
```

## Architecture

```
Internet traffic → Railway TCP proxy (:12345) → bootnode (:9100)
                                                    │
                                                    ├─ libp2p gossipsub (skills, telemetry topics)
                                                    ├─ Kademlia DHT (peer discovery)
                                                    └─ HTTP dashboard (:9847, internal only)
```

The bootnode runs with `--relay-mode server` — it participates in the DHT and gossipsub mesh,
and serves as a **circuit relay** for nodes behind NAT/firewalls. NAT'd edge nodes
automatically reserve relay slots on the bootnode and attempt DCUtR hole-punching for
direct connections. If hole-punching fails, traffic flows through the relay transparently.

## Persistent Keys

The `/data/keys` volume stores the Ed25519 keypair. This is critical — the peer ID
is derived from the keypair. If you lose the keys, the peer ID changes and you'll
need to update DNS.

## Resource Usage

- **CPU**: ~1% idle, spikes on peer connections
- **Memory**: ~20-30MB
- **Disk**: <1MB (just the keypair)
- **Network**: minimal unless many peers are bootstrapping simultaneously
