#!/usr/bin/env bash
# Publish (or refresh) the bootstrap dnsaddr seed for the Bitterbot P2P
# network. Reads peer IDs and IPs from `terraform output -json` and writes
# one TXT record per multiaddr under `_dnsaddr.<base_domain>`.
#
# libp2p clients resolving `/dnsaddr/p2p.bitterbot.ai/p2p/...` will look up
# the TXT records and discover every published multiaddr.
#
# Required env:
#   CLOUDFLARE_API_TOKEN  Token with Edit Zone DNS scope on the target zone
#   CLOUDFLARE_ZONE_ID    Zone ID (visible on the Cloudflare Overview page)
#   BASE_DOMAIN           e.g. "p2p.bitterbot.ai" — the parent record we
#                         publish under. Underscored prefix `_dnsaddr.` is
#                         added automatically.
#
# Optional env:
#   TERRAFORM_DIR         Path to the relay-fleet Terraform module
#                         (default: parent dir of this script).
#   DRY_RUN=1             Print the API calls without executing them.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... \
#     BASE_DOMAIN=p2p.bitterbot.ai \
#     ./scripts/update-dnsaddr.sh

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"
: "${BASE_DOMAIN:?BASE_DOMAIN is required (e.g. p2p.bitterbot.ai)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${TERRAFORM_DIR:-$(dirname "$SCRIPT_DIR")}"
DNSADDR_NAME="_dnsaddr.${BASE_DOMAIN}"

echo "==> Reading relay IPs from Terraform state in $TERRAFORM_DIR"
cd "$TERRAFORM_DIR"
RELAY_IPV4_JSON=$(terraform output -json relay_ipv4)

# Compose multiaddrs by SSHing into each droplet to pull the persisted
# peer ID. Skips any droplet whose peer ID file isn't present yet
# (cloud-init still running).
declare -a MULTIADDRS=()
while read -r region; do
  ip=$(echo "$RELAY_IPV4_JSON" | jq -r ".[\"$region\"]")
  if [ -z "$ip" ] || [ "$ip" = "null" ]; then
    echo "warn: no IPv4 for region $region, skipping" >&2
    continue
  fi
  echo "==> $region @ $ip — fetching peer ID"
  # -n is critical: without it, ssh reads from the parent's stdin
  # (the `done < <(...)` feed) and consumes the next loop iteration's
  # region name, silently dropping every relay after the first.
  peer_id=$(ssh -n -i ~/.ssh/bitterbot-relay \
                -o StrictHostKeyChecking=accept-new \
                -o ConnectTimeout=10 \
                -o BatchMode=yes \
                "root@$ip" \
                'cat /var/lib/bitterbot/peer-id.txt 2>/dev/null' || true)
  if [ -z "$peer_id" ]; then
    echo "warn: peer ID not yet persisted on $region (cloud-init still building?). Re-run later." >&2
    continue
  fi
  echo "    peer ID: $peer_id"
  MULTIADDRS+=("/ip4/$ip/tcp/9100/p2p/$peer_id")
  # Future transports — uncomment once the orchestrator listens on these:
  # MULTIADDRS+=("/ip4/$ip/tcp/443/wss/p2p/$peer_id")
  # MULTIADDRS+=("/ip4/$ip/udp/9101/quic-v1/p2p/$peer_id")
done < <(echo "$RELAY_IPV4_JSON" | jq -r 'keys[]')

if [ ${#MULTIADDRS[@]} -eq 0 ]; then
  echo "ERROR: no multiaddrs collected; bailing without touching DNS" >&2
  exit 1
fi

echo
echo "==> Will publish ${#MULTIADDRS[@]} TXT record(s) under $DNSADDR_NAME:"
for addr in "${MULTIADDRS[@]}"; do
  echo "    dnsaddr=$addr"
done
echo

CF_API="https://api.cloudflare.com/client/v4"

# Helper: POST/DELETE/GET with auth header
cf() {
  curl -fsSL \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

# 1. List existing TXT records on the dnsaddr name and delete any that look
#    like ours (start with "dnsaddr="). Other TXT content is left alone.
EXISTING=$(cf "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=TXT&name=$DNSADDR_NAME")
EXISTING_IDS=$(echo "$EXISTING" | jq -r '.result[] | select(.content | startswith("dnsaddr=") or startswith("\"dnsaddr=")) | .id')

if [ -n "$EXISTING_IDS" ]; then
  echo "==> Deleting $(echo "$EXISTING_IDS" | wc -l) stale TXT record(s)"
  for id in $EXISTING_IDS; do
    if [ "${DRY_RUN:-0}" = "1" ]; then
      echo "    DRY: DELETE record $id"
    else
      cf -X DELETE "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" >/dev/null
      echo "    deleted $id"
    fi
  done
fi

# 2. Create one TXT record per multiaddr.
echo "==> Creating ${#MULTIADDRS[@]} new TXT record(s)"
for addr in "${MULTIADDRS[@]}"; do
  payload=$(jq -nc \
    --arg name "$DNSADDR_NAME" \
    --arg content "dnsaddr=$addr" \
    '{type:"TXT", name:$name, content:$content, ttl:300}')
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "    DRY: POST $payload"
  else
    cf -X POST "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
      --data "$payload" \
      | jq -r '"    created " + .result.id + " — " + .result.content'
  fi
done

echo
echo "==> Done. Verify with:"
echo "    dig +short TXT $DNSADDR_NAME"
echo "    or:  curl -s 'https://cloudflare-dns.com/dns-query?name=$DNSADDR_NAME&type=TXT' -H 'accept: application/dns-json' | jq"
