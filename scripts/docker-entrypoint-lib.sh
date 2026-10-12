# Helpers for scripts/docker-entrypoint.sh (PLAN-56 Phase 2). POSIX sh, no
# side effects when sourced, so src/infra/docker-entrypoint.test.ts can run
# the decisions against fixtures without root or Docker.

# True (0) when the uid map is the identity map `0 0 4294967295`, i.e. the
# container's root is the host's root. Under rootless Docker/Podman (or any
# user namespace) container root is the unprivileged host user, and chowning
# would hand that user's own files to a subordinate uid. A missing map (no
# user-namespace support) counts as identity.
bb_uid_map_is_identity() {
  map_file=${1:-/proc/self/uid_map}
  [ -r "$map_file" ] || return 0
  lines=0
  identity=1
  while read -r inside outside count; do
    [ -n "$inside" ] || continue
    lines=$((lines + 1))
    if [ "$inside" != "0" ] || [ "$outside" != "0" ] || [ "$count" != "4294967295" ]; then
      identity=0
    fi
  done <"$map_file"
  [ "$lines" -eq 1 ] && [ "$identity" -eq 1 ]
}

# Mount points strictly below $1, from a mountinfo file (default: our own).
bb_mounts_below() {
  awk -v d="$1/" 'index($5, d) == 1 { print $5 }' "${2:-/proc/self/mountinfo}" 2>/dev/null || true
}

# Hand ROOT-OWNED entries under $1 to $2 (default node:node). Only uid 0 is
# touched (files of any other uid, e.g. your own, are left alone); never
# leaves the filesystem (-xdev) and never descends into another mount below
# $1 (each managed mount is healed by its own call). -h changes a symlink,
# not its target. A failure (read-only, NFS root_squash, Windows bind mount)
# warns and returns 0 so the container still starts.
bb_heal_root_owned() {
  dir=$1
  owner=${2:-node:node}
  mountinfo=${3:-/proc/self/mountinfo}
  match_uid=${4:-0}
  [ -d "$dir" ] || return 0
  set -- "$dir" -xdev
  for m in $(bb_mounts_below "$dir" "$mountinfo"); do
    set -- "$@" -path "$m" -prune -o
  done
  set -- "$@" -uid "$match_uid" -exec chown -h "$owner" {} +
  if ! find "$@" 2>/dev/null; then
    echo "bitterbot-entrypoint: could not hand some root-owned files in $dir to $owner (read-only, NFS root_squash or a Windows bind mount?); continuing." >&2
  fi
  return 0
}
