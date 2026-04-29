#!/usr/bin/env bash
# Aggregate adoption + health metrics across the relay fleet.
#
# Each relay exposes its orchestrator HTTP API on 127.0.0.1:9847 (loopback
# only; tightened by the systemd unit). This script SSHes into every
# relay listed in `terraform output -json relay_ipv4`, pulls the JSON
# from /api/stats and /api/bootstrap/census, then aggregates locally to
# produce a single network-wide view: lifetime unique peers, current
# concurrent peers, hole-punch success rate, NAT status, top peers by
# contribution, etc.
#
# Usage:
#   ./scripts/fleet-stats.sh                # human-readable summary
#   ./scripts/fleet-stats.sh --json         # raw aggregated JSON
#   ./scripts/fleet-stats.sh --csv          # CSV time-series for piping
#
# Optional env:
#   TERRAFORM_DIR  Path to relay-fleet TF module (default: parent dir).
#   SSH_KEY        Path to ssh key (default: ~/.ssh/bitterbot-relay).
#   SSH_USER       SSH user (default: root).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${TERRAFORM_DIR:-$(dirname "$SCRIPT_DIR")}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bitterbot-relay}"
SSH_USER="${SSH_USER:-root}"
MODE="${1:-summary}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt install jq / brew install jq)" >&2
  exit 1
fi

# 1. Pull the relay IP map from Terraform state.
cd "$TERRAFORM_DIR"
RELAYS_JSON=$(terraform output -json relay_ipv4 2>/dev/null || echo '{}')
if [ "$RELAYS_JSON" = "{}" ]; then
  echo "ERROR: no relay IPs found. Run 'terraform apply' in $TERRAFORM_DIR first." >&2
  exit 1
fi

# 2. SSH to each relay and pull stats + census in parallel. Captured to
#    /tmp so we can aggregate without holding multiple SSH sessions open.
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

fetch_relay() {
  local region="$1" ip="$2"
  ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=10 \
      -o BatchMode=yes \
      -o LogLevel=ERROR \
      "$SSH_USER@$ip" \
      "curl -fsS http://127.0.0.1:9847/api/stats; echo '<<SEP>>'; curl -fsS http://127.0.0.1:9847/api/bootstrap/census" \
      > "$TMPDIR/$region.raw" 2>"$TMPDIR/$region.err" \
      && echo "$region $ip ok" \
      || echo "$region $ip ERR ($(cat $TMPDIR/$region.err 2>/dev/null | head -1))"
}

while read -r region; do
  ip=$(echo "$RELAYS_JSON" | jq -r ".[\"$region\"]")
  fetch_relay "$region" "$ip" &
done < <(echo "$RELAYS_JSON" | jq -r 'keys[]')

# Wait for all background jobs.
wait
[ "$MODE" = "summary" ] && echo

