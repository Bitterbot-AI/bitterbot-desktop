#!/bin/bash
# Fleet updater (Stage 3 of the circles transport plan): converge this relay
# onto the newest orchestrator-v* RELEASE binary. Until 2026-08-14 the fleet
# had NO update path at all — droplets ran whatever `main` was at their first
# boot (April, pre-circle-topic), which is how the mesh path stayed dead.
#
# Checksummed, atomic, restart-only-on-change. Safe to run on a schedule
# (bitterbot-orchestrator-update.timer, daily + randomized) and by hand.
set -euo pipefail

REPO="Bitterbot-AI/bitterbot-desktop"
BIN=/usr/local/bin/bitterbot-orchestrator
ASSET=bitterbot-orchestrator-linux-x64

# Newest orchestrator-v* tag (the repo also publishes app releases; filter).
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
  jq -r '[.[] | select(.tag_name | startswith("orchestrator-v")) | .tag_name][0]')
if [ -z "$TAG" ] || [ "$TAG" = "null" ]; then
  echo "no orchestrator release found" >&2
  exit 1
fi

BASE="https://github.com/$REPO/releases/download/$TAG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"
EXPECTED=$(awk -v a="$ASSET" '$2 == a || $2 == "*" a { print $1 }' "$TMP/checksums.txt")
if [ -z "$EXPECTED" ]; then
  echo "no checksum for $ASSET in $TAG" >&2
  exit 1
fi
ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{ print $1 }')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "checksum mismatch for $TAG ($ACTUAL != $EXPECTED)" >&2
  exit 1
fi

if [ -f "$BIN" ] && [ "$(sha256sum "$BIN" | awk '{ print $1 }')" = "$EXPECTED" ]; then
  echo "already at $TAG"
  exit 0
fi

install -m 755 "$TMP/$ASSET" "$BIN.new"
mv -f "$BIN.new" "$BIN"
systemctl restart bitterbot-orchestrator
echo "updated to $TAG"
