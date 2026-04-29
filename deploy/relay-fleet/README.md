# Bitterbot relay fleet

Always-on libp2p relay + bootstrap fleet. Three DigitalOcean droplets in
NYC1 / FRA1 / SGP1 running the orchestrator daemon as `--node-tier
management --relay-mode server --bootnode-mode`. Each node serves as both
a Kademlia bootstrap entry and a Circuit Relay v2 hop for NAT'd edge
nodes.

Cost: ~$18/mo total ($6/droplet × 3). New DigitalOcean accounts get $200
credit valid 60 days, so the first three months are essentially free.

## Why this exists

The Railway-hosted bootnode at `metro.proxy.rlwy.net:12838` is a single
point of failure and Railway's TCP proxy strips libp2p connection
semantics (AutoNAT v2 servers can't dial back through it). The April 23
outage that took the network from 19 peers to 1 was a Railway-side
collapse with no code change of ours.

This fleet provides:

- Three real public peers, each on a clean L3 network with no proxy
- Geographic diversity (3 continents) so DCUtR latency stays low for any
  user
- Genuine Circuit Relay v2 servers that NAT'd edge nodes can reserve
  slots on
- A stable dnsaddr seed (`_dnsaddr.p2p.bitterbot.ai`) so adding/removing
  relays doesn't require a client release

## Prerequisites

1. **DigitalOcean account + Personal Access Token.** Sign up at
   `https://cloud.digitalocean.com/`, then generate a Read+Write token at
   `https://cloud.digitalocean.com/account/api/tokens`.
2. **Cloudflare API token + Zone ID for bitterbot.ai.** Cloudflare
   dashboard → My Profile → API Tokens → "Edit Zone DNS" template, scoped
   to the bitterbot.ai zone. Zone ID is on the bitterbot.ai overview page.
3. **`doctl`** (only needed if you want to inspect droplets manually;
   Terraform doesn't require it). `brew install doctl` /
   `snap install doctl` / `winget install DigitalOcean.doctl`.
4. **`terraform`** ≥ 1.5 (already installed in this repo's WSL env).
5. **An SSH key for fleet management** — generate fresh if you don't
   already have one:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/bitterbot-relay -C bitterbot-relay-fleet -N ""
   ```

## Provision

```bash
cd deploy/relay-fleet

export DIGITALOCEAN_TOKEN=dop_v1_...
terraform init
terraform apply -auto-approve
```

The `terraform apply` step finishes in ~30 seconds (just creating
droplets), but cloud-init takes another **10-15 minutes** to compile the
orchestrator from source on each droplet. Watch one of them with:

```bash
ip=$(terraform output -json relay_ipv4 | jq -r '.nyc1')
ssh -i ~/.ssh/bitterbot-relay root@$ip 'tail -f /var/log/bitterbot-bootstrap.log'
```

The script prints `==> bitterbot-relay-bootstrap finished` and the peer
ID when it's done.

## Publish dnsaddr

Once cloud-init has finished on all three droplets:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
export BASE_DOMAIN=p2p.bitterbot.ai

./scripts/update-dnsaddr.sh
```

This SSHes into each droplet, reads `/var/lib/bitterbot/peer-id.txt`,
constructs `dnsaddr=/ip4/<ip>/tcp/9100/p2p/<peer-id>`, and writes it as a
TXT record under `_dnsaddr.p2p.bitterbot.ai`. Verify:

```bash
dig +short TXT _dnsaddr.p2p.bitterbot.ai
```

You should see three records, one per relay.

## Add to client default config

Edit `src/config/defaults.ts` (or wherever the default p2p.bootstrap list
lives) and add:

```jsonc
{
  "p2p": {
    "bootstrap": [
      // Cloudflare-hosted seed: resolves to all currently-published relays
      "/dnsaddr/p2p.bitterbot.ai",
      // Hardcoded fallback: the Railway bootnode stays in the list as a
      // belt-and-braces backup for the case where DNS is broken or the
      // dnsaddr resolution misbehaves.
      "/dns4/metro.proxy.rlwy.net/tcp/12838/p2p/12D3KooWCwCCFMHCVv8eXZnAGMTUjTDPPePfYRTJ1fZvRpqcQXKt",
    ],
  },
}
```

Ship in the next desktop release. From that point on, any client (new or
existing) bootstraps off whatever relays are currently in the dnsaddr TXT
record — no client release is needed to rotate or add nodes.

## Day-2 ops

### Replace a relay

```bash
# Reprovision the droplet (Terraform will rebuild it):
terraform apply -replace="digitalocean_droplet.relay[\"fra1\"]" -auto-approve
# Wait for cloud-init, then:
./scripts/update-dnsaddr.sh
```

### Add a fourth region

Edit `main.tf`'s `regions` default, then `terraform apply`.

### SSH into a node

```bash
ip=$(terraform output -json relay_ipv4 | jq -r '.nyc1')
ssh -i ~/.ssh/bitterbot-relay root@$ip
```

### Tear it all down

```bash
terraform destroy -auto-approve
```

The dnsaddr records will become stale; either run
`./scripts/update-dnsaddr.sh` against an empty Terraform state (which
deletes them all) or remove them by hand from Cloudflare.

## Resource shape per node

- Droplet: `s-1vcpu-1gb`, Debian 12, IPv4 + IPv6
- Disk: 25 GB SSD (orchestrator binary + `/data/keys` + journald)
- 2 GB swap added during cloud-init so the cargo release build doesn't
  OOM on a 1 GB box (libp2p + tokio + ed25519-dalek peak at ~2.5 GB)
- Firewall: SSH 22, libp2p TCP 9100, future WSS 443, future QUIC UDP 9101
- systemd unit: `bitterbot-orchestrator.service` (auto-restarts on
  failure, persistent peer key in `/var/lib/bitterbot/`)
- Unattended security upgrades enabled (no auto-reboot, so a kernel
  update won't surprise-restart the relay)

## What this fleet does NOT do (yet)

- **WebSocket-secure (WSS) on 443.** Reserved firewall port; orchestrator
  doesn't yet listen on WSS. Adding it requires acme/autotls + a real
  certificate. Tracked separately.
- **QUIC on UDP 9101.** Reserved firewall port; orchestrator doesn't yet
  expose QUIC transport. Same status.
- **Auto-add new relay pubkeys to the client genesis trust list.**
  Currently each new relay's pubkey gets recorded in the Terraform output
  but you must commit it to `~/.bitterbot/genesis-trust.txt` (or wherever
  the client looks) by hand so the management-tier startup check passes
  for these nodes when they're seen by clients. Future: serve the trust
  list from a versioned URL the orchestrator fetches at startup.

## Troubleshooting

- **cloud-init seems stuck.** Check `tail -f /var/log/cloud-init-output.log`
  on the droplet. Almost always it's the Rust build still running. Watch
  `htop` to confirm cargo is making progress.
- **Service won't start, exits with "pubkey not in genesis trust list".**
  The cloud-init step that auto-generates the trust list with the local
  pubkey didn't run cleanly. Re-run by hand:
  ```bash
  ssh root@<ip> 'sudo bash /usr/local/sbin/bitterbot-relay-bootstrap.sh'
  ```
- **Peer ID file empty.** The systemd unit hasn't started yet, or the
  log line wasn't matched. Check `journalctl -u bitterbot-orchestrator
-n 50` and look for `Local peer ID: 12D3KooW...`.

## Source-of-truth

- Provider choice rationale: `memory/project_relay_fleet.md`
- Why this isn't on Hetzner / OVH / Equinix Metal: same memory, "Why
  not" section
- Ground-truth on what management/edge tier actually mean in the
  protocol: `memory/project_relay_fleet.md` (the audit corrections
  section)
