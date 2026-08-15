#!/bin/bash
# Fleet updater (circles transport plan, hardened 2026-08-15 per the Stage 2-4
# security pass, finding C1/C2/C6). Converge this relay onto the newest SIGNED
# orchestrator release.
#
# Trust chain (fail-closed at every step):
#   1. minisign signature over checksums.txt, verified with an EMBEDDED public
#      key (no key file fetched over the wire) — closes the same-origin /
#      mutable-asset / TLS-MITM vectors. The signed trusted comment is bound to
#      the release tag, so an old signed checksums.txt cannot be replayed under
#      a newer tag.
#   2. sha256 of the binary against the (now-verified) checksums.txt.
#   3. semver floor: never install a version <= the one currently installed
#      (no rollback attack), prereleases excluded, newest by SEMVER not date.
#   4. canary: health-probe after restart; auto-revert to the previous binary
#      on failure.
#
# Safe to run on a schedule and by hand. Requires: curl, jq, minisign,
# sha256sum, flock.
set -euo pipefail

# --install-only: fetch + verify + install the binary but skip the restart and
# health canary. Used at FIRST BOOT, where the service is not yet configured
# (no genesis trust list) so a restart+probe would spuriously fail. The daily
# timer runs the full path (verify → install → restart → canary → auto-revert).
INSTALL_ONLY=0
[ "${1:-}" = "--install-only" ] && INSTALL_ONLY=1

REPO="Bitterbot-AI/bitterbot-desktop"
BIN=/usr/local/bin/bitterbot-orchestrator
ASSET=bitterbot-orchestrator-linux-x64
STATE_DIR=/var/lib/bitterbot
VERSION_MARKER="$STATE_DIR/orchestrator.version"
SERVICE=bitterbot-orchestrator

# --- The fleet signing public key (minisign). PUBLIC by design; committed. ---
# Replace the placeholder with the real key: `minisign -G -W -p relay.pub -s
# relay.key`, then paste the last line of relay.pub here. Until it is real,
# verification fails closed and no update installs.
MINISIGN_PUBKEY="RWQ__REPLACE_WITH_REAL_MINISIGN_PUBLIC_KEY__PLACEHOLDER"

log() { echo "[update-orchestrator] $*"; }
die() { echo "[update-orchestrator] ERROR: $*" >&2; exit 1; }

# Single-instance: the daily timer and a manual run must not race on the fixed
# staging path.
exec 9>"/run/bitterbot-orchestrator-update.lock"
flock -n 9 || die "another update is already running"

command -v minisign >/dev/null || die "minisign not installed (provision it first)"
case "$MINISIGN_PUBKEY" in
  *PLACEHOLDER*) die "signing public key not configured — refusing to install unverified binaries" ;;
esac

# --- 1. Pick the newest NON-PRERELEASE orchestrator-v* tag by SEMVER ----------
# Paginate so a run of desktop-app releases can't push orchestrator releases
# out of the window (C10). GitHub returns by date; we sort by semver ourselves.
tags=""
for page in 1 2 3; do
  chunk=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100&page=$page" |
    jq -r '.[] | select(.prerelease==false) | select(.tag_name|startswith("orchestrator-v")) | .tag_name')
  tags="$tags$chunk"$'\n'
  [ -n "$chunk" ] || break
done
TAG=$(printf '%s\n' "$tags" | grep -E '^orchestrator-v[0-9]+\.[0-9]+\.[0-9]+$' |
  sed 's/^orchestrator-v//' | sort -V | tail -1)
[ -n "$TAG" ] || die "no signed orchestrator release found"
NEW_VER="$TAG"
TAG="orchestrator-v$TAG"

# --- 2. Semver floor: never downgrade (C2) ------------------------------------
CUR_VER=""
[ -f "$VERSION_MARKER" ] && CUR_VER=$(cat "$VERSION_MARKER" 2>/dev/null || true)
if [ -n "$CUR_VER" ]; then
  newest=$(printf '%s\n%s\n' "$CUR_VER" "$NEW_VER" | sort -V | tail -1)
  if [ "$NEW_VER" = "$CUR_VER" ]; then log "already at $TAG"; exit 0; fi
  [ "$newest" = "$NEW_VER" ] || die "refusing downgrade: installed $CUR_VER > candidate $NEW_VER"
fi

BASE="https://github.com/$REPO/releases/download/$TAG"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# --- 3. Fetch + VERIFY SIGNATURE before trusting the checksum -----------------
curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"
curl -fsSL -o "$TMP/checksums.txt.minisig" "$BASE/checksums.txt.minisig"

verify_out=$(minisign -V -P "$MINISIGN_PUBKEY" -m "$TMP/checksums.txt" 2>&1) ||
  die "SIGNATURE INVALID for $TAG checksums — refusing to install"
# Bind the signature to this tag: the signed trusted comment must name it, so a
# validly-signed checksums.txt from a DIFFERENT release cannot be substituted.
echo "$verify_out" | grep -q "$TAG" ||
  die "signature trusted-comment does not name $TAG — possible cross-release replay"

# --- 4. sha256 against the verified checksums ---------------------------------
EXPECTED=$(awk -v a="$ASSET" '$2 == a || $2 == "*" a { print $1 }' "$TMP/checksums.txt" | head -1)
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || die "no valid checksum for $ASSET in $TAG"
ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $TAG"

# --- 5. Install atomically, keep the previous binary for rollback -------------
[ -f "$BIN" ] && cp -f "$BIN" "$BIN.prev"
install -m 755 "$TMP/$ASSET" "$BIN.new"
mv -f "$BIN.new" "$BIN"

if [ "$INSTALL_ONLY" = 1 ]; then
  printf '%s\n' "$NEW_VER" > "$VERSION_MARKER"
  rm -f "$BIN.prev"
  log "installed $TAG (verified signature + checksum, install-only)"
  exit 0
fi

systemctl restart "$SERVICE"

# --- 6. Canary: probe health, auto-revert on failure (C6) ---------------------
healthy=0
for _ in 1 2 3 4 5 6; do
  sleep 5
  if systemctl is-active --quiet "$SERVICE" &&
     journalctl -u "$SERVICE" --since '-40 sec' --no-pager 2>/dev/null | grep -q 'Local peer ID'; then
    healthy=1; break
  fi
done
if [ "$healthy" != 1 ]; then
  if [ -f "$BIN.prev" ]; then
    log "new binary $TAG failed health check — reverting"
    mv -f "$BIN.prev" "$BIN"
    systemctl restart "$SERVICE"
    die "reverted to previous binary after failed $TAG health check"
  fi
  die "new binary $TAG failed health check and no previous binary to revert to"
fi

printf '%s\n' "$NEW_VER" > "$VERSION_MARKER"
rm -f "$BIN.prev"
log "updated to $TAG (verified signature + checksum, health OK)"