# 3. Parse each relay's response into stats.json + census.json.
for raw in "$TMPDIR"/*.raw; do
  region=$(basename "$raw" .raw)
  if [ ! -s "$raw" ]; then
    continue
  fi
  awk 'BEGIN{out="stats"} /^<<SEP>>$/{out="census"; next} {print > "'$TMPDIR/$region.'"out".json"}' "$raw"
done

# 4. Aggregate.
#    - Lifetime unique peers: union of all relays' bootstrap-census peer_pubkey.
#    - Active concurrent: max across relays (each sees a different slice; the
#      true concurrent count is bounded above by max-per-relay since most
#      peers connect to multiple relays).
#    - Per-relay tear: stats per relay for ops debugging.

ACTIVE_PEERS_TXT=$(for f in "$TMPDIR"/*.census.json; do
  jq -r '.peers[]?.peer_pubkey // empty' "$f" 2>/dev/null
done | sort -u)
LIFETIME_UNIQUE=$(echo -n "$ACTIVE_PEERS_TXT" | grep -c '' || true)

declare -A REGION_STATS
TOTAL_CONNECTED=0
PEAK_CONCURRENT=0
TOTAL_HP_SUCCEEDED=0
TOTAL_HP_FAILED=0
TOTAL_RELAY_RESERVATIONS=0
TOTAL_RELAY_CIRCUITS=0

for stats_json in "$TMPDIR"/*.stats.json; do
  region=$(basename "$stats_json" .stats.json)
  if [ ! -s "$stats_json" ]; then
    REGION_STATS[$region]="UNREACHABLE"
    continue
  fi
  cp_count=$(jq -r '.connected_peers // 0' "$stats_json")
  peak=$(jq -r '.peak_concurrent_peers // 0' "$stats_json")
  uptime_secs=$(jq -r '.uptime_secs // 0' "$stats_json")
  hp_ok=$(jq -r '.hole_punches_succeeded // 0' "$stats_json")
  hp_no=$(jq -r '.hole_punches_failed // 0' "$stats_json")
  relay_res=$(jq -r '.relay_reservations_accepted // 0' "$stats_json")
  relay_circ=$(jq -r '.relay_circuits_established // 0' "$stats_json")
  nat=$(jq -r '.nat_status // "unknown"' "$stats_json")
  peer_id=$(jq -r '.peer_id // "?"' "$stats_json")

  REGION_STATS[$region]="connected=$cp_count peak=$peak nat=$nat hp_ok=$hp_ok hp_no=$hp_no relay_res=$relay_res circ=$relay_circ uptime_h=$((uptime_secs/3600)) peer_id=${peer_id:0:18}…"

  TOTAL_CONNECTED=$((TOTAL_CONNECTED + cp_count))
  if [ "$peak" -gt "$PEAK_CONCURRENT" ]; then PEAK_CONCURRENT=$peak; fi
  TOTAL_HP_SUCCEEDED=$((TOTAL_HP_SUCCEEDED + hp_ok))
  TOTAL_HP_FAILED=$((TOTAL_HP_FAILED + hp_no))
  TOTAL_RELAY_RESERVATIONS=$((TOTAL_RELAY_RESERVATIONS + relay_res))
  TOTAL_RELAY_CIRCUITS=$((TOTAL_RELAY_CIRCUITS + relay_circ))
done

HP_RATE="n/a"
if [ "$((TOTAL_HP_SUCCEEDED + TOTAL_HP_FAILED))" -gt 0 ]; then
  HP_RATE=$(awk "BEGIN{printf \"%.1f%%\", 100*$TOTAL_HP_SUCCEEDED/($TOTAL_HP_SUCCEEDED+$TOTAL_HP_FAILED)}")
fi

# 5. Render.
case "$MODE" in
  --json)
    jq -n \
      --argjson lifetime "$LIFETIME_UNIQUE" \
      --argjson connected "$TOTAL_CONNECTED" \
      --argjson peak "$PEAK_CONCURRENT" \
      --argjson hp_ok "$TOTAL_HP_SUCCEEDED" \
      --argjson hp_no "$TOTAL_HP_FAILED" \
      --argjson reservations "$TOTAL_RELAY_RESERVATIONS" \
      --argjson circuits "$TOTAL_RELAY_CIRCUITS" \
      '{
        lifetime_unique_peers: $lifetime,
        sum_connected_across_relays: $connected,
        peak_concurrent_per_relay_max: $peak,
        hole_punches: {succeeded: $hp_ok, failed: $hp_no},
        relay_reservations_accepted: $reservations,
        relay_circuits_established: $circuits
      }'
    ;;
  --csv)
    echo "timestamp,region,connected,peak,nat,hp_ok,hp_no,uptime_h,peer_id"
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    for region in "${!REGION_STATS[@]}"; do
      s="${REGION_STATS[$region]}"
      [ "$s" = "UNREACHABLE" ] && continue
      cp=$(echo "$s" | grep -oE 'connected=[0-9]+' | cut -d= -f2)
      pk=$(echo "$s" | grep -oE 'peak=[0-9]+' | cut -d= -f2)
      nat=$(echo "$s" | grep -oE 'nat=[a-z]+' | cut -d= -f2)
      ok=$(echo "$s" | grep -oE 'hp_ok=[0-9]+' | cut -d= -f2)
      no=$(echo "$s" | grep -oE 'hp_no=[0-9]+' | cut -d= -f2)
      uh=$(echo "$s" | grep -oE 'uptime_h=[0-9]+' | cut -d= -f2)
      pi=$(echo "$s" | grep -oE 'peer_id=[A-Za-z0-9…]+' | cut -d= -f2)
      echo "$ts,$region,$cp,$pk,$nat,$ok,$no,$uh,$pi"
    done
    ;;
  *)
    cat <<EOF
Bitterbot relay fleet — $(date -u +%Y-%m-%dT%H:%M:%SZ)
═══════════════════════════════════════════════════════════════════════
Network-wide
  Lifetime unique peers (deduped across fleet) : $LIFETIME_UNIQUE
  Sum of connected peers across all relays     : $TOTAL_CONNECTED
  Peak concurrent (any single relay, all-time) : $PEAK_CONCURRENT
  Hole-punch success rate                       : $HP_RATE  ($TOTAL_HP_SUCCEEDED ok / $TOTAL_HP_FAILED failed)
  Relay reservations served                     : $TOTAL_RELAY_RESERVATIONS
  Relay circuits established                    : $TOTAL_RELAY_CIRCUITS

Per relay
EOF
    for region in "${!REGION_STATS[@]}"; do
      printf "  %-6s %s\n" "$region" "${REGION_STATS[$region]}"
    done

    echo
    echo "Note: 'sum of connected' overcounts users who are connected to >1"
    echo "relay. 'lifetime unique' is the true deduped count across all relays."
    echo "'peak concurrent per-relay' is the high-water mark for any one relay,"
    echo "useful for capacity planning."
    ;;
esac
