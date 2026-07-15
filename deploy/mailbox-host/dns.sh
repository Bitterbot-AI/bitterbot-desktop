#!/usr/bin/env bash
# Set the A record for the mailbox host via the Cloudflare API (mirrors the
# relay fleet's curl-based DNS). Idempotent upsert.
#
# Env:
#   CLOUDFLARE_API_TOKEN   (required)  Edit Zone DNS scope on bitterbot.ai
#   CLOUDFLARE_ZONE_ID     (optional)  looked up from the base domain if unset
#   FQDN                   (required)  e.g. mailbox.bitterbot.ai
#   IP                     (required)  droplet public IPv4
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${FQDN:?FQDN is required}"
: "${IP:?IP is required}"

BASE="${FQDN#*.}" # strip leftmost label -> bitterbot.ai
CF="https://api.cloudflare.com/client/v4"
cf() {
  curl -fsSL -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "content-type: application/json" "$@"
}

ZONE_ID="${CLOUDFLARE_ZONE_ID:-$(cf "$CF/zones?name=$BASE" |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')}"

# Delete any existing A records for this name, then create a fresh one.
EXISTING=$(cf "$CF/zones/$ZONE_ID/dns_records?type=A&name=$FQDN" |
  python3 -c 'import sys,json;[print(r["id"]) for r in json.load(sys.stdin)["result"]]')
for id in $EXISTING; do
  cf -X DELETE "$CF/zones/$ZONE_ID/dns_records/$id" >/dev/null
done
cf -X POST "$CF/zones/$ZONE_ID/dns_records" \
  -d "{\"type\":\"A\",\"name\":\"$FQDN\",\"content\":\"$IP\",\"ttl\":120,\"proxied\":false}" >/dev/null
echo "DNS: $FQDN -> $IP (zone $ZONE_ID, proxied=false so Caddy can HTTP-01)"
