#!/usr/bin/env bash
# Deploy the static guest-JOIN page to an ALREADY-RUNNING mailbox droplet.
# Fresh droplets self-provision the page via cloud-init; this script is for
# pushing an updated page (or first-time enabling it) onto the live box.
#
# It uploads index.html to /var/www/join/i/ and rewrites the Caddyfile to serve
# both the mailbox reverse-proxy and the join file_server, then reloads Caddy.
#
# Env:
#   DROPLET_IP    (required)  public IPv4 of the mailbox droplet
#   MAILBOX_FQDN  (optional)  default mailbox.bitterbot.ai
#   JOIN_FQDN     (optional)  default join.bitterbot.ai
#   SSH_USER      (optional)  default root
#   SSH_KEY       (optional)  path to the private key (e.g. the relay-fleet key);
#                             omit to use the agent/default key
set -euo pipefail
: "${DROPLET_IP:?DROPLET_IP is required}"
MAILBOX_FQDN="${MAILBOX_FQDN:-mailbox.bitterbot.ai}"
JOIN_FQDN="${JOIN_FQDN:-join.bitterbot.ai}"
SSH_USER="${SSH_USER:-root}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY_OPT=""
[ -n "${SSH_KEY:-}" ] && KEY_OPT="-i ${SSH_KEY}"
SSH="ssh ${KEY_OPT} -o StrictHostKeyChecking=accept-new ${SSH_USER}@${DROPLET_IP}"

echo "==> uploading guest page to ${DROPLET_IP}"
$SSH "mkdir -p /var/www/join/i"
scp ${KEY_OPT} -o StrictHostKeyChecking=accept-new "${HERE}/index.html" "${SSH_USER}@${DROPLET_IP}:/var/www/join/i/index.html"

echo "==> writing two-site Caddyfile"
$SSH "cat > /etc/caddy/Caddyfile" <<EOF
${MAILBOX_FQDN} {
  reverse_proxy 127.0.0.1:8790
}
${JOIN_FQDN} {
  root * /var/www/join
  file_server
  header /* Referrer-Policy no-referrer
}
EOF

echo "==> reloading Caddy"
$SSH "systemctl reload caddy || systemctl restart caddy"
echo "done. Ensure DNS: ${JOIN_FQDN} -> ${DROPLET_IP} (see ../mailbox-host/dns.sh)"
