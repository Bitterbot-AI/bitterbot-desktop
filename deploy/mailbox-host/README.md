# Circles mailbox host (DigitalOcean)

PLAN-36 Phase 1. One small DO droplet running the standalone circles mailbox
host (`src/gateway/a2a/mailbox-host.ts`, bundled) behind Caddy TLS at
`mailbox.bitterbot.ai` — the default `circles.mailbox.url`. Separate Terraform
state from the relay fleet; it never touches the backbone relays. The host
stores X25519-sealed ciphertext it cannot read.

## Deploy

```bash
# 1. (re)build the self-contained bundle and commit+push it (cloud-init fetches
#    it from the raw GitHub URL on main).
./build.sh && git add mailbox-host.bundle.mjs && git commit && git push

# 2. provision the droplet (reads DIGITALOCEAN_TOKEN)
export DIGITALOCEAN_TOKEN="$DIGITAL_OCEAN_API_TOKEN"   # from repo .env
terraform init && terraform apply

# 3. point DNS at it (reads CLOUDFLARE_API_TOKEN)
FQDN=mailbox.bitterbot.ai IP="$(terraform output -raw ipv4)" ./dns.sh

# 4. verify (Caddy needs ~1-2 min to get the cert after DNS resolves)
curl https://mailbox.bitterbot.ai/     # -> {"ok":true,"service":"circles-mailbox"}
```

## Teardown

```bash
terraform destroy      # removes the droplet + firewall (DNS record: delete in CF)
```

## Notes

- `s-1vcpu-1gb` (~$6/mo). Sealed blobs, 30-day TTL, per-recipient quota.
- DNS is set `proxied=false` so Caddy gets a real Let's Encrypt cert via HTTP-01.
- To rotate the code: `./build.sh`, commit+push, then on the droplet
  `curl … -o /opt/bitterbot/mailbox-host.bundle.mjs && systemctl restart bitterbot-mailbox`.
