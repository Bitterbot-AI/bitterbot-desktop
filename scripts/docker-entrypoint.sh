#!/bin/sh
# Entrypoint of the Bitterbot image (PLAN-56 Phase 2).
#
# As the image's default user (`node`) it simply runs the command. The
# zero-edit docker-compose.yml starts it as root, because Docker creates a
# missing bind-mount folder (./bitterbot-data) owned by root, which `node`
# could not write. As root it:
#   1. hands ROOT-OWNED entries of the data folder and the workspace to
#      `node`, on every start (this also heals files left by a root
#      `docker compose exec`); entries owned by any other uid, and other
#      mounts below the data folder, are never touched;
#   2. drops to `node` (uid 1000) with no-new-privs, then runs the command.
# Under rootless Docker/Podman (a user namespace) container root IS the
# unprivileged host user: nothing is chowned, and it stays that user unless
# `node` can already write the data folder.
set -eu

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# `docker run -u 0` without -e HOME gets HOME=/root; the app's data lives
# under /home/node regardless of who starts it.
HOME=/home/node
export HOME
DATA_DIR="$HOME/.bitterbot"
WORKSPACE_DIR="$DATA_DIR/workspace"
. "$(dirname "$0")/docker-entrypoint-lib.sh"

mkdir -p "$DATA_DIR" 2>/dev/null || true

drop() {
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- "$@"
}

if ! bb_uid_map_is_identity; then
  if setpriv --reuid=node --regid=node --init-groups -- test -w "$DATA_DIR" 2>/dev/null; then
    echo "bitterbot-entrypoint: user namespace (rootless Docker/Podman) detected; not changing file ownership, running as node." >&2
    drop "$@"
  fi
  echo "bitterbot-entrypoint: user namespace (rootless Docker/Podman) detected; not changing file ownership, running as the container's root, which is your unprivileged host user." >&2
  exec "$@"
fi

bb_heal_root_owned "$DATA_DIR"
bb_heal_root_owned "$WORKSPACE_DIR"
drop "$@"
